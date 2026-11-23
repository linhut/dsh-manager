/**
 * DSH Manager 电脑控制（Computer Use）能力管理
 *
 * 对应 DSH 官方最新版（deepseek-ai/deepseek-harness master）的 computer use 能力：
 * 让模型通过截图/元素 token 观察桌面，并用鼠标键盘工具操作本机。
 *
 * 官方组件（两个包为一组，缺一不可）：
 *   - @deepseek-ai/dsh-computer-use                          注册服务（独占 provider 槽位，无配置）
 *   - @deepseek-ai/dsh-experimental-computer-use-cua-driver-native  原生驱动提供方
 *     （依赖 @trycua/cua-driver，经 npm optionalDependencies 分发 win32-x64/win32-arm64 等平台二进制，
 *       注册名 cua-driver-native，工具前缀 cua_driver_native__，无需额外安装可执行文件）
 *
 * 安装走官方 `dsh plugin --profile <p> add <pkg>@<tag>`（与插件市场同链路），tag 固定 pin 版本
 * （experimental/alpha 破坏性变更多，禁止静默漂移）；启用/禁用只改 profile 清单
 * dsh.profile.bundles（DSH 重启后按官方层序加载/不加载），卸载走 `dsh plugin remove`。
 * 状态全部从磁盘推导（profile 清单 + node_modules 真值），不维护独立状态文件，避免漂移。
 *
 * 可注入项（仅测试/高级场景，默认行为不变）：
 *   options.exec         - 替换 execa（fake exec 记录调用与返回）
 *   options.dshCommand   - 指定 dsh 可执行路径（默认自动解析）
 *   options.skipPnpmCheck- 跳过 requirePnpm 前置检查
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { DSH_PATHS, resolveDSHCommand } from './dsh-utils.js';
import { requirePnpm } from './pnpm-check.js';

/** 电脑控制：注册服务包名（官方） */
export const COMPUTER_USE_SERVICE = '@deepseek-ai/dsh-computer-use';
/** 电脑控制：原生驱动提供方包名（官方，cua-driver native） */
export const COMPUTER_USE_PROVIDER = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native';
/** 电脑控制：提供方注册名（DSH 内 provider id，供文档/提示展示） */
export const COMPUTER_USE_PROVIDER_ID = 'cua-driver-native';
/** 固定 pin 的版本（experimental 包破坏性变更多，禁止静默漂移；升级由未来「更新」动作显式执行） */
export const COMPUTER_USE_TAG = '0.1.6-alpha.1';
/** 安装/卸载涉及的两个官方包 */
export const COMPUTER_USE_PACKAGES = [COMPUTER_USE_SERVICE, COMPUTER_USE_PROVIDER];

/** profile 目录 */
function profileDir(profile) {
  return join(DSH_PATHS.profiles, profile);
}

/** 读取 profile 清单（不存在/损坏返回 {}） */
function readProfileManifest(profile) {
  const file = join(profileDir(profile), 'package.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn('[dsh-manager] ignored error:', e?.message || e);
    return {};
  }
}

