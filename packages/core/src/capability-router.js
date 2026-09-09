/**
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * DSH Manager
 * 内置能力路由插件安装器：把随包内置的 @dsh-manager/dsh-capability-router
 * 安装进 DSH profile（node_modules + 官方 dsh.profile.bundles 登记），
 * 使能力路由真正生效。安装机制与 DSH 官方插件体系对齐：
 * 插件包声明 dsh.bundle.patch（cordis.patch.yml），profile 清单列出该 bundle
 * 即自动应用其补丁层（见 @deepseek-ai/dsh-app-boot loadProfile）。
 * 同时负责从旧的 cordis.patch.yml insert 方式自动迁移到 bundles 方式。
 */

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, renameSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { DSH_PATHS } from './dsh-utils.js';

/** 能力路由插件随 DSH 解析所需的最低 Node 大版本（cordis-plugin-loader fromInternal 要求 Node >= 22） */
export const CAPABILITY_ROUTER_MIN_NODE_MAJOR = 22;

/**
 * 解析 DSH 子进程实际使用的 Node 运行时版本（便携版优先，回退系统 node）。
 * 能力路由插件由 DSH 内部模块加载器按 profile 目录解析，需要 Node >= 22。
 */
export async function detectNodeRuntime() {
  let version = null;
  let source = 'system';
  try {
    const portableBin = process.platform === 'win32'
      ? join(DSH_PATHS.envNodeDir, 'node.exe')
      : join(DSH_PATHS.envNodeDir, 'bin', 'node');
    if (existsSync(portableBin)) {
      const { execa } = await import('execa');
      const { stdout } = await execa(portableBin, ['--version'], { reject: false, timeout: 10_000, windowsHide: true });
      if (stdout && stdout.trim()) { version = stdout.trim(); source = 'portable'; }
    }
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  if (!version) {
    try {
      const { execa } = await import('execa');
      const { stdout } = await execa('node', ['--version'], { reject: false, timeout: 10_000, windowsHide: true });
      if (stdout && stdout.trim()) { version = stdout.trim(); source = 'system'; }
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  }
  const major = version ? (parseInt(version.replace(/^v/, '').split('.')[0], 10) || null) : null;
  return { version, major, meetsRequirement: major !== null && major >= CAPABILITY_ROUTER_MIN_NODE_MAJOR, source };
}

/** 内置能力路由插件包名 */
export const CAPABILITY_ROUTER_PACKAGE = '@dsh-manager/dsh-capability-router';

/**
 * 解析内置插件资源目录（开发/asar/unpacked 三种布局）。
 * @returns {string} 插件资源目录绝对路径，找不到返回 null
 */
export function resolveBundledPluginDir() {
  const candidates = [];
  // ① 打包产物：extraResources unpacked 到 process.resourcesPath/packages/...
  if (typeof process !== 'undefined' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'packages', 'plugins', 'dsh-capability-router'));
  }
  // ② asar 内：app.getAppPath()/packages/...（主进程可 require electron）
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(join(app.getAppPath(), 'packages', 'plugins', 'dsh-capability-router'));
    }
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  // ③ 开发模式：本文件位于 packages/core/src/ → 相对 ../../plugins/...
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, '..', '..', 'plugins', 'dsh-capability-router'));
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  // ④ Electron Fuses / 直接 cwd 检测（兜底）
  try {
    const cwdPkg = join(process.cwd(), 'packages', 'plugins', 'dsh-capability-router');
    if (existsSync(cwdPkg)) candidates.push(cwdPkg);
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  for (const c of candidates) {
    try { if (c && existsSync(c) && existsSync(join(c, 'package.json'))) return c; } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  }
  return null;
}

/**
 * 读取 profile 的 package.json（DSH 官方 profile 清单）。
 * 兼容缺失/损坏场景：缺失返回默认骨架，损坏抛错由调用方处理。
 * @param {string} profile
 * @returns {object} manifest
 */
function readProfileManifest(profile) {
  const profileDir = join(DSH_PATHS.profiles, profile);
  const file = join(profileDir, 'package.json');
  if (!existsSync(file)) return { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf-8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('profile package.json 不是对象');
    return manifest;
  } catch (err) {
    throw new Error('profile 清单解析失败 ' + file + ': ' + (err.message || String(err)));
  }
}

/**
 * 原子写回 profile 的 package.json（备份 + 临时文件 + rename）。
 * @param {string} profile
 * @param {object} manifest
 * @returns {string} backupPath 或 ''
 */
