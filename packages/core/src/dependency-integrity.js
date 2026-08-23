/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, readdirSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execa } from "execa";
import { DSH_PATHS, getDSHPath } from "./dsh-utils.js";

const SYSTEM_NAMESPACES = ["@deepseek-ai/", "@dsh-manager/"];
const EXTERNAL_NAMESPACES = ["@linxin666/"];
const CORE_DSH_BUNDLES = [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-web-frontend", "@deepseek-ai/dsh-host-apiproxy",
  "@deepseek-ai/dsh-code-runtime", "@deepseek-ai/dsh-code-runtime-worker-thread",
];

export function isSystemComponent(name) {
  if (!name || typeof name !== "string") return false;
  for (const ns of SYSTEM_NAMESPACES) { if (name.startsWith(ns)) return true; }
  return CORE_DSH_BUNDLES.includes(name);
}

export function isExternalPlugin(name) {
  if (!name || typeof name !== "string") return false;
  for (const ns of EXTERNAL_NAMESPACES) { if (name.startsWith(ns)) return true; }
  return false;
}

export function classifyPackage(name) {
  if (isSystemComponent(name)) return "system";
  if (isExternalPlugin(name)) return "external";
  return "user";
}

function countFiles(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fp = join(dirPath, entry.name);
      if (entry.isDirectory()) count += countFiles(fp);
      else if (entry.isFile()) count++;
    }
  } catch {}
  return count;
}

