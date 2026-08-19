/**
 * DSH Manager
 * Copyright (c) 2026 linhut (https://github.com/linhut)
 * MIT License
 */

/**
 * @dsh-manager/core - 依赖完整性检查器
 *
 * 基于经验教训实现：
 *   - npm/pnpm install 中断会造成依赖树残缺，且 --offline 显示 "up to date" 但实际文件缺失
 *   - 快速校验法：对比 profile 与全局同名包的文件数，少于全局即残缺
 *   - 修复法：从全局副本整体覆盖，比重新 install 更可靠、更快
 *
 * 功能：
 *   ① 检查 profile node_modules 完整性（文件数对比全局参考）
 *   ② 从 DSH 全局安装副本修复残缺包
 *   ③ 系统组件 vs 外部插件分类
 */

import { existsSync, readFileSync, readdirSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
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
    const first = Object.values(pkg.exports)[0];
    if (typeof first === "string") { const ep = join(nmRoot, name, first); if (existsSync(ep)) return ep; }
    if (typeof first === "object" && first.import) { const ip = join(nmRoot, name, first.import); if (existsSync(ip)) return ip; }
    if (typeof first === "object" && first.default) { const dp = join(nmRoot, name, first.default); if (existsSync(dp)) return dp; }
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
    if (!ep && !nmPkg?.exports) { issues.push({ name, status: "corrupted", reason: "entry missing", fileCount: countFiles(pkgDir), refFileCount: null, category: cat }); continue; }
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