/** 原子写 profile 清单（先备份后 tmp+rename，仿 capability-router） */
function writeProfileManifest(profile, manifest) {
  const file = join(profileDir(profile), 'package.json');
  mkdirSync(profileDir(profile), { recursive: true });
  let bk = '';
  if (existsSync(file)) {
    try {
      bk = file + '.bak-' + Date.now();
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

/** 读取 profile 清单中的 dsh.profile.bundles（非数组返回 []） */
function getBundles(manifest) {
  return manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : [];
}

/**
 * ===== 挂载方式：cordis.patch.yml insert 块 =====
 * DSH 的 bundle 协议要求 dsh.profile.bundles 里的每个包必须带 dsh.bundle.patch 字段
 * （dsh-app-boot loadProfileDirectory 硬校验），而官方 computer-use 两包是普通库（无 dsh 字段），
 * 登记进 bundles 会导致 DSH 启动崩溃。官方挂载方式是在 Cordis 组合层加两条 loader entry：
 *   - name: '@deepseek-ai/dsh-computer-use'
 *   - name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
 * cordis.patch.yml 的 insert patch 不带顶层 id 时把 insert 追加到 loader entries 顶层，
 * 与官方语义一致。管理块外包标记注释，按文本定位做幂等增删——
 * 不整文件解析重写，避免破坏用户已有 !!js 表达式与注释。
 */
const PROFILE_PATCH_FILE = 'cordis.patch.yml';
const CU_PATCH_BEGIN = '# >>> dsh-manager computer-use (managed block, do not edit) >>>';
const CU_PATCH_END = '# <<< dsh-manager computer-use <<<';
const CU_PATCH_BLOCK = CU_PATCH_BEGIN + '\n' +
  '- insert:\n' +
  '    - id: dsh-manager-computer-use-service\n' +
  '      name: \'' + COMPUTER_USE_SERVICE + '\'\n' +
  '    - id: dsh-manager-computer-use-provider\n' +
  '      name: \'' + COMPUTER_USE_PROVIDER + '\'\n' +
  CU_PATCH_END;

/** 读取 profile 的 cordis.patch.yml 文本（不存在返回 null） */
function readProfilePatch(profile) {
  const file = join(profileDir(profile), PROFILE_PATCH_FILE);
  if (!existsSync(file)) return null;
  try { return readFileSync(file, 'utf-8'); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); return null; }
}

/** 当前是否已挂载 computer-use（patch 管理块完整存在） */
export function isComputerUseMounted(profile) {
  const patch = readProfilePatch(profile);
  return !!patch && patch.includes(CU_PATCH_BEGIN) && patch.includes(CU_PATCH_END);
}

/** 追加/移除 computer-use 挂载块（文本级幂等），返回 {changed, mounted} */
function ensureComputerUsePatch(profile, enabled) {
  const file = join(profileDir(profile), PROFILE_PATCH_FILE);
  mkdirSync(profileDir(profile), { recursive: true });
  const patch = readProfilePatch(profile) || '';
  const hasBegin = patch.indexOf(CU_PATCH_BEGIN);
  const hasEnd = patch.indexOf(CU_PATCH_END);
  const hasBlock = hasBegin !== -1 && hasEnd !== -1;
  if (enabled && hasBlock) return { changed: false, mounted: true };
  if (!enabled && !hasBlock) return { changed: false, mounted: false };
  let next;
  if (enabled) {
    // 追加到文件末尾（顶层 YAML 数组继续追加一个 insert patch）
    next = (patch.trimEnd() ? patch.trimEnd() + '\n\n' : '') + CU_PATCH_BLOCK + '\n';
  } else {
    // 按标记行删除整个管理块，合并多余空行（trim 会丢文件头 BOM/注释缩进，这里只处理块区域）
    const start = Math.max(0, hasBegin - 1);
    const end = Math.min(patch.length, hasEnd + CU_PATCH_END.length);
    next = patch.slice(0, start).replace(/\n+$/, '\n') + patch.slice(end).replace(/^\n+/, '');
  }
  writeFileSync(file, next, 'utf-8');
  return { changed: true, mounted: enabled };
}

/**
 * 兼容旧现场：早期版本把 computer-use 两包错误登记进 dsh.profile.bundles，
 * 会触发 dsh-app-boot 的 "declares no dsh.bundle" 崩溃。此函数把两包从 bundles
 * 移除（幂等，保留其他 bundle），返回是否清理。调用方（install/开关/卸载）入口幂等执行。
 */
function cleanLegacyBundles(profile) {
  const manifest = readProfileManifest(profile);
  const bundles = getBundles(manifest);
  const remaining = bundles.filter(b => !COMPUTER_USE_PACKAGES.includes(b));
  if (remaining.length === bundles.length) return false;
  manifest.dsh = Object.assign({}, manifest.dsh || {}, {
    profile: Object.assign({}, (manifest.dsh && manifest.dsh.profile) || {}, { bundles: remaining }),
  });
  writeProfileManifest(profile, manifest);
  return true;
}

/** 读取磁盘上已安装包的真实版本（node_modules/<pkg>/package.json），未落盘返回 null */
function readInstalledVersion(profile, packageName) {
  try {
    const pkgFile = join(profileDir(profile), 'node_modules', packageName, 'package.json');
    if (!existsSync(pkgFile)) return null;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
    return pkg.version || null;
  } catch (e) {
    console.warn('[dsh-manager] ignored error:', e?.message || e);
    return null;
  }
}

/**
 * 读取电脑控制功能状态（全部从磁盘推导）。
 * @param {string} [profile='web']
 * @returns {{profile: string, status: string, installed: boolean, enabled: boolean, provider: string,
 *           tag: string, packages: Array<{name: string, installed: boolean, version: string|null, inBundles: boolean, outdated: boolean}>, warning?: string}}
 * status: 'not-installed' | 'disabled' | 'enabled' | 'partial'
 */
export function getComputerUseState(profile = 'web') {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    return { profile, status: 'not-installed', installed: false, enabled: false, provider: COMPUTER_USE_PROVIDER_ID, tag: COMPUTER_USE_TAG, packages: [], error: '非法的 profile 名称: ' + profile };
  }
  const manifest = readProfileManifest(profile);
  const bundles = getBundles(manifest);
  // 旧现场迁移：早期版本误把两包登记进 dsh.profile.bundles（会触发 "declares no dsh.bundle" 崩溃），自动清理
  let legacyMigrated = false;
  try { legacyMigrated = cleanLegacyBundles(profile); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  // 挂载判定 = cordis.patch.yml 管理块存在（官方挂载方式），不再依赖 bundles
  const mounted = isComputerUseMounted(profile);
  const packages = COMPUTER_USE_PACKAGES.map(name => {
    const version = readInstalledVersion(profile, name);
    const inBundles = bundles.includes(name);
    return { name, installed: version !== null, version, inBundles, mounted, outdated: version !== null && version !== COMPUTER_USE_TAG };
  });
  const installedCount = packages.filter(p => p.installed).length;
  const installed = installedCount === COMPUTER_USE_PACKAGES.length;
  const enabled = installed && mounted;
  const bundlesResidual = packages.filter(p => p.inBundles).length;
  let status = 'not-installed';
  if (installed) status = enabled ? 'enabled' : 'disabled';
  else if (installedCount > 0 || bundlesResidual > 0) status = 'partial';
  const warnings = [];
  if (legacyMigrated) warnings.push('已自动清除旧版 bundles 登记残留（该残留会导致 DSH 启动失败），重启 DSH 后生效');
  if (bundlesResidual > 0) warnings.push('仍检测到旧版 bundles 登记残留，如 DSH 启动异常请重启 DSH Manager 后再试');
  if (status === 'partial') warnings.push('组件状态不完整（部分已装/未挂载），建议执行「一键安装」修复');
  const outdated = packages.find(p => p.installed && p.outdated);
  if (outdated) warnings.push(`${outdated.name} 磁盘版本 ${outdated.version} 与内置 pin 版本 ${COMPUTER_USE_TAG} 不一致（experimental 包禁止自动漂移）`);
  return {
    profile, status, installed, enabled, mounted, provider: COMPUTER_USE_PROVIDER_ID, tag: COMPUTER_USE_TAG,
    packages, warning: warnings.length ? warnings.join('；') : undefined,
  };
}

/** 从 pnpm 错误输出提取 allowBuilds 白名单 key（pnpm 11+ 供应链安全策略拦截构建脚本时） */
function extractAllowBuildsKey(text) {
  const t = String(text || '');
  // git-hosted 包提示格式：The git-hosted package "..." needs to execute build scripts
  const gitMatch = t.match(/The git-hosted package "([^"]+)"/);
  if (gitMatch && gitMatch[1]) return gitMatch[1].trim();
  // 常规拦截格式：先收集所有引号对，优先 scoped/带斜杠的包名（避开 "build"/"allowBuilds" 等措辞词）
  const quoted = [];
  for (const m of t.matchAll(/"([^"]+)"/g)) quoted.push(m[1]);
  const slashed = quoted.find(n => n.includes('/')) || (t.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/) || [])[0] || null;
  if (slashed) return slashed.trim();
  const BAD_WORDS = new Set(['allowBuilds', 'approve-builds', 'build', 'true', 'option', 'scripts', 'packages', 'allowlist']);
  const plain = quoted.find(n => !BAD_WORDS.has(n) && !/\s/.test(n) && /[a-zA-Z]/.test(n));
  return plain ? plain.trim() : null;
}

