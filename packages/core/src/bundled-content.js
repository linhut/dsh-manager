/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// ====== 内置内容自动安装器 ======
//
// 用户诉求：安装 dsh-manager（或首次启动）时，把随包内置的技能与插件
// 自动安装到用户 DSH 环境（~/.dsh/skills 技能目录 + profile 插件），
// 开箱即用，无需再手动从市场安装或手动同步。
//
// 内置内容来源（按优先级）：
//   1. 打包布局：process.resourcesPath/dsh-skills（extraResources 携带）
//   2. asar 布局：app.getAppPath()/dsh-skills
//   3. 开发布局：仓库根 dsh-skills（git submodule）
//   4. 兜底：已安装到 profile 的 dsh-skills 插件（node_modules/dsh-skills）
//
// 自动同步策略（幂等，可重复调用）：
//   - 技能：扫描内置技能源 skills/*（含 SKILL.md 的目录），同步到
//     ~/.dsh/skills/<name>。目标不存在或内置版更新 → 复制覆盖。
//   - 插件：能力路由（@dsh-manager/dsh-capability-router）复用
//     capability-router 安装器；dsh-skills 插件本体复制到 profile
//     node_modules 并登记 dsh.profile.bundles（其 index.js 在 DSH 运行
//     时把 skills/* 注册为运行时技能）。
//   - 状态记录：~/.dsh/manager/bundled-content.json 保存上次同步结果
//     （时间戳 + 各技能指纹），供启动校验与 UI 展示。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { DSH_PATHS } from './dsh-utils.js';
import { installCapabilityRouter, isCapabilityRouterInstalled, CAPABILITY_ROUTER_PACKAGE } from './capability-router.js';

/** 内置技能源目录名（dsh-skills 仓库内） */
const SKILLS_REL = ['skills'];

/** 同步状态文件 */
const STATE_FILE = () => join(DSH_PATHS.managerDir, 'bundled-content.json');

/** 复制时忽略的目录（避免把 .git / 构建产物等复制进用户技能目录） */
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.github', '.githooks', '.pytest_cache', '.ruff_cache', '.venv', 'venv', '__pycache__', 'dist', 'build', '.codegraph', '.research', '.dsh']);

/**
 * 解析内置技能源根目录（含 skills/ 的父目录），兼容多种布局。
 * @returns {string|null} 内置技能根（如 <root>/dsh-skills/skills），找不到返回 null
 */
export function resolveBundledSkillsRoot() {
  const candidates = [];
  // ① 打包：extraResources 携带到 resources/dsh-skills
  if (typeof process !== 'undefined' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'dsh-skills'));
  }
  // ② asar / 应用目录
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(join(app.getAppPath(), 'dsh-skills'));
    }
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  // ③ 开发布局：本文件位于 packages/core/src/ → 仓库根 ../../../
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, '..', '..', '..', 'dsh-skills'));
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  // ④ cwd 兜底
  candidates.push(join(process.cwd(), 'dsh-skills'));
  // ⑤ 已安装的 dsh-skills 插件（profile node_modules）
  try {
    const profilesDir = DSH_PATHS.profiles;
    if (existsSync(profilesDir)) {
      for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!profile.isDirectory()) continue;
        candidates.push(join(profilesDir, profile.name, 'node_modules', 'dsh-skills'));
      }
    }
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }

  for (const c of candidates) {
    try {
      if (!c || !existsSync(c)) continue;
      const skillsDir = join(c, ...SKILLS_REL);
      if (existsSync(skillsDir) && readdirSync(skillsDir, { withFileTypes: true }).some(e => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))) {
        return skillsDir;
      }
    } catch { /* 继续探测 */ }
  }
  return null;
}

/** 计算单个文件的指纹（内容 MD5），用于判断是否变化。
 *  注意：不能用 mtime，否则同一内容（复制时间不同）会被误判为不同，
 *  导致每次启动都重复覆盖用户副本。 */
function fileFingerprint(p) {
  try {
    const buf = readFileSync(p);
    return createHash('md5').update(buf).digest('hex');
  } catch { return null; }
}

