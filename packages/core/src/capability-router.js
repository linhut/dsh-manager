/**
 * DSH Manager
 * 内置能力路由插件安装器：把随包内置的 @dsh-manager/dsh-capability-router
 * 安装进 DSH profile（node_modules + cordis.patch.yml 注册），使能力路由真正生效。
 */

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, renameSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { DSHError, DSHErrorCodes } from './errors.js';
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
  } catch {}
  if (!version) {
    try {
      const { execa } = await import('execa');
      const { stdout } = await execa('node', ['--version'], { reject: false, timeout: 10_000, windowsHide: true });
      if (stdout && stdout.trim()) { version = stdout.trim(); source = 'system'; }
    } catch {}
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
  } catch {}
  // ③ 开发模式：本文件位于 packages/core/src/ → 相对 ../../plugins/...
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, '..', '..', 'plugins', 'dsh-capability-router'));
  } catch {}
  // ④ Electron Fuses / 直接 cwd 检测（兜底）
  try {
    const cwdPkg = join(process.cwd(), 'packages', 'plugins', 'dsh-capability-router');
    if (existsSync(cwdPkg)) candidates.push(cwdPkg);
  } catch {}
  for (const c of candidates) {
    try { if (c && existsSync(c) && existsSync(join(c, 'package.json'))) return c; } catch {}
  }
  return null;
}

/**
 * 检查能力路由插件是否已安装到 profile：node_modules 有包 且 patch 里有注册条目。
 * @param {string} profile - profile 名（如 'web'）
 * @returns {boolean}
 */
export function isCapabilityRouterInstalled(profile) {
  // 安全校验：profile 必须是合法名称（防止 ../ 逃逸读任意目录）
  if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) return false;
  const nmDir = join(DSH_PATHS.profiles, profile, 'node_modules', CAPABILITY_ROUTER_PACKAGE);
  const hasPkg = existsSync(join(nmDir, 'package.json')) && existsSync(join(nmDir, 'lib', 'index.js'));
  const patchFile = join(DSH_PATHS.profiles, profile, 'cordis.patch.yml');
  let hasPatch = false;
  if (existsSync(patchFile)) {
    try {
      const raw = readFileSync(patchFile, 'utf-8');
      hasPatch = raw.includes("name: '@" + CAPABILITY_ROUTER_PACKAGE.slice(1)) || raw.includes('name: ' + CAPABILITY_ROUTER_PACKAGE) || raw.includes("name: \"@dsh-manager/dsh-capability-router\"");
    } catch {}
  }
  return hasPkg && hasPatch;
}

/**
 * 在 profile 的 cordis.patch.yml 中追加能力路由插件注册条目（幂等）。
 * 复用 MCPServerManager 的原子写入思路：保留头部注释、剔除残留空数组、尾插条目。
 * @param {string} profile
 * @returns {string} backupPath 或 ''
 */