/** 把 allowBuilds key 写入 profile 的 pnpm-workspace.yaml（无键值时创建），返回是否写入 */
function writeAllowBuildsToProfile(profile, key) {
  const yamlPath = join(profileDir(profile), 'pnpm-workspace.yaml');
  const existed = existsSync(yamlPath);
  const content = existed ? readFileSync(yamlPath, 'utf-8') : '';
  if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content)) return { written: false };
  const line = key.includes('@') ? `  '${key}':\n    build: true` : `  ${key}:\n    build: true`;
  const base = content.trimEnd();
  const next = base
    ? base + '\n\nallowBuilds:\n' + line + '\n'
    : 'allowBuilds:\n' + line + '\n';
  mkdirSync(profileDir(profile), { recursive: true });
  writeFileSync(yamlPath, next, 'utf-8');
  return { written: true };
}

/**
 * 一键安装电脑控制（幂等）：
 *   ① dsh plugin add 两个官方包（pin COMPUTER_USE_TAG），allowBuilds 拦截时写白名单重试一次
 *   ② 回读 node_modules 真值断言（不信任 pnpm/dsh 退出码）
 *   ③ 确保 dsh.profile.bundles 已登记（开关处于启用态）
 * @param {string} [profile='web']
 * @param {object} [options] - { onProgress?: (stage: string, pkg?: string) => void }
 * @returns {Promise<{success: boolean, installed: boolean, enabled: boolean, method: string, packages?: Array<{name: string, version: string|null}>, error?: string}>}
 */