function writeProfileManifest(profile, manifest) {
  const profileDir = join(DSH_PATHS.profiles, profile);
  const file = join(profileDir, 'package.json');
  mkdirSync(profileDir, { recursive: true });
  let bk = '';
  if (existsSync(file)) {
    try {
      const ts = Date.now();
      bk = file + '.bak-' + ts;
      copyFileSync(file, bk);
      try { const m = statSync(file).mode & 0o777; if (m) chmodSync(bk, m); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  }
  const tmp = file + '.tmp-' + Date.now();
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    throw new Error('profile 清单写入失败: ' + (err.message || String(err)));
  }
  return bk;
}

/**
 * 检查能力路由插件是否已安装到 profile：
 * ① 官方机制：node_modules 有包且 profile 清单 dsh.profile.bundles 已登记；
 * ② 兼容旧安装：cordis.patch.yml 仍有 insert 条目（等待下次安装迁移）。
 * @param {string} profile - profile 名（如 'web'）
 * @returns {boolean}
 */
export function isCapabilityRouterInstalled(profile) {
  // 安全校验：profile 必须是合法名称（防止 ../ 逃逸读任意目录）
  if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) return false;
  const nmDir = join(DSH_PATHS.profiles, profile, 'node_modules', CAPABILITY_ROUTER_PACKAGE);
  const hasPkg = existsSync(join(nmDir, 'package.json')) && existsSync(join(nmDir, 'lib', 'index.js'));
  if (!hasPkg) return false;
  // ① bundles 登记
  try {
    const manifest = readProfileManifest(profile);
    const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
    if (bundles.includes(CAPABILITY_ROUTER_PACKAGE)) return true;
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  // ② 旧 patch 方式（迁移前视为已安装，避免重复提示安装）
  const patchFile = join(DSH_PATHS.profiles, profile, 'cordis.patch.yml');
  if (existsSync(patchFile)) {
    try {
      const raw = readFileSync(patchFile, 'utf-8');
      return raw.includes("name: '@" + CAPABILITY_ROUTER_PACKAGE.slice(1)) || raw.includes('name: ' + CAPABILITY_ROUTER_PACKAGE) || raw.includes("name: \"@dsh-manager/dsh-capability-router\"");
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  }
  return false;
}

/**
 * 将能力路由插件登记进 profile 清单的 dsh.profile.bundles（官方机制，幂等），
 * 并迁移旧的 cordis.patch.yml insert 方式（移除条目，避免 loader 重复注册）。
 * 保留头部注释、校验 profile 合法性；写回全程原子 + 备份。
 * @param {string} profile
 * @returns {{bk: string, migrated: boolean, added: boolean}}
 */
function ensureBundleEntry(profile) {
  const manifest = readProfileManifest(profile);
  const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  let added = false;
  if (!bundles.includes(CAPABILITY_ROUTER_PACKAGE)) {
    bundles.push(CAPABILITY_ROUTER_PACKAGE);
    added = true;
  }
  manifest.dsh = Object.assign({}, manifest.dsh || {}, {
    profile: Object.assign({}, (manifest.dsh && manifest.dsh.profile) || {}, { bundles }),
  });
  // 写回时由 writeProfileManifest 统一完成原子写 + 备份（备份路径作为 backupPath 上报）
  const bk = added ? writeProfileManifest(profile, manifest) : '';
  // 自愈：历史版本（1.3.20）可能把 cordis.patch.yml 写成非数组导致 DSH 拒绝启动，
  // 先修复为合法顶层数组再迁移旧条目（修复动作计入 migrated 状态供 UI 展示）。
  const selfHealed = ensureValidPatchArray(profile);
  // 迁移：移除 cordis.patch.yml 中的旧 insert 条目（bundles 生效后由 loader 按官方层序应用）
  const migrated = removeLegacyPatchEntry(profile) || selfHealed;
  return { bk, migrated, added };
}

/**
 * 校验 cordis.patch.yml 是否为 DSH 要求的"顶层 YAML 数组"。
 * 迁移旧 insert 条目时若把文件写坏（如只剩注释/空行/对象），DSH 启动会报
 * "must be a top-level YAML array of loader patch entries"——本函数用于判定。
 * @param {string} raw - patch 文件原文
 * @returns {boolean}
 */
function isPatchArray(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // 顶层数组条目：`- xxx` / `-`（含缩进宽容）；`[]` 也是合法空数组
    if (/^-\s*(\S|\s*$)/.test(t) || t === '[]') return true;
    return false; // 出现非注释、非数组条目的内容 → 不是顶层数组
  }
  // 全注释/空文件：DSH 也需要顶层数组，判定为非法
  return false;
}

/**
 * 移除 cordis.patch.yml 中能力路由插件的旧 insert 条目（幂等），
 * 并确保写回后文件始终是 DSH 要求的"顶层 YAML 数组"。
 * @param {string} profile
 * @returns {boolean} 是否发生了移除
 */
function removeLegacyPatchEntry(profile) {
  const patchFile = join(DSH_PATHS.profiles, profile, 'cordis.patch.yml');
  if (!existsSync(patchFile)) return false;
  const raw0 = readFileSync(patchFile, 'utf-8');
  const raw = raw0.replace(/\r\n/g, '\n');
  // 找到条目块（id: capability-router 起的 - insert: 块）整体移除
  const lines = raw.split('\n');
  const out = [];
  let skip = false;
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '- insert:' && i + 1 < lines.length && lines[i + 1].trim().indexOf('capability-router') >= 0) {
      skip = true;
      removed = true;
      continue;
    }
    if (skip) {
      // 直到缩进回到 0 的行结束块
      if (lines[i].trim() !== '' && lines[i].length === lines[i].trimStart().length) skip = false;
      else continue;
    }
    out.push(lines[i]);
  }
  if (!removed) return false;
  let nc = out.join('\n').replace(/\n{3,}/g, '\n\n');
  // 安全护栏：迁移后必须仍是顶层数组。若残留只有注释/空行（无任何 - 条目），
  // 补 `[]`——否则 DSH loadOverlayPatches 会报 "must be a top-level YAML array" 拒绝启动。
  if (!isPatchArray(nc)) {
    const head = nc.replace(/\n{3,}/g, '\n\n').trim();
    nc = (head ? head + '\n' : '') + '[]\n';
  }
  if (nc !== raw0) {
    const tmp = patchFile + '.tmp-' + Date.now();
    writeFileSync(tmp, nc, 'utf-8');
    renameSync(tmp, patchFile);
  }
  return true;
}