function ensurePatchEntry(profile) {
  const profileDir = join(DSH_PATHS.profiles, profile);
  const patchFile = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  if (!existsSync(patchFile)) writeFileSync(patchFile, '# dsh profile patch layer\n[]\n', 'utf-8');
  const raw = readFileSync(patchFile, 'utf-8').replace(/\r\n/g, '\n');
  // 幂等：已有该条目则不动
  if (raw.indexOf("'@dsh-manager/dsh-capability-router'") >= 0 || raw.indexOf('@dsh-manager/dsh-capability-router') >= 0) {
    return '';
  }
  // 保留头部注释，剔除残留 []
  const header = [];
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) header.push(line);
    else break;
  }
  const bodyRest = raw.split('\n').slice(header.length).filter(function (l) { return l.trim() !== '[]' && l.trim() !== ''; }).join('\n');
  const block = '- insert:' + '\n' + "    - id: capability-router" + '\n' + "      name: '@dsh-manager/dsh-capability-router'" + '\n' + '      config:' + '\n' + '        enabled: true' + '\n' + '        defaultCapability: semantic' + '\n' + '        capabilities: {}';
  const parts = [];
  if (header.length > 0) parts.push(header.join('\n'));
  if (bodyRest.trim()) parts.push(bodyRest);
  parts.push(block);
  const nc = parts.join('\n\n') + '\n';
  // 原子写入 + 备份
  let bk = '';
  if (existsSync(patchFile)) {
    try {
      const ts = Date.now();
      bk = patchFile + '.bak-' + ts;
      copyFileSync(patchFile, bk);
      try { const m = statSync(patchFile).mode & 0o777; if (m) chmodSync(bk, m); } catch {}
    } catch {}
  }
  const tmp = patchFile + '.tmp-' + Date.now();
  try {
    writeFileSync(tmp, nc, 'utf-8');
    renameSync(tmp, patchFile);
  } catch (err) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch {}
    throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '能力路由 patch 写入失败: ' + err.message);
  }
  return bk;
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
    // ① 复制包文件（lib/index.js + package.json）——内容不同则覆盖更新
    //    （多次测试/升级场景：旧版本残留若不更新，用户测到的仍是旧代码）
    const srcIndex = join(srcDir, 'lib', 'index.js');
    const srcPkg = join(srcDir, 'package.json');
    const tgtIndex = join(target, 'lib', 'index.js');
    const tgtPkg = join(target, 'package.json');
    const needCopy = !existsSync(tgtIndex)
      || readFileSync(srcIndex, 'utf-8') !== readFileSync(tgtIndex, 'utf-8')
      || (existsSync(tgtPkg) ? readFileSync(srcPkg, 'utf-8') !== readFileSync(tgtPkg, 'utf-8') : true);
    if (needCopy) {
      mkdirSync(target, { recursive: true });
      // 避免删除整个 target（可能含用户私有文件），仅重写受管文件
      rmSync(tgtIndex, { force: true });
      rmSync(tgtPkg, { force: true });
      mkdirSync(join(target, 'lib'), { recursive: true });
      cpSync(srcIndex, tgtIndex, { force: true });
      cpSync(srcPkg, tgtPkg, { force: true });
      method = 'copied';
    } else {
      method = 'already-exists';
    }
    // ② 注册到 cordis.patch.yml
    const bk = ensurePatchEntry(profile);
    const installed = isCapabilityRouterInstalled(profile);
    // ③ Node 门槛检查：DSH 解析 profile 插件需要 Node >= 22
    let nodeInfo = null;
    try {
      nodeInfo = await detectNodeRuntime();
    } catch {}
    const warning = (nodeInfo && !nodeInfo.meetsRequirement)
      ? ('当前 Node ' + (nodeInfo.version || '未知') + '（' + nodeInfo.source + '）低于 ' + CAPABILITY_ROUTER_MIN_NODE_MAJOR + '，DSH 可能无法解析 profile 内插件，请升级系统 Node 或安装便携版 Node')
      : undefined;
    return {
      success: installed,
      installed,
      method: method + (bk ? '+patch' : ''),
      backupPath: bk || undefined,
      node: nodeInfo || undefined,
      warning,
      error: installed ? undefined : '复制完成但 patch 注册失败',
    };
  } catch (err) {
    return { success: false, installed: false, method: 'none', error: err.message || String(err) };
  }
}

/**
 * 卸载内置能力路由插件（移除 patch 条目；文件保留无害，下次启动自动重装）。
 * @param {string} profile
 * @returns {Promise<{success: boolean}>}
 */
export async function uninstallCapabilityRouter(profile) {
  try {
    if (!profile) profile = 'web';
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) return { success: false, error: '非法的 profile 名称: ' + profile };
    const patchFile = join(DSH_PATHS.profiles, profile, 'cordis.patch.yml');
    if (existsSync(patchFile)) {
      const raw0 = readFileSync(patchFile, 'utf-8');
      const raw = raw0.replace(/\r\n/g, '\n');
      // 找到条目块（id: capability-router 起的 - insert: 块）整体移除
      const lines = raw.split('\n');
      const out = [];
      let skip = false;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '- insert:' && i + 1 < lines.length && lines[i + 1].trim().indexOf('capability-router') >= 0) {
          skip = true;
          continue;
        }
        if (skip) {
          // 直到缩进回到 0 的行结束块
          if (lines[i].trim() !== '' && lines[i].length === lines[i].trimStart().length) skip = false;
          else continue;
        }
        out.push(lines[i]);
      }
      let nc = out.join('\n').replace(/\n{3,}/g, '\n\n');
      if (!nc.trim()) nc = '# dsh profile patch layer\n[]\n';
      if (nc !== raw0) {
        const tmp = patchFile + '.tmp-' + Date.now();
        writeFileSync(tmp, nc, 'utf-8');
        renameSync(tmp, patchFile);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

export default { installCapabilityRouter, uninstallCapabilityRouter, isCapabilityRouterInstalled, resolveBundledPluginDir, detectNodeRuntime, CAPABILITY_ROUTER_PACKAGE, CAPABILITY_ROUTER_MIN_NODE_MAJOR, DEFAULT_NODE_VERSION_REQUIREMENT: CAPABILITY_ROUTER_MIN_NODE_MAJOR };