export async function installComputerUse(profile = 'web', options = {}) {
  const onProgress = options.onProgress || null;
  const run = options.exec || execa;
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) return { success: false, installed: false, enabled: false, method: 'none', error: '非法的 profile 名称: ' + profile };
    if (!options.skipPnpmCheck) await requirePnpm('安装电脑控制');
    const dsh = options.dshCommand || await resolveDSHCommand();
    const results = [];
    for (const pkg of COMPUTER_USE_PACKAGES) {
      onProgress && onProgress('install', pkg);
      const spec = `${pkg}@${COMPUTER_USE_TAG}`;
      const addArgs = ['plugin', '--profile', profile, 'add', spec];
      let res = await run(dsh, addArgs, { timeout: 180_000, stdio: 'pipe', reject: false, windowsHide: true });
      if (res.failed) {
        // pnpm 11+ 供应链安全拦截构建脚本（@trycua/cua-driver 平台二进制 postinstall）→ 白名单后重试一次
        const combined = ((res.stderr || '') + '\n' + (res.stdout || '')).trim();
        const allowKey = extractAllowBuildsKey(combined);
        if (allowKey) {
          try { writeAllowBuildsToProfile(profile, allowKey); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
          const retry = await run(dsh, addArgs, { timeout: 180_000, stdio: 'pipe', reject: false, windowsHide: true });
          if (!retry.failed) res = retry;
        }
      }
      if (res.failed) {
        const tail = ((res.stderr || '') + '\n' + (res.stdout || '')).trim().split('\n').slice(-5).join('\n');
        return { success: false, installed: false, enabled: false, method: 'install-failed', error: `安装 ${pkg} 失败：${tail || res.exitCode || '未知错误'}` };
      }
      results.push({ name: pkg, version: readInstalledVersion(profile, pkg) });
      onProgress && onProgress('verify', pkg);
    }
    // 真值校验：两包必须真实落盘（实验性包依赖平台二进制，装空包视为失败）
    const missing = results.filter(r => !r.version);
    if (missing.length) {
      return { success: false, installed: false, enabled: false, method: 'verify-failed', error: '安装完成但模块未落盘：' + missing.map(m => m.name).join(', ') + '（可尝试重启 DSH Manager 后重试）' };
    }
    // 挂载到 Cordis 补丁层（官方方式），并幂等清理旧版 bundles 登记残留
    let enabled = true;
    try {
      cleanLegacyBundles(profile);
      enabled = ensureComputerUsePatch(profile, true).mounted;
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    return { success: true, installed: true, enabled, method: 'dsh-plugin-add', packages: results };
  } catch (err) {
    return { success: false, installed: false, enabled: false, method: 'none', error: err.message || String(err) };
  }
}

/**
 * 启用/禁用电脑控制：在 cordis.patch.yml 追加/移除挂载块（官方挂载方式，不卸载依赖，
 * 重启 DSH 生效），并幂等清理旧版 bundles 登记残留。
 * @param {string} profile
 * @param {boolean} enabled
 * @returns {{success: boolean, enabled: boolean, method: string, error?: string}}
 */