function getPackageJson(nmRoot, name) {
  try {
    const p = join(nmRoot, name, "package.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch {}
  return null;
}

function getEntryPath(pkg, nmRoot, name) {
  if (!pkg) return null;
  if (pkg.main) {
    const mp = join(nmRoot, name, pkg.main);
    if (existsSync(mp)) return mp;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    // 递归收集 exports 中所有字符串目标（含 "./core" 子路径、条件对象 unwasm/default/import 等）
    const targets = [];
    const collect = (obj) => {
      if (typeof obj === "string") { targets.push(obj); return; }
      if (obj && typeof obj === "object") {
        for (const v of Object.values(obj)) collect(v);
      }
    };
    collect(pkg.exports);
    for (const t of targets) {
      const ep = join(nmRoot, name, t);
      if (existsSync(ep)) return ep;
    }
  }
  const idx = join(nmRoot, name, "index.js");
  if (existsSync(idx)) return idx;
  return null;
}

export async function getGlobalDSHNodeModules() {
  try {
    const dshPath = await getDSHPath();
    if (!dshPath) return null;
    const nm = join(dshPath, "node_modules");
    if (existsSync(nm)) return nm;
    return null;
  } catch { return null; }
}

export function getProfileNodeModules(profile) {
  if (profile === undefined) profile = "web";
  return join(DSH_PATHS.profiles, profile, "node_modules");
}

/**
 * 检查全局 DSH 安装自身的依赖完整性
 *
 * 全局安装（如 E:\npm-global\node_modules\@deepseek-ai\dsh）自身的 node_modules
 * 若缺失依赖（如 js-yaml），会导致 `dsh web` 启动即崩（ERR_MODULE_NOT_FOUND）。
 * 本函数列出 package.json 声明但未安装到位的依赖。
 * @returns {Promise<{valid: boolean, missing: string[]}>}
 */
export async function checkGlobalDSHIntegrity() {
  try {
    const dshPath = await getDSHPath();
    if (!dshPath) return { valid: true, missing: [] };
    const pkgFile = join(dshPath, "package.json");
    if (!existsSync(pkgFile)) return { valid: true, missing: [] };
    const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
    const nmRoot = join(dshPath, "node_modules");
    const missing = Object.keys(deps).filter(d => !existsSync(join(nmRoot, d)));
    return { valid: missing.length === 0, missing };
  } catch {
    return { valid: true, missing: [] };
  }
}

/**
 * 修复全局 DSH 安装自身的缺失依赖
 *
 * 通过在全局 DSH 安装目录内执行 `npm install` 恢复缺失模块
 * （npm 全局包被错误删除/中断后 node_modules 不完整时使用）。
 * @returns {Promise<{fixed: string[], failed: string[], summary: string}>}
 */
export async function repairGlobalDSHInstall() {
  const { valid, missing } = await checkGlobalDSHIntegrity();
  if (valid) {
    return { fixed: [], failed: [], summary: "全局 DSH 依赖完整，无需修复" };
  }
  try {
    const dshPath = await getDSHPath();
    await execa("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dshPath,
      timeout: 180_000,
      reject: false,
      windowsHide: true,
    });
    const after = await checkGlobalDSHIntegrity();
    const stillMissing = new Set(after.missing);
    return {
      fixed: missing.filter(d => !stillMissing.has(d)),
      failed: after.missing,
      summary: after.valid
        ? "全局 DSH 依赖已全部修复"
        : `仍有 ${after.missing.length} 个依赖缺失: ${after.missing.join(", ")}`,
    };
  } catch (error) {
    return { fixed: [], failed: missing, summary: "全局 DSH 依赖修复失败: " + (error.message || error) };
  }
}

/**
 * 判断包是否已完整安装（目录存在且入口文件可用）
 * 仅目录存在但入口缺失（如 shiki dist/core.mjs 被删）应视为"未安装/损坏"，
 * 否则 copyModuleToProfile 会误判 already-exists 而不做修复。
 */
function isPackageUsable(nmRoot, name) {
  try {
    const pkgDir = join(nmRoot, name);
    if (!existsSync(pkgDir)) return false;
    const pkg = getPackageJson(nmRoot, name);
    if (!pkg) return false;
    return !!getEntryPath(pkg, nmRoot, name);
  } catch {
    return false;
  }
}

/**
 * 在全局 DSH node_modules 中递归查找模块（支持 hoisted / 嵌套两层布局）
 * pnpm/npm 可能把 shiki 放在 node_modules/shiki（hoisted），也可能嵌套在
 * node_modules/@deepseek-ai/<某包>/node_modules/shiki 下。
 */
function findInNodeModules(nmRoot, name, depth = 0) {
  if (!nmRoot || !existsSync(nmRoot)) return null;
  const direct = join(nmRoot, name);
  if (existsSync(direct) && getPackageJson(nmRoot, name)) return direct;
  if (depth >= 2) return null;
  try {
    const entries = readdirSync(nmRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".pnpm" || e.name === ".bin") continue;
      const childNm = join(nmRoot, e.name, "node_modules");
      if (existsSync(childNm)) {
        const found = findInNodeModules(childNm, name, depth + 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

/**
 * 定向修复单个缺失/损坏模块：从全局 DSH 安装复制到指定 profile
 *
 * 用于 stderr 中 ERR_MODULE_NOT_FOUND 指向的传递依赖（如 shiki 不在
 * profile package.json 的 dependencies/bundles 中，常规完整性检查覆盖不到）。
 * 修复顺序：① 已完整 → ② 删残留 → ③ 全局 hoisted/嵌套复制 →
 * ④ 全局也无源时，直接在 profile 内 pnpm add / npm install 按包名安装
 *    （覆盖"既不在全局副本、也不在 profile 锁文件"的场景，如 shiki 缺失）。
 * @param {string} profile - profile 名称（如 'web'）
 * @param {string} moduleName - 缺失的包名（如 'shiki'）
 * @returns {Promise<{success: boolean, method: string, error?: string}>}
 */
export async function copyModuleToProfile(profile, moduleName) {
  try {
    if (!moduleName) return { success: false, method: 'none', error: '模块名为空' };
    const profileDir = join(DSH_PATHS.profiles, profile);
    const profileNm = join(profileDir, "node_modules");
    const target = join(profileNm, moduleName);

    // ① 已完整安装 → 无需处理
    if (isPackageUsable(profileNm, moduleName)) {
      return { success: true, method: 'already-exists' };
    }
    // ② 目录存在但损坏（入口缺失）→ 删除残留，避免 cpSync 与残留混叠
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }

    // ③ 从全局副本复制（hoisted 顶层 + 嵌套查找）
    const globalNm = await getGlobalDSHNodeModules();
    let src = globalNm ? findInNodeModules(globalNm, moduleName) : null;
    if (src) {
      mkdirSync(profileNm, { recursive: true });
      cpSync(src, target, { recursive: true, force: true });
      const ok = isPackageUsable(profileNm, moduleName);
      if (ok) return { success: true, method: 'copied-from-global' };
    }

    // ④ 全局也无源 → 直接在 profile 内按包名安装（pnpm add，兜底 npm install）
    //    实测：shiki 不在 profile 锁文件时，pnpm install 无法恢复，须显式 add
    const env = { ...process.env };
    try {
      const { stdout } = await execa("pnpm", ["config", "get", "global-bin-dir"], { reject: false, timeout: 10_000, windowsHide: true });
      const binDir = stdout ? stdout.trim() : "";
      if (binDir && existsSync(binDir)) {
        env.PATH = binDir + (process.platform === "win32" ? ";" : ":") + (env.PATH || "");
      }
    } catch {}
    // ① pnpm add（安装到 profile 并更新锁文件，符合 DSH 官方 pnpm 管理方式）
    try {
      const pnpmRes = await execa("pnpm", ["add", moduleName, "--loglevel=error"], {
        cwd: profileDir,
        timeout: 180_000,
        reject: false,
        windowsHide: true,
        env,
      });
      if (pnpmRes.exitCode === 0 && isPackageUsable(profileNm, moduleName)) {
        return { success: true, method: 'installed-in-profile' };
      }
    } catch {}
    // ② 兜底 npm install
    try {
      const npmRes = await execa("npm", ["install", moduleName, "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: profileDir,
        timeout: 180_000,
        reject: false,
        windowsHide: true,
      });
      if (npmRes.exitCode === 0 && isPackageUsable(profileNm, moduleName)) {
        return { success: true, method: 'installed-in-profile' };
      }
    } catch {}

    return { success: false, method: 'none', error: `全局无该模块且 profile 内安装失败: ${moduleName}` };
  } catch (error) {
    return { success: false, method: 'none', error: error.message || String(error) };
  }
}

/**
 * 在 profile 目录内重新安装依赖（pnpm/npm install）
 *
 * profile 由 pnpm 管理（含 pnpm-lock.yaml / pnpm-workspace.yaml），当依赖树整体
 * 残缺（shiki 等传递依赖缺失、全局副本也没有）时，唯一可靠修复是在 profile 内
 * 执行 pnpm install 按锁文件重建完整依赖树。优先 pnpm，失败降级 npm。
 * @param {string} profile - profile 名称（如 'web'）
 * @returns {Promise<{success: boolean, tool: string, summary: string, error?: string}>}
 */
export async function repairProfileDependencies(profile) {
  if (profile === undefined) profile = "web";
  const profileDir = join(DSH_PATHS.profiles, profile);
  const pkgFile = join(profileDir, "package.json");
  if (!existsSync(pkgFile)) {
    return { success: false, tool: 'none', summary: `profile ${profile} 无 package.json` };
  }
  const hasPnpmLock = existsSync(join(profileDir, "pnpm-lock.yaml"));
  const hasNpmLock = existsSync(join(profileDir, "package-lock.json"));

  // pnpm 全局 bin 目录注入 PATH（避免 "global bin directory is not in PATH"）
  const buildEnv = async () => {
    const env = { ...process.env };
    try {
      const { stdout } = await execa("pnpm", ["config", "get", "global-bin-dir"], { reject: false, timeout: 10_000, windowsHide: true });
      const binDir = stdout ? stdout.trim() : "";
      if (binDir && existsSync(binDir)) {
        env.PATH = binDir + (process.platform === "win32" ? ";" : ":") + (env.PATH || "");
      }
    } catch {}
    return env;
  };

  const run = async (tool, args) => {
    try {
      const env = tool === "pnpm" ? await buildEnv() : undefined;
      const res = await execa(tool, args, {
        cwd: profileDir,
        timeout: 300_000,
        reject: false,
        windowsHide: true,
        env,
      });
      return res.exitCode === 0 ? null : (res.stderr || res.stdout || "退出码 " + res.exitCode);
    } catch (e) {
      return e.message || String(e);
    }
  };

  // ① 优先 pnpm（profile 官方由 pnpm 管理）
  // 注意：pnpm 11+ 不支持 npm 风格的 --no-audit/--no-fund，仅保留通用选项，避免 "Unknown options"
  if (hasPnpmLock) {
    const err = await run("pnpm", ["install", "--loglevel=error"]);
    if (!err) {
      return { success: true, tool: 'pnpm', summary: "profile 依赖已通过 pnpm install 重建" };
    }
  }
  // ② 降级 npm（有 package-lock.json 或任意可安装的 package.json）
  if (hasNpmLock || !hasPnpmLock) {
    const err = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
    if (!err) {
      return { success: true, tool: 'npm', summary: "profile 依赖已通过 npm install 重建" };
    }
    return { success: false, tool: 'npm', summary: "profile 依赖修复失败", error: err };
  }
  return { success: false, tool: 'none', summary: "profile 无锁文件，跳过依赖重建" };
}

export async function checkProfileIntegrity(profile, options) {
  if (profile === undefined) profile = "web";
  if (options === undefined) options = {};
  const { includeSystem = false } = options;
  const issues = [];
  let total = 0, ok = 0;
  const pd = join(DSH_PATHS.profiles, profile);
  const pkgFile = join(pd, "package.json");
  const nmRoot = join(pd, "node_modules");
  if (!existsSync(pkgFile)) return { valid: true, total: 0, ok: 0, issues: [], summary: "Profile not found" };
  if (!existsSync(nmRoot)) return { valid: false, total: 0, ok: 0, issues: [{ name: "nm", status: "missing", reason: "nm dir missing", fileCount: 0, refFileCount: null, category: "system" }], summary: "nm dir missing" };
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgFile, "utf-8")); }
  catch { return { valid: false, total: 0, ok: 0, issues: [{ name: "pkg.json", status: "corrupted", reason: "parse failed", fileCount: 0, refFileCount: null, category: "system" }], summary: "pkg.json parse failed" }; }
  const deps = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const allDeps = new Set([...Object.keys(deps), ...bundles]);
  const globalNm = await getGlobalDSHNodeModules();
  for (const name of allDeps) {
    if (!includeSystem && isSystemComponent(name)) continue;
    total++;
    const cat = classifyPackage(name);
    const pkgDir = join(nmRoot, name);
    const nmPkg = getPackageJson(nmRoot, name);
    if (!existsSync(pkgDir)) { issues.push({ name, status: "missing", reason: "not installed", fileCount: 0, refFileCount: null, category: cat }); continue; }
    const ep = getEntryPath(nmPkg, nmRoot, name);
    // 入口缺失即损坏（getEntryPath 已遍历 main/exports 全部目标/index.js；
    // 不能因"声明了 exports"就放行——exports 目标文件可能全缺，如 shiki dist/core.mjs 缺失）
    if (!ep) { issues.push({ name, status: "corrupted", reason: "entry missing", fileCount: countFiles(pkgDir), refFileCount: null, category: cat }); continue; }
    if (globalNm) {
      const refDir = join(globalNm, name);
      if (existsSync(refDir)) {
        const refCount = countFiles(refDir);
        const localCount = countFiles(pkgDir);
        if (localCount < refCount) {
          issues.push({ name, status: "incomplete", reason: "files: " + localCount + " < " + refCount, fileCount: localCount, refFileCount: refCount, category: cat });
          continue;
        }
      }
    }
    ok++;
  }
  const valid = issues.length === 0;
  return { valid, total, ok, issues, summary: valid ? "OK: " + ok + "/" + total : "Issues: " + issues.length + " / " + total };
}

export async function repairProfileFromGlobal(profile, options) {
  if (profile === undefined) profile = "web";
  if (options === undefined) options = {};
  const { dryRun = false, includeSystem = false, onProgress } = options;
  const repaired = [], failed = [], skipped = [];
  const log = (msg, level) => { if (onProgress) onProgress(msg, level || "info"); };
  log("Repairing " + profile + "...", "info");
  const integrity = await checkProfileIntegrity(profile, { includeSystem });
  if (integrity.issues.length === 0) {
    log("All good, no repair needed", "info");
    return { repaired, failed, skipped, summary: "No repair needed" };
  }
  log("Found " + integrity.issues.length + " issues", "info");
  const globalNm = await getGlobalDSHNodeModules();
  if (!globalNm) log("Warning: no global DSH copy found", "warn");
  const nmRoot = join(DSH_PATHS.profiles, profile, "node_modules");
  if (!dryRun && !existsSync(nmRoot)) mkdirSync(nmRoot, { recursive: true });
  for (const issue of integrity.issues) {
    const { name, status, category } = issue;
    if (!includeSystem && category === "system") { skipped.push({ name, reason: "system component" }); continue; }
    if (globalNm) {
      const gpd = join(globalNm, name);
      if (existsSync(gpd)) {
        const gfc = countFiles(gpd);
        if (gfc > 0) {
          try {
            if (!dryRun) {
              const td = join(nmRoot, name);
              const pdir = dirname(td);
              if (!existsSync(pdir)) mkdirSync(pdir, { recursive: true });
              if (existsSync(td) && status === "incomplete") rmSync(td, { recursive: true, force: true });
              cpSync(gpd, td, { recursive: true, force: true });
              repaired.push({ name, action: "copied from global (" + gfc + " files)", size: countFiles(td) });
            } else {
              repaired.push({ name, action: "[dry-run] copy from global (" + gfc + " files)", size: gfc });
            }
            continue;
          } catch (err) { failed.push({ name, error: err.message }); continue; }
        }
      }
    }
    if (status === "missing" || status === "incomplete") { skipped.push({ name, reason: "not in global copy" }); }
    else { failed.push({ name, error: "status: " + status }); }
  }
  if (!dryRun) {
    const v = await checkProfileIntegrity(profile, { includeSystem });
    log("Repair done: " + repaired.length + " fixed, " + failed.length + " failed, " + skipped.length + " skipped", v.valid ? "info" : "warn");
  }
  return { repaired, failed, skipped, summary: "Repaired " + repaired.length + " packages" };
}

export async function repairAllProfiles(options) {
  if (options === undefined) options = {};
  const profiles = []; const results = {};
  const pd = DSH_PATHS.profiles;
  if (existsSync(pd)) {
    try {
      const entries = readdirSync(pd, { withFileTypes: true });
      for (const e of entries) { if (e.isDirectory()) { const pf = join(pd, e.name, "package.json"); if (existsSync(pf)) profiles.push(e.name); } }
    } catch {}
  }
  for (const p of profiles) results[p] = await repairProfileFromGlobal(p, options);
  const tr = Object.values(results).reduce((s, r) => s + r.repaired.length, 0);
  return { profiles, results, summary: "Checked " + profiles.length + " profiles, repaired " + tr + " packages" };
}

export async function getDependencyHealth(profile) {
  if (profile === undefined) profile = "web";
  const integrity = await checkProfileIntegrity(profile, { includeSystem: true });
  return { healthy: integrity.valid, total: integrity.total, ok: integrity.ok, issues: integrity.issues.length, summary: integrity.summary };
}