/**
 * 自愈：确保 profile 的 cordis.patch.yml 是 DSH 要求的顶层 YAML 数组。
 * 历史版本（1.3.20）的 removeLegacyPatchEntry 可能把文件写成只剩注释/空行
 * （非数组），导致 DSH 启动报 "must be a top-level YAML array"。本函数在
 * 安装/卸载能力路由前调用：发现非数组时备份并重写为合法空数组（保留注释头）。
 * @param {string} profile
 * @returns {boolean} 是否发生了修复
 */
function ensureValidPatchArray(profile) {
  const patchFile = join(DSH_PATHS.profiles, profile, 'cordis.patch.yml');
  if (!existsSync(patchFile)) return false;
  let raw = '';
  try { raw = readFileSync(patchFile, 'utf-8'); } catch { return false; }
  if (isPatchArray(raw)) return false;
  // 保留注释行作为文件头，追加空数组占位
  const head = raw
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const fixed = (head ? head + '\n' : '') + '[]\n';
  const tmp = patchFile + '.tmp-' + Date.now();
  try {
    writeFileSync(tmp, fixed, 'utf-8');
    renameSync(tmp, patchFile);
    return fixed !== raw;
  } catch (e) {
    console.warn('[dsh-manager] ignored error:', e?.message || e);
    return false;
  }
}

/**
 * 安装内置能力路由插件到 profile（幂等，可重复调用）。
 * @param {string} profile - profile 名，默认 'web'
 * @param {object} [opts]
 * @returns {Promise<{success: boolean, installed: boolean, method: string, error?: string}>}
 */
export async function installCapabilityRouter(profile, opts) {
  try {
    if (!profile) profile = 'web';
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) return { success: false, installed: false, method: 'none', error: '非法的 profile 名称: ' + profile };
    const srcDir = resolveBundledPluginDir();
    if (!srcDir) return { success: false, installed: false, method: 'none', error: '找不到内置插件资源（打包布局异常）' };
    const profileNm = join(DSH_PATHS.profiles, profile, 'node_modules');
    const target = join(profileNm, CAPABILITY_ROUTER_PACKAGE);
    let method = '';
    // ① 复制包文件（lib/index.js + package.json + cordis.patch.yml）——内容不同则覆盖更新
    //    （多次测试/升级场景：旧版本残留若不更新，用户测到的仍是旧代码）
    //    cordis.patch.yml 必须一并拷贝：dsh.profile.bundles 登记后，DSH boot 的
    //    loadOverlayPatches 会读取该文件应用补丁层，缺失将导致 DSH 启动失败（ENOENT）。
    const srcIndex = join(srcDir, 'lib', 'index.js');
    const srcPkg = join(srcDir, 'package.json');
    const srcPatch = join(srcDir, 'cordis.patch.yml');
    const tgtIndex = join(target, 'lib', 'index.js');
    const tgtPkg = join(target, 'package.json');
    const tgtPatch = join(target, 'cordis.patch.yml');
    const fileChanged = (src, tgt) => (existsSync(tgt) ? readFileSync(src, 'utf-8') !== readFileSync(tgt, 'utf-8') : true);
    const needCopy = !existsSync(tgtIndex)
      || fileChanged(srcIndex, tgtIndex)
      || fileChanged(srcPkg, tgtPkg)
      || fileChanged(srcPatch, tgtPatch);
    if (needCopy) {
      mkdirSync(target, { recursive: true });
      // 避免删除整个 target（可能含用户私有文件），仅重写受管文件
      rmSync(tgtIndex, { force: true });
      rmSync(tgtPkg, { force: true });
      rmSync(tgtPatch, { force: true });
      mkdirSync(join(target, 'lib'), { recursive: true });
      cpSync(srcIndex, tgtIndex, { force: true });
      cpSync(srcPkg, tgtPkg, { force: true });
      if (existsSync(srcPatch)) cpSync(srcPatch, tgtPatch, { force: true });
      method = 'copied';
    } else {
      method = 'already-exists';
    }
    // ② 登记到 profile 清单 dsh.profile.bundles（官方机制），并迁移旧 cordis.patch.yml 条目
    const reg = ensureBundleEntry(profile);
    const bk = reg.bk;
    const installed = isCapabilityRouterInstalled(profile);
    // ③ Node 门槛检查：DSH 解析 profile 插件需要 Node >= 22
    let nodeInfo = null;
    try {
      nodeInfo = await detectNodeRuntime();
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    const warning = (nodeInfo && !nodeInfo.meetsRequirement)
      ? ('当前 Node ' + (nodeInfo.version || '未知') + '（' + nodeInfo.source + '）低于 ' + CAPABILITY_ROUTER_MIN_NODE_MAJOR + '，DSH 可能无法解析 profile 内插件，请升级系统 Node 或安装便携版 Node')
      : undefined;
    return {
      success: installed,
      installed,
      method: method + (reg.added ? '+bundle' : '') + (reg.migrated ? '+migrated' : ''),
      backupPath: bk || undefined,
      node: nodeInfo || undefined,
      warning,
      error: installed ? undefined : '复制完成但 bundle 登记失败',
    };
  } catch (err) {
    return { success: false, installed: false, method: 'none', error: err.message || String(err) };
  }
}

/**
 * 卸载内置能力路由插件（从 profile 清单 bundles 移除 + 清理旧 patch 条目；
 * 文件保留无害，下次安装会覆盖更新）。
 * @param {string} profile
 * @returns {Promise<{success: boolean}>}
 */
export async function uninstallCapabilityRouter(profile) {
  try {
    if (!profile) profile = 'web';
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) return { success: false, error: '非法的 profile 名称: ' + profile };
    // ① 从 profile 清单 dsh.profile.bundles 移除（官方机制）
    const manifest = readProfileManifest(profile);
    const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
    const idx = bundles.indexOf(CAPABILITY_ROUTER_PACKAGE);
    if (idx >= 0) {
      bundles.splice(idx, 1);
      manifest.dsh = Object.assign({}, manifest.dsh || {}, {
        profile: Object.assign({}, (manifest.dsh && manifest.dsh.profile) || {}, { bundles }),
      });
      writeProfileManifest(profile, manifest);
    }
    // ② 清理旧 cordis.patch.yml insert 条目（若残留）
    removeLegacyPatchEntry(profile);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

export default { installCapabilityRouter, uninstallCapabilityRouter, isCapabilityRouterInstalled, resolveBundledPluginDir, detectNodeRuntime, CAPABILITY_ROUTER_PACKAGE, CAPABILITY_ROUTER_MIN_NODE_MAJOR, DEFAULT_NODE_VERSION_REQUIREMENT: CAPABILITY_ROUTER_MIN_NODE_MAJOR };