export function setComputerUseEnabled(profile, enabled) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) return { success: false, enabled: false, method: 'none', error: '非法的 profile 名称: ' + profile };
    try { cleanLegacyBundles(profile); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    const r = ensureComputerUsePatch(profile, !!enabled);
    return { success: true, enabled: r.mounted, method: r.changed ? (enabled ? 'patch-added' : 'patch-removed') : 'no-change' };
  } catch (err) {
    return { success: false, enabled: false, method: 'none', error: err.message || String(err) };
  }
}

/**
 * 卸载电脑控制：官方 dsh plugin remove 两包；失败时降级为清单清理（bundles + dependencies），
 * 不删 node_modules 里的残留（保守，避免误伤用户私有文件）。
 * @param {string} [profile='web']
 * @param {object} [options] - { onProgress?: (stage: string, pkg?: string) => void }
 * @returns {Promise<{success: boolean, enabled: boolean, method: string, removed: string[], error?: string}>}
 */
export async function uninstallComputerUse(profile = 'web', options = {}) {
  const onProgress = options.onProgress || null;
  const run = options.exec || execa;
  const removed = [];
  const failures = [];
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) return { success: false, enabled: false, method: 'none', removed: [], error: '非法的 profile 名称: ' + profile };
    // 先解除挂载（移除 patch 块）并清理旧版 bundles 残留，避免清单与磁盘不一致
    try {
      ensureComputerUsePatch(profile, false);
      cleanLegacyBundles(profile);
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    try {
      if (!options.skipPnpmCheck) await requirePnpm('卸载电脑控制');
      const dsh = options.dshCommand || await resolveDSHCommand();
      for (const pkg of COMPUTER_USE_PACKAGES) {
        onProgress && onProgress('remove', pkg);
        const res = await run(dsh, ['plugin', '--profile', profile, 'remove', pkg], { timeout: 120_000, stdio: 'pipe', reject: false, windowsHide: true });
        if (res.failed) failures.push(pkg);
        else removed.push(pkg);
      }
    } catch (e) {
      console.warn('[dsh-manager] ignored error:', e?.message || e);
      failures.push(...COMPUTER_USE_PACKAGES);
    }
    // 官方 remove 失败的包走清单降级：移除 bundles + dependencies 条目（dependencies 清理可幂等重跑）
    for (const pkg of failures) {
      try {
        const manifest = readProfileManifest(profile);
        let changed = false;
        const bundles = getBundles(manifest).filter(b => b !== pkg);
        if (bundles.length !== getBundles(manifest).length) changed = true;
        let deps = manifest.dependencies || {};
        if (deps[pkg]) { deps = Object.assign({}, deps); delete deps[pkg]; changed = true; }
        if (changed) {
          manifest.dsh = Object.assign({}, manifest.dsh || {}, {
            profile: Object.assign({}, (manifest.dsh && manifest.dsh.profile) || {}, { bundles }),
          });
          if (Object.keys(deps).length) manifest.dependencies = deps;
          else delete manifest.dependencies;
          writeProfileManifest(profile, manifest);
        }
        removed.push(pkg);
      } catch (e) {
        console.warn('[dsh-manager] ignored error:', e?.message || e);
      }
    }
    if (removed.length === 0) {
      return { success: false, enabled: false, method: 'none', removed: [], error: '卸载失败（' + (failures.join(', ') || '未知') + '），可尝试在插件市场移除同名插件' };
    }
    return { success: removed.length === COMPUTER_USE_PACKAGES.length, enabled: false, method: failures.length ? 'mixed' : 'dsh-plugin-remove', removed, error: failures.length ? '部分组件卸载失败（已降级清理清单）：' + failures.join(', ') : undefined };
  } catch (err) {
    return { success: false, enabled: false, method: 'none', removed, error: err.message || String(err) };
  }
}

export default {
  getComputerUseState,
  installComputerUse,
  setComputerUseEnabled,
  uninstallComputerUse,
  isComputerUseMounted,
  COMPUTER_USE_SERVICE,
  COMPUTER_USE_PROVIDER,
  COMPUTER_USE_PROVIDER_ID,
  COMPUTER_USE_TAG,
  COMPUTER_USE_PACKAGES,
};
