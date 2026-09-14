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
//   0. 在线拉取缓存：pluginCache/dsh-skills（纯技能集，安装/首启时 git clone）
//   1. 打包布局：process.resourcesPath/dsh-skills（extraResources 携带）
//   2. asar 布局：app.getAppPath()/dsh-skills
//   3. 开发布局：仓库根 dsh-skills（git submodule）
//   4. 兜底：历史安装到 profile node_modules 的 dsh-skills
//
// 自动同步策略（幂等，可重复调用）：
//   - 技能：扫描内置技能源 skills/*（含 SKILL.md 的目录），同步到
//     ~/.dsh/skills/<name>。目标不存在或内置版更新 → 复制覆盖。
//   - dsh-skills：纯技能集形态——不随包嵌入、不做插件注册；安装/首启时
//     在线 git clone 到 pluginCache（远端有版本 tag → 检测比对已记录版本 →
//     判断是否拉取/更新），技能文件由上面的技能同步落位 ~/.dsh/skills。
//   - 插件：仅能力路由（@dsh-manager/dsh-capability-router）复用
//     capability-router 安装器。
//   - 状态记录：~/.dsh/manager/bundled-content.json 保存上次同步结果
//     （时间戳 + 各技能指纹 + dsh-skills 在线拉取记录），供启动校验与 UI 展示。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const execFile = promisify(execFileCb);
import { DSH_PATHS } from './dsh-utils.js';
import { installCapabilityRouter, isCapabilityRouterInstalled, CAPABILITY_ROUTER_PACKAGE } from './capability-router.js';

/** 内置技能源目录名（dsh-skills 仓库内） */
const SKILLS_REL = ['skills'];

/** dsh-skills 在线仓库（安装/首启时 git clone 拉取，不随安装包嵌入） */
const DSH_SKILLS_GIT_URL = 'https://github.com/linhut/dsh-skills.git';

/** dsh-skills 在线拉取的候选仓库地址（git ls-remote/clone 依次尝试） */
const DSH_SKILLS_CLONE_CANDIDATES = [DSH_SKILLS_GIT_URL];

/** dsh-skills 在线安装失败后的自动重试冷却（毫秒，默认 24h；设置页手动重试/force 无视冷却） */
const DSH_SKILLS_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
  // 在线拉取缓存优先：dsh-skills 在线安装的克隆落点（git clone 到 DSH_PATHS.pluginCache），
  // 不在包内嵌入——无网/未拉取时回退后续候选（开发布局 submodule 等）
  try { candidates.push(join(DSH_PATHS.pluginCache, 'dsh-skills')); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
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

/**
 * 计算整个目录树的内容指纹（相对路径 + 各文件内容 MD5，排序后聚合）。
 * 用于判断「内置插件源」与「已安装副本」的内容是否一致：
 * 内容变化即需要覆盖更新，与文件 mtime 无关。目录为空返回 null。
 * @param {string} root
 * @returns {string|null}
 */
function treeFingerprint(root) {
  const entries = [];
  const walk = (dir, rel) => {
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        const fp = fileFingerprint(abs);
        if (fp) entries.push(r + ':' + fp);
      }
    }
  };
  walk(root, '');
  if (!entries.length) return null;
  entries.sort();
  return createHash('md5').update(entries.join('\n') + '\n').digest('hex');
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
 * @param {boolean} [options.force] - 强制重装 dsh-skills（忽略已装判定）
 * @param {string} [options.source] - dsh-skills 安装源：'online'（默认，git clone）或本地源码目录
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

  // ② dsh-skills 技能集（纯技能集形态：git clone 拉取到 pluginCache/dsh-skills，
  //    版本 tag 检测判断是否安装/更新；技能文件由 syncBundledSkills 同步，无插件注册）
  try {
    results.dshSkills = await installDshSkillsPlugin(profile, { force: options.force, onProgress: options.onProgress, git: options.git });
    if (options.onProgress) options.onProgress({ plugin: 'dsh-skills', action: results.dshSkills.success ? (results.dshSkills.already ? 'skipped' : 'installed') : 'failed', detail: results.dshSkills });
  } catch (e) {
    results.dshSkills = { success: false, error: e.message || String(e) };
    if (options.onProgress) options.onProgress({ plugin: 'dsh-skills', action: 'failed', detail: results.dshSkills });
  }

  return results;
}

/**
 * 确保内置 dsh-skills 技能集就位（纯技能集形态）：
 * 不随安装包嵌入，安装/首启时在线 git clone 到 pluginCache/dsh-skills；
 * 远端有版本 tag → 检测比对已记录版本 → 判断是否拉取/更新（有版本→检测→判断是否安装）；
 * 技能文件由随后的 syncBundledSkills（resolveBundledSkillsRoot 候选①）同步到 ~/.dsh/skills。
 * @param {string} profile
 * @param {object} [options]
 * @param {boolean} [options.force] - 强制重新拉取（忽略已装判定与冷却）
 * @param {object} [options.git] - 注入 git 操作对象（测试用：{ lsRemoteTags, clone, headHash }）
 * @returns {Promise<{success: boolean, already?: boolean, skipped?: boolean, method?: string, version?: string, error?: string}>}
 */