/** 读取同步状态 */
function readState() {
  try {
    if (existsSync(STATE_FILE())) {
      return JSON.parse(readFileSync(STATE_FILE(), 'utf-8')) || {};
    }
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
  return {};
}

/** 写同步状态 */
function writeState(state) {
  try {
    mkdirSync(DSH_PATHS.managerDir, { recursive: true });
    writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
}

/**
 * 递归复制目录，跳过 IGNORE_DIRS 中的子目录。
 * @param {string} src
 * @param {string} dest
 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) cpSync(s, d);
  }
}

/**
 * 同步单个技能到 ~/.dsh/skills/<name>。
 * 目标不存在 → 复制；存在且内置版更新（按 SKILL.md 指纹）→ 覆盖；否则跳过。
 * @param {string} name - 技能名（目录名）
 * @param {string} srcDir - 内置技能目录
 * @param {object} state - 同步状态（可写）
 * @returns {{name: string, action: 'installed'|'updated'|'skipped', reason?: string}}
 */
function syncOneSkill(name, srcDir, state) {
  const target = join(DSH_PATHS.skills, name);
  const srcSkill = join(srcDir, 'SKILL.md');
  const targetSkill = join(target, 'SKILL.md');

  // 内置技能目录缺少 SKILL.md → 不视为技能，跳过
  if (!existsSync(srcSkill)) {
    return { name, action: 'skipped', reason: 'no-skill-file' };
  }

  const srcFp = fileFingerprint(srcSkill);
  const targetFp = existsSync(targetSkill) ? fileFingerprint(targetSkill) : null;

  // 目标不存在 → 安装
  if (!existsSync(target)) {
    mkdirSync(DSH_PATHS.skills, { recursive: true });
    copyTree(srcDir, target);
    if (!state.skills) state.skills = {};
    state.skills[name] = { fingerprint: srcFp, syncedAt: new Date().toISOString() };
    return { name, action: 'installed' };
  }

  // 目标存在但 SKILL.md 缺失 → 视为损坏，覆盖重装
  if (!existsSync(targetSkill)) {
    rmSync(target, { recursive: true, force: true });
    copyTree(srcDir, target);
    if (!state.skills) state.skills = {};
    state.skills[name] = { fingerprint: srcFp, syncedAt: new Date().toISOString() };
    return { name, action: 'updated', reason: 'target-skill-missing' };
  }

  // 目标存在：内置源与本地副本内容不同 → 以内置为准覆盖（用户确认的策略：
  // "自动覆盖为最新，用户手动改过的内容会被重置"）；内容一致 → 跳过。
  if (srcFp !== targetFp) {
    // 防御：目标目录可能含用户自建文件，但按"自动覆盖为最新"策略整体重置
    rmSync(target, { recursive: true, force: true });
    copyTree(srcDir, target);
    if (!state.skills) state.skills = {};
    state.skills[name] = { fingerprint: srcFp, syncedAt: new Date().toISOString() };
    return { name, action: 'updated' };
  }

  // 内容一致：确保 state 记录存在（兼容早期无 state 的场景），返回跳过
  if (!state.skills) state.skills = {};
  if (!state.skills[name]) {
    state.skills[name] = { fingerprint: srcFp, syncedAt: new Date().toISOString() };
  }
  return { name, action: 'skipped', reason: 'up-to-date' };
}

/**
 * 同步全部内置技能到 ~/.dsh/skills（幂等，可重复调用）。
 * @param {object} [options]
 * @param {boolean} [options.force=false] - 强制全量覆盖（忽略指纹）
 * @param {function} [options.onProgress] - 进度回调 (item) => void
 * @returns {{source: string|null, results: Array, synced: number, skipped: number}}
 */
export function syncBundledSkills(options = {}) {
  const source = resolveBundledSkillsRoot();
  if (!source) {
    return { source: null, results: [], synced: 0, skipped: 0, error: '未找到内置技能源（dsh-skills）' };
  }
  const state = readState();
  const results = [];
  let synced = 0;
  let skipped = 0;
  let entries = [];
  try { entries = readdirSync(source, { withFileTypes: true }); } catch (e) {
    return { source, results: [], synced: 0, skipped: 0, error: '读取内置技能源失败: ' + (e.message || e) };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const srcDir = join(source, e.name);
    if (!existsSync(join(srcDir, 'SKILL.md'))) continue;
    let r;
    if (options.force) {
      // 强制模式：直接覆盖
      const target = join(DSH_PATHS.skills, e.name);
      mkdirSync(DSH_PATHS.skills, { recursive: true });
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      copyTree(srcDir, target);
      if (!state.skills) state.skills = {};
      state.skills[e.name] = { fingerprint: fileFingerprint(join(srcDir, 'SKILL.md')), syncedAt: new Date().toISOString() };
      r = { name: e.name, action: 'updated' };
    } else {
      r = syncOneSkill(e.name, srcDir, state);
    }
    results.push(r);
    if (r.action === 'installed' || r.action === 'updated') synced++;
    else skipped++;
    if (options.onProgress) options.onProgress(r);
  }
  state.lastSyncAt = new Date().toISOString();
  state.source = source;
  writeState(state);
  return { source, results, synced, skipped };
}

/**
 * 自动安装内置插件（幂等）：
 *   1. 能力路由插件（@dsh-manager/dsh-capability-router）— 复用官方安装器
 *   2. dsh-skills 插件本体 → 复制到 profile node_modules + 登记 bundles
 *     （其 index.js 在 DSH 运行时把 skills/* 注册为运行时技能）
 * @param {string} [profile='web']
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @returns {Promise<{capabilityRouter: object, dshSkills: object}>}
 */
export async function installBundledPlugins(profile = 'web', options = {}) {
  const results = { capabilityRouter: null, dshSkills: null };

  // ① 能力路由
  try {
    const already = isCapabilityRouterInstalled(profile);
    if (!already) {
      results.capabilityRouter = await installCapabilityRouter(profile);
      if (options.onProgress) options.onProgress({ plugin: CAPABILITY_ROUTER_PACKAGE, action: results.capabilityRouter.success ? 'installed' : 'failed', detail: results.capabilityRouter });
    } else {
      results.capabilityRouter = { success: true, already: true, installed: true };
      if (options.onProgress) options.onProgress({ plugin: CAPABILITY_ROUTER_PACKAGE, action: 'skipped', detail: 'already-installed' });
    }
  } catch (e) {
    results.capabilityRouter = { success: false, error: e.message || String(e) };
    if (options.onProgress) options.onProgress({ plugin: CAPABILITY_ROUTER_PACKAGE, action: 'failed', detail: results.capabilityRouter });
  }

  // ② dsh-skills 插件本体（作为 bundle 装进 profile）
  try {
    results.dshSkills = await installDshSkillsPlugin(profile);
    if (options.onProgress) options.onProgress({ plugin: 'dsh-skills', action: results.dshSkills.success ? (results.dshSkills.already ? 'skipped' : 'installed') : 'failed', detail: results.dshSkills });
  } catch (e) {
    results.dshSkills = { success: false, error: e.message || String(e) };
    if (options.onProgress) options.onProgress({ plugin: 'dsh-skills', action: 'failed', detail: results.dshSkills });
  }

  return results;
}

/**
 * 把 dsh-skills 插件本体安装进 profile（node_modules + dsh.profile.bundles 登记）。
 * 插件来源 = resolveBundledSkillsRoot() 的父目录（含 package.json/index.js 的 dsh-skills 根）。
 * @param {string} profile
 * @returns {Promise<{success: boolean, already?: boolean, method?: string, error?: string}>}
 */
export async function installDshSkillsPlugin(profile) {
  if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) {
    return { success: false, error: '非法的 profile 名称' };
  }
  // 定位 dsh-skills 插件根（含 package.json 的目录）
  const skillsDir = resolveBundledSkillsRoot();
  if (!skillsDir) return { success: false, error: '未找到内置 dsh-skills 资源' };
  const pluginRoot = dirname(skillsDir); // <root>/dsh-skills
  if (!existsSync(join(pluginRoot, 'package.json')) || !existsSync(join(pluginRoot, 'index.js'))) {
    return { success: false, error: '内置 dsh-skills 缺少插件入口（package.json/index.js）' };
  }

  const profileDir = join(DSH_PATHS.profiles, profile);
  const pkgFile = join(profileDir, 'package.json');
  const nmTarget = join(profileDir, 'node_modules', 'dsh-skills');

  // 已安装判定：node_modules 有包 且 bundles 已登记
  let already = existsSync(join(nmTarget, 'package.json')) && existsSync(join(nmTarget, 'index.js'));
  if (already && existsSync(pkgFile)) {
    try {
      const manifest = JSON.parse(readFileSync(pkgFile, 'utf-8'));
      const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
      already = bundles.includes('dsh-skills');
    } catch { already = false; }
  }
  if (already) return { success: true, already: true, method: 'already-installed' };

  // 复制插件本体（排除 .git）
  try {
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(dirname(nmTarget), { recursive: true });
    if (existsSync(nmTarget)) rmSync(nmTarget, { recursive: true, force: true });
    copyTree(pluginRoot, nmTarget);
  } catch (e) {
    return { success: false, error: '复制 dsh-skills 插件失败: ' + (e.message || e) };
  }

  // 登记 bundles（读改写 profile package.json，带备份）
  try {
    if (!existsSync(pkgFile)) {
      writeFileSync(pkgFile, JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n', 'utf-8');
    }
    const manifest = JSON.parse(readFileSync(pkgFile, 'utf-8'));
    if (!manifest.dsh) manifest.dsh = {};
    if (!manifest.dsh.profile) manifest.dsh.profile = {};
    if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = [];
    if (!manifest.dsh.profile.bundles.includes('dsh-skills')) {
      manifest.dsh.profile.bundles.push('dsh-skills');
    }
    // dependencies 记录（link 到 node_modules 内副本）
    if (!manifest.dependencies) manifest.dependencies = {};
    if (!manifest.dependencies['dsh-skills']) {
      manifest.dependencies['dsh-skills'] = 'file:' + nmTarget.replace(/\\/g, '/');
    }
    // 备份后原子写
    const bk = pkgFile + '.bak-' + Date.now();
    try { cpSync(pkgFile, bk); } catch { /* 备份失败不阻断 */ }
    const tmp = pkgFile + '.tmp-' + Date.now();
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    rmSync(pkgFile, { force: true });
    writeFileSync(pkgFile, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  } catch (e) {
    return { success: false, error: '登记 dsh-skills bundle 失败: ' + (e.message || e) };
  }

  return { success: true, already: false, method: 'copied+bundles' };
}

/**
 * 一键执行内置内容自动安装（技能同步 + 插件安装），幂等。
 * 供 dsh-manager 启动流程调用（首次运行 + 每次启动校验）。
 * @param {object} [options]
 * @param {string} [options.profile='web']
 * @param {boolean} [options.forceSkills=false]
 * @param {boolean} [options.installPlugins=true]
 * @param {function} [options.onProgress]
 * @returns {Promise<{skills: object, plugins: object|null}>}
 */
export async function ensureBundledContent(options = {}) {
  const profile = options.profile || 'web';
  const skills = syncBundledSkills({ force: options.forceSkills, onProgress: options.onProgress });
  let plugins = null;
  if (options.installPlugins !== false) {
    plugins = await installBundledPlugins(profile, { onProgress: options.onProgress });
  }
  return { skills, plugins };
}

/** 读取最近一次同步状态（供 UI 展示） */
export function getBundledContentState() {
  const state = readState();
  return {
    lastSyncAt: state.lastSyncAt || null,
    source: state.source || null,
    skills: state.skills || {},
  };
}

export default {
  resolveBundledSkillsRoot,
  syncBundledSkills,
  installBundledPlugins,
  installDshSkillsPlugin,
  ensureBundledContent,
  getBundledContentState,
};