export async function installDshSkillsPlugin(profile, options = {}) {
  if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) {
    return { success: false, error: '非法的 profile 名称' };
  }
  return installDshSkillsOnline(profile, options);
}

/**
 * 在线获取 dsh-skills 技能集：git clone 到 pluginCache/dsh-skills（不随安装包嵌入）。
 * 版本检测——远端有版本 tag 时：已拉取且记录版本 >= 线上最新 tag → 跳过（不重装）；
 * 已拉取但落后 → 拉对应 tag 更新；远端无 tag（未发版）→ 无版本可比，已拉取即视为已装。
 * 无网/仓库不可达 → 记录失败并入 24h 冷却（离线环境不蹭网），设置页手动「安装内置插件」/force 无视冷却。
 * 技能文件由紧随其后的 syncBundledSkills（resolveBundledSkillsRoot 候选① pluginCache/dsh-skills）
 * 同步到 ~/.dsh/skills——本函数只保证 skills 源（克隆）就位，不注册任何插件。
 */
async function installDshSkillsOnline(profile, options = {}) {
  const force = !!options.force;
  const cacheDir = join(DSH_PATHS.pluginCache, 'dsh-skills');
  const git = options.git || defaultGitOps;
  try {
    let targetTag = null;
    let needFetch = false;
    if (force) {
      // 强制：探测线上最新版本 tag 作为目标；探测失败按默认分支拉取
      try { targetTag = pickLatestTag(await git.lsRemoteTags()); } catch { /* 忽略 */ }
      needFetch = true;
    } else {
      const installed = isValidDshSkillsClone(cacheDir);
      needFetch = !installed;
      // 版本检测：远端有 tag（版本）→ 比对已记录版本 → 判断是否安装/更新
      let remoteTags = null;
      try { remoteTags = await git.lsRemoteTags(); } catch { /* 网络异常按无版本处理 */ }
      targetTag = pickLatestTag(remoteTags);
      if (installed && !targetTag) {
        // 远端无版本（未发 tag）→ 无版本可比，已拉取即视为已装
        return { success: true, already: true, method: 'already-installed', version: readRecordedSkillsVersion() };
      }
      if (installed && targetTag) {
        const recorded = readRecordedSkillsVersion();
        if (recorded && compareVersions(recorded, targetTag) >= 0) {
          return { success: true, already: true, method: 'already-version-satisfied', version: recorded };
        }
        // 已拉取但落后于线上版本 → 标记需要按 tag 重新拉取更新
        needFetch = true;
      }
      // 冷却：上次拉取失败后（默认 24h 内）不再重复网络尝试
      const lastAttempt = readState().dshSkillsOnline;
      if (lastAttempt && !lastAttempt.ok && lastAttempt.lastAttemptAt && (Date.now() - Date.parse(lastAttempt.lastAttemptAt)) < DSH_SKILLS_RETRY_COOLDOWN_MS) {
        return { success: false, skipped: true, error: `上次在线获取 dsh-skills 失败（${lastAttempt.lastError || '未知原因'}），冷却期内自动跳过，可在设置页手动重试` };
      }
    }
    // 净迁移：清理旧「插件形态」残留（bundles 登记 / link:/file: 依赖 / node_modules 副本）
    cleanupLegacyDshSkillsPlugin(profile);
    // 拉取：needFetch = 未拉取 / 版本检测落后（需更新到线上 tag）/ force 强拉。
    // 浅克隆到 pluginCache；更新 / force 场景 defaultGitOps.clone 会先清旧缓存
    if (needFetch) {
      await git.clone(cacheDir, { tag: targetTag });
    }
    if (!isValidDshSkillsClone(cacheDir)) {
      throw new Error('拉取产物缺少 skills/*/SKILL.md，仓库结构可能已变更（' + DSH_SKILLS_GIT_URL + '）');
    }
    const version = targetTag || (await git.headHash(cacheDir));
    markDshSkillsOnlineAttempt(true, { version });
    return { success: true, already: false, method: targetTag ? 'online-git-updated' : 'online-git-clone', version };
  } catch (e) {
    markDshSkillsOnlineAttempt(false, { error: e?.message });
    return { success: false, error: '在线获取 dsh-skills 失败: ' + (e?.message || e) };
  }
}

/** 简单语义化版本比较（'v' 前缀容错，数字段逐段比较；缺段按 0 计），a<b 返回 -1，相等 0，a>b 1 */
function compareVersions(a, b) {
  if (a === b) return 0;
  const pa = String(a || '').replace(/^v/i, '').split('.');
  const pb = String(b || '').replace(/^v/i, '').split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 从 tag 列表挑最新语义化版本 tag（'v' 前缀容错；无版本 tag 返回 null） */
function pickLatestTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const semverTags = tags.filter(t => /^v?\d+(\.\d+){1,2}([-+].*)?$/.test(String(t).trim()));
  if (semverTags.length === 0) return null;
  semverTags.sort((a, b) => compareVersions(a, b));
  return semverTags[semverTags.length - 1];
}

/** 校验拉取产物是否为有效 dsh-skills（纯技能集：skills/ 下至少一个含 SKILL.md 的技能目录） */
function isValidDshSkillsClone(dir) {
  try {
    const skillsDir = join(dir, 'skills');
    if (!existsSync(skillsDir)) return false;
    return readdirSync(skillsDir, { withFileTypes: true }).some(e => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')));
  } catch { return false; }
}

/** 读取最近一次成功拉取记录的版本（线上 tag 或 commit 前 12 位），无记录返回 null */
function readRecordedSkillsVersion() {
  try {
    const rec = readState().dshSkillsOnline;
    return (rec && rec.ok && rec.version) || null;
  } catch { return null; }
}

/** 记录在线拉取尝试结果（成功记录版本/清除失败标记；失败写入时间与原因） */
function markDshSkillsOnlineAttempt(ok, extra = {}) {
  try {
    const state = readState();
    state.dshSkillsOnline = {
      ok: !!ok,
      lastAttemptAt: new Date().toISOString(),
      version: ok ? (extra.version || state.dshSkillsOnline?.version) : undefined,
      lastError: ok ? undefined : (extra.error || ''),
    };
    writeState(state);
  } catch { /* 状态记录失败不影响主流程 */ }
}

/**
 * 净迁移：清理 dsh-skills 旧「插件形态」残留——dsh.profile.bundles 登记、
 * dependencies 里的 link:/file: 依赖、profile node_modules/dsh-skills 副本。
 * 纯技能集形态下这些条目指向已不存在的插件（插件 index.js 已移除），
 * 不清除会导致升级用户加载失效插件（技能注册 without inject 故障复现）。
 */
function cleanupLegacyDshSkillsPlugin(profile) {
  try {
    const pkgFile = join(DSH_PATHS.profiles, profile, 'package.json');
    if (existsSync(pkgFile)) {
      const manifest = JSON.parse(readFileSync(pkgFile, 'utf-8'));
      let changed = false;
      if (manifest.dependencies && typeof manifest.dependencies['dsh-skills'] === 'string') {
        delete manifest.dependencies['dsh-skills'];
        changed = true;
      }
      if (Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes('dsh-skills')) {
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(b => b !== 'dsh-skills');
        changed = true;
      }
      if (changed) writeFileSync(pkgFile, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    }
    const nmTarget = join(DSH_PATHS.profiles, profile, 'node_modules', 'dsh-skills');
    if (existsSync(nmTarget)) rmSync(nmTarget, { recursive: true, force: true });
  } catch { /* 清理失败不阻断拉取 */ }
}

/** 默认 git 操作实现（生产链路）：ls-remote 探测版本 tag → 浅克隆 → HEAD 哈希 */
const defaultGitOps = {
  async lsRemoteTags() {
    let lastErr;
    for (const url of DSH_SKILLS_CLONE_CANDIDATES) {
      try {
        const { stdout } = await execFile('git', ['ls-remote', '--tags', '--refs', url], { timeout: 20000 });
        return stdout.split(/\r?\n/).map(l => l.split('refs/tags/')[1]).filter(Boolean);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('git ls-remote 全部候选失败');
  },
  async clone(dest, { tag } = {}) {
    let lastErr;
    for (const url of DSH_SKILLS_CLONE_CANDIDATES) {
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        const args = ['clone', '--depth', '1', '--single-branch'];
        if (tag) args.push('--branch', tag);
        args.push(url, dest);
        await execFile('git', args, { timeout: 120000 });
        return;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('git clone 全部候选失败');
  },
  async headHash(dest) {
    try {
      const { stdout } = await execFile('git', ['-C', dest, 'rev-parse', 'HEAD'], { timeout: 10000 });
      return stdout.trim().slice(0, 12);
    } catch { return null; }
  },
};

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
  let plugins = null;
  if (options.installPlugins !== false) {
    plugins = await installBundledPlugins(profile, { onProgress: options.onProgress, force: options.force, git: options.git });
  }
  // 技能同步在插件安装之后：在线模式下技能源来自插件线的克隆落点（pluginCache/dsh-skills），
  // 先装插件再同步技能，首启即可同轮落地技能；离线/无源时同步失败静默、下次启动自动重试
  const skills = syncBundledSkills({ force: options.forceSkills, onProgress: options.onProgress });
  return { skills, plugins };
}

/** 读取最近一次同步状态（供 UI 展示） */
export function getBundledContentState() {
  const state = readState();
  return {
    lastSyncAt: state.lastSyncAt || null,
    source: state.source || null,
    skills: state.skills || {},
    dshSkillsOnline: state.dshSkillsOnline || null,
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
