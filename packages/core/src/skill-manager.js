/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, cpSync, mkdtempSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS } from './dsh-utils.js';
import { parseYAML } from './yaml-utils.js';
import { githubProxyUrls } from './github-mirror.js';
import { tryFetchViaDoh } from './doh-resolver.js';

/** DSH Manager 自身版本（读取仓库根 package.json，避免 UA 硬编码漂移） */
const MANAGER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** kebab-case 技能名 */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 解压安全上限 */
const MAX_ZIP_ENTRIES = 512;
const MAX_ENTRY_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;

/** 来源优先级（数字越小越优先） */
const SOURCE_RANK = { user: 100, custom: 200, project: 300, bundled: 400 };
const SOURCE_LABEL = { user: '用户技能', custom: '自定义目录', project: '项目内置', bundled: '内置技能' };

/** 解析 SKILL.md 或 <name>.md：frontmatter + 正文 */
function parseSkillFile(text) {
  const str = String(text).replace(/^\uFEFF/, '');
  const m = str.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  let meta = {};
  try { meta = parseYAML(m[1]) || {}; } catch { meta = {}; }
  return { meta, body: m[2].replace(/^\n/, '') };
}

/** 渲染带 frontmatter 的 SKILL.md */
function renderSkillFile(input) {
  const meta = { name: input.name, description: input.description };
  if (input.whenToUse) meta['whenToUse'] = input.whenToUse;
  if (input.modelInvocable === false) meta['disable-model-invocation'] = true;
  if (input.userInvocable === false) meta['user-invocable'] = false;
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === 'string') lines.push(k + ': ' + JSON.stringify(v));
    else lines.push(k + ': ' + v);
  }
  lines.push('---');
  lines.push('');
  lines.push(String(input.body || '').replace(/^\n+/, '').replace(/\s+$/, ''));
  return lines.join('\n') + '\n';
}

/**
 * 按最新 DSH 技能规则规范化 SKILL.md frontmatter。
 *
 * 新版 DSH（dsh-skill-filesystem >= 0.1.0-rc.8）对 frontmatter 的硬性要求：
 * - name + description 必填，name 必须 kebab-case（缺失 → 整个技能被丢弃）
 * - invocation 字段必须是 kebab-case：disable-model-invocation / user-invocable
 * - 旧 camelCase 拼写（disableModelInvocation / modelInvocable / userInvocable）
 *   会导致整个技能被忽略（rejectLegacyInvocationKey 抛错）
 * - whenToUse 是可选字段（DSH 标准拼写为 camelCase）
 *
 * 本函数自动迁移旧字段并校验必填项，保证安装后的技能 100% 符合 DSH 最新规则。
 * @param {string} text SKILL.md 原文
 * @returns {{ text: string, name: string }} 规范化后的全文与技能名
 * @throws {DSHError} frontmatter 无法修复时（缺 name / 缺 description / name 非 kebab-case）
 */
function normalizeSkillFrontmatter(text) {
  const { meta, body } = parseSkillFile(text);
  const hasFrontmatter = Object.keys(meta).length > 0;
  if (!hasFrontmatter) {
    throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '技能缺少 YAML frontmatter（必须以 --- 开头，包含 name 和 description）');
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!validSkillName(name)) {
    throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '技能 frontmatter 缺少合法的 kebab-case name（当前: ' + (name || '(空)') + '）');
  }
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) {
    throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '技能 frontmatter 缺少 description（DSH 必填，否则技能不会被加载）');
  }
  // 布尔值宽松解析（与 DSH frontmatterBoolean 一致）
  const toBool = (v, dflt) => {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1') return true;
    if (v === 0 || v === '0') return false;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (['true', 'yes', 'on'].includes(s)) return true;
      if (['false', 'no', 'off'].includes(s)) return false;
    }
    return dflt;
  };
  const out = { name, description };
  // whenToUse：camel 优先，兼容旧 kebab
  if (typeof meta['whenToUse'] === 'string') out['whenToUse'] = meta['whenToUse'];
  else if (typeof meta['when-to-use'] === 'string') out['whenToUse'] = meta['when-to-use'];
  // 模型可调用：迁移旧 camelCase
  if (Object.hasOwn(meta, 'disableModelInvocation')) {
    if (toBool(meta.disableModelInvocation, false) === true) out['disable-model-invocation'] = true;
  } else if (Object.hasOwn(meta, 'modelInvocable')) {
    if (toBool(meta.modelInvocable, true) === false) out['disable-model-invocation'] = true;
  } else if (meta['disable-model-invocation'] !== undefined) {
    out['disable-model-invocation'] = toBool(meta['disable-model-invocation'], false);
  }
  // 用户可调用：迁移旧 camelCase
  if (Object.hasOwn(meta, 'userInvocable')) {
    if (toBool(meta.userInvocable, true) === false) out['user-invocable'] = false;
    else out['user-invocable'] = true;
  } else if (meta['user-invocable'] !== undefined) {
    out['user-invocable'] = toBool(meta['user-invocable'], true);
  }
  // 保留其他自定义字段（metadata 等）
  const reserved = new Set(['name', 'description', 'whenToUse', 'when-to-use', 'disableModelInvocation', 'modelInvocable', 'userInvocable', 'disable-model-invocation', 'user-invocable']);
  for (const [k, v] of Object.entries(meta)) {
    if (reserved.has(k)) continue;
    out[k] = v;
  }
  // 渲染规范化后的 frontmatter + 正文
  const lines = ['---'];
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string') lines.push(k + ': ' + JSON.stringify(v));
    else if (v === true) lines.push(k + ': true');
    else if (v === false) lines.push(k + ': false');
    else lines.push(k + ': ' + JSON.stringify(v));
  }
  lines.push('---');
  lines.push('');
  lines.push(String(body || '').replace(/^\n+/, '').replace(/\s+$/, ''));
  return { text: lines.join('\n') + '\n', name };
}

/** 判断目录名/文件名是否为合法 kebab-case 技能名 */
function validSkillName(name) { return typeof name === 'string' && KEBAB.test(name); }

/** frontmatter 缺 name 时的回退名 */
function fallbackName(path) {
  const base = basename(path);
  if (base === 'SKILL.md') return (dirname(path).split(/[\\/]/).pop() || '');
  if (base.endsWith('.md')) return base.slice(0, -3);
  return '';
}

/** 从 zip 入口路径提取相对安全路径（拒绝 .. / 绝对 / NUL） */
function safeZipRelPath(entryName) {
  const norm = String(entryName).replace(/\\/g, '/');
  if (!norm || norm.includes('\0')) return null;
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null;
  if (parts.length === 0) return null;
  return parts.join('/');
}

/**
 * 极简 zip 解压：只支持 store(0) 与 deflate(8)，处理 data descriptor；
 * 返回 { path -> Buffer } 映射，不直接落盘以便统一校验。
 */
function unzipToMap(buf) {
  if (!buf || buf.length < 4) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '无效的 zip 文件');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const files = {};
  let offset = 0;
  let total = 0;
  let count = 0;
  while (offset + 4 <= buf.length) {
    const sig = view.getUint32(offset, true);
    if (sig === 0x04034b50) { // 本地文件头
      const method = view.getUint16(offset + 8, true);
      const flags = view.getUint16(offset + 6, true);
      const compSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      if (offset + 30 + nameLen > buf.length) break;
      const rawName = dec.decode(buf.subarray(offset + 30, offset + 30 + nameLen));
      const rel = safeZipRelPath(rawName);
      const dataStart = offset + 30 + nameLen + extraLen;
      if (rel && compSize > 0 && dataStart + compSize <= buf.length) {
        const data = buf.subarray(dataStart, dataStart + compSize);
        if (method === 0) files[rel] = Buffer.from(data);
        else if (method === 8) files[rel] = inflateRawSync(data);
        else throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '不支持的 zip 压缩方式: ' + method);
        total += files[rel].length;
        count++;
        if (count > MAX_ZIP_ENTRIES) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'zip 条目数超限');
        if (files[rel].length > MAX_ENTRY_SIZE) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '单文件超限: ' + rawName);
        if (total > MAX_TOTAL_SIZE) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '解压总量超限');
      }
      offset = dataStart + compSize;
      // 跳过 data descriptor（flag bit 3）
      if ((flags & 0x08) && offset + 4 <= buf.length && view.getUint32(offset, true) === 0x08074b50) {
        offset += 12;
      } else if ((flags & 0x08) && buf.length - offset >= 16) {
        offset += 16;
      }
    } else if (sig === 0x02014b50 || sig === 0x06054b50) { // 中央目录/结束记录
      // 从中央目录条目读取总文件数，与已解析数比对（检测截断）
      if (sig === 0x02014b50 && offset + 42 <= buf.length) {
        const totalEntries = view.getUint16(offset + 8, true);
        if (totalEntries !== count) {
          throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 
            'zip 文件不完整（中央目录记录 ' + totalEntries + ' 个条目，实际解析 ' + count + ' 个）'
          );
        }
      }
      break;
    } else if (sig === 0x06064b50) { // zip64 格式结束记录
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '不支持 zip64 格式（文件过大）');
    } else {
      break;
    }
  }
  if (count === 0) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'zip 中未找到任何文件');
  return files;
}

export class SkillManager {
  /**
   * @param {object} [options]
   * @param {string} [options.userSkillsDir] - 用户技能根（默认 ~/.dsh/skills）
   * @param {string[]} [options.customDirs] - 额外自定义技能根
   * @param {string} [options.bundledDir] - 内置技能根（默认项目 dsh-skills/skills）
   */
  constructor(options = {}) {
    this.userSkillsDir = options.userSkillsDir || DSH_PATHS.skills;
    this.customDirs = options.customDirs || [];
    this.bundledDir = options.bundledDir || '';
    this.projectDir = options.projectDir || '';
    // 参考项目模式：DSH settings.yaml 的 customSkillDirs 允许直接挂载技能库目录（克隆后配置即用，无需复制）。
    // 未显式传入 customDirs 时，从 ~/.dsh/settings.yaml 读取 customSkillDirs。
    if (!options.customDirs) {
      try {
        const text = readFileSync(DSH_PATHS.settings, 'utf8');
        const parsed = parseYAML(text) || {};
        const dirs = Array.isArray(parsed.customSkillDirs) ? parsed.customSkillDirs : [];
        this.customDirs = dirs.filter(d => typeof d === 'string' && d.trim());
      } catch {
        this.customDirs = [];
      }
    }
  }

  /** 内置技能根：显式指定 > 环境变量 > 项目 cwd 下的 dsh-skills/skills */
  _resolveBundledDir() {
    if (this.bundledDir) return this.bundledDir;
    if (process.env.DSH_MANAGER_SKILLS_DIR) return process.env.DSH_MANAGER_SKILLS_DIR;
    const cwd = this.projectDir || process.cwd();
    return join(cwd, 'dsh-skills', 'skills');
  }

  /** 扫描单个技能根，产出 RawSkill 列表 */
  _scanRoot(root, source) {
    const out = [];
    if (!existsSync(root)) return out;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = join(root, e.name);
      try {
        if (e.isDirectory()) {
          const skillFile = join(p, 'SKILL.md');
          if (validSkillName(e.name) && existsSync(skillFile)) {
            const { meta, body } = parseSkillFile(readFileSync(skillFile, 'utf8'));
            out.push({
              name: e.name,
              description: typeof meta.description === 'string' ? meta.description : '',
              whenToUse: typeof meta['whenToUse'] === 'string' ? meta['whenToUse'] : (typeof meta['when-to-use'] === 'string' ? meta['when-to-use'] : undefined),
              modelInvocable: meta['disable-model-invocation'] !== true,
              userInvocable: meta['user-invocable'] !== false,
              source, root, path: skillFile, kind: 'bundle', body,
            });
          }
        } else if (e.name.endsWith('.md')) {
          const name = e.name.slice(0, -3);
          if (validSkillName(name)) {
            const { meta, body } = parseSkillFile(readFileSync(p, 'utf8'));
            out.push({
              name,
              description: typeof meta.description === 'string' ? meta.description : '',
              whenToUse: typeof meta['whenToUse'] === 'string' ? meta['whenToUse'] : (typeof meta['when-to-use'] === 'string' ? meta['when-to-use'] : undefined),
              modelInvocable: meta['disable-model-invocation'] !== true,
              userInvocable: meta['user-invocable'] !== false,
              source, root, path: p, kind: 'flat', body,
            });
          }
        }
      } catch { /* 跳过不可读的条目 */ }
    }
    return out;
  }

  /**
   * 扫描全部技能根（优先级 user < custom < project < bundled），
   * 同名取优先级最高者，其余标记 shadowed
   */
  scan() {
    const roots = [
      ...this.customDirs.map(d => ({ dir: d, source: 'custom' })),
      { dir: this.userSkillsDir, source: 'user' },
    ];
    const bundled = this._resolveBundledDir();
    if (bundled) roots.push({ dir: bundled, source: 'bundled' });
    const all = [];
    for (const { dir, source } of roots) all.push(...this._scanRoot(dir, source));
    const winner = new Map();
    for (const s of all) {
      const cur = winner.get(s.name);
      if (!cur || SOURCE_RANK[s.source] < SOURCE_RANK[cur.source]) winner.set(s.name, s);
    }
    return all
      .map(s => ({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        modelInvocable: s.modelInvocable,
        userInvocable: s.userInvocable,
        source: s.source,
        sourceLabel: SOURCE_LABEL[s.source] || s.source,
        rank: SOURCE_RANK[s.source] || 999,
        root: s.root,
        path: s.path,
        kind: s.kind,
        shadowed: winner.get(s.name) !== s,
        bodyPreview: s.body.slice(0, 140),
        mtime: (() => { try { return statSync(s.path).mtime.toISOString(); } catch { return null; } })(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 列出技能（可选过滤：query 匹配 name/description；source 过滤） */
  list(filter = {}) {
    let items = this.scan();
    if (filter.source) items = items.filter(s => s.source === filter.source);
    if (filter.shadowed !== undefined) items = items.filter(s => s.shadowed === filter.shadowed);
    if (filter.query) {
      const q = String(filter.query).toLowerCase();
      items = items.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        (s.whenToUse || '').toLowerCase().includes(q) ||
        (s.bodyPreview || '').toLowerCase().includes(q)
      );
    }
    return items;
  }

  /** 读取单个技能完整内容（含正文与 meta） */
  get(name) {
    const found = this.scan().find(s => s.name === name);
    if (!found) throw new DSHError(DSHErrorCodes.NOT_FOUND, '技能不存在: ' + name);
    const text = readFileSync(found.path, 'utf8');
    const { meta, body } = parseSkillFile(text);
    return { ...found, meta, body, fullText: text };
  }

  /**
   * 创建技能（bundle 形式 <name>/SKILL.md）到用户技能根
   */
  create(input) {
    const name = String(input.name || '').trim();
    if (!validSkillName(name)) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '技能名必须是 kebab-case（小写字母数字+连字符）: ' + name);
    const description = String(input.description || '').trim();
    if (!description) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '技能描述不能为空');
    const body = String(input.body || '');
    const dir = join(this.userSkillsDir, name);
    const file = join(dir, 'SKILL.md');
    if (existsSync(file)) {
      if (!input.overwrite) throw new DSHError(DSHErrorCodes.ALREADY_EXISTS, '技能已存在: ' + name);
    }
    mkdirSync(dir, { recursive: true });
    const text = renderSkillFile({
      name, description,
      whenToUse: input.whenToUse,
      modelInvocable: input.modelInvocable !== false,
      userInvocable: input.userInvocable !== false,
      body,
    });
    writeFileSync(file, text, 'utf8');
    return { success: true, name, path: file };
  }

  /** 更新技能（仅允许作用于用户/自定义来源；按 path 定位） */
  update(name, patch = {}) {
    const found = this.scan().find(s => s.name === name);
    if (!found) throw new DSHError(DSHErrorCodes.NOT_FOUND, '技能不存在: ' + name);
    if (found.source !== 'user' && found.source !== 'custom' && found.source !== 'project') {
      throw new DSHError(DSHErrorCodes.PERMISSION_DENIED, '内置技能只读，请先复制到用户技能目录再编辑');
    }
    const { meta, body } = parseSkillFile(readFileSync(found.path, 'utf8'));
    const modelInvocable = patch.modelInvocable !== undefined ? patch.modelInvocable : meta['disable-model-invocation'] !== true;
    const userInvocable = patch.userInvocable !== undefined ? patch.userInvocable : meta['user-invocable'] !== false;
    const text = renderSkillFile({
      name: name,
      description: patch.description !== undefined ? patch.description : (typeof meta.description === 'string' ? meta.description : ''),
      whenToUse: patch.whenToUse !== undefined ? patch.whenToUse : (typeof meta['whenToUse'] === 'string' ? meta['whenToUse'] : (typeof meta['when-to-use'] === 'string' ? meta['when-to-use'] : '')),
      modelInvocable,
      userInvocable,
      body: patch.body !== undefined ? patch.body : body,
    });
    writeFileSync(found.path, text, 'utf8');
    return { success: true, name, path: found.path };
  }

  /** 删除技能（用户/自定义来源；flat 删除文件，bundle 删除目录） */
  remove(name) {
    const found = this.scan().find(s => s.name === name);
    if (!found) throw new DSHError(DSHErrorCodes.NOT_FOUND, '技能不存在: ' + name);
    if (found.source !== 'user' && found.source !== 'custom') {
      throw new DSHError(DSHErrorCodes.PERMISSION_DENIED, '仅可删除用户技能');
    }
    if (found.kind === 'flat') rmSync(found.path, { force: true });
    else rmSync(dirname(found.path), { recursive: true, force: true });
    return { success: true, name };
  }

  /**
   * 切换可见性并回写 frontmatter
   * @param {string} name
   * @param {'model'|'user'} kind
   * @param {boolean} value
   */
  toggleInvocation(name, kind, value) {
    return this.update(name, kind === 'model' ? { modelInvocable: value } : { userInvocable: value });
  }

  /** 从本地目录导入（复制 skill 目录/文件到用户技能根） */
  importFromDirectory(srcPath, options = {}) {
    const src = String(srcPath || '').trim();
    if (!existsSync(src)) throw new DSHError(DSHErrorCodes.NOT_FOUND, '源路径不存在: ' + src);
    const st = statSync(src);
    let name = ''; let skillFile = '';
    if (st.isDirectory()) {
      name = basename(src);
      skillFile = join(src, 'SKILL.md');
      if (!existsSync(skillFile)) throw new DSHError(DSHErrorCodes.NOT_FOUND, '目录中未找到 SKILL.md');
    } else if (st.isFile() && src.endsWith('.md')) {
      name = basename(src).slice(0, -3);
      skillFile = src;
    } else {
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '仅支持技能目录（含 SKILL.md）或 .md 技能文件');
    }
    if (!validSkillName(name)) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '技能名不合法（kebab-case）: ' + name);
    // 按最新 DSH 规则校验并规范化 frontmatter（缺 name/description、旧 camelCase 字段自动修复/报错）
    const normalized = normalizeSkillFrontmatter(readFileSync(skillFile, 'utf8'));
    name = normalized.name;
    const target = join(this.userSkillsDir, name);
    if (existsSync(target)) {
      if (!options.overwrite) throw new DSHError(DSHErrorCodes.ALREADY_EXISTS, '技能已存在: ' + name);
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(this.userSkillsDir, { recursive: true });
    if (st.isDirectory()) {
      // 排除 .git、node_modules、.DS_Store 等无关目录
      const ignore = ['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv'];
      const filter = (src) => {
        const base = src.split(/[\\/]/).pop();
        return !ignore.includes(base);
      };
      cpSync(src, target, { recursive: true, filter });
      // 重写 SKILL.md 为规范化版本（迁移旧字段，确保 DSH 能加载）
      writeFileSync(join(target, 'SKILL.md'), normalized.text, 'utf8');
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'SKILL.md'), normalized.text, 'utf8');
    }
    return { success: true, name, path: join(target, 'SKILL.md'), source: 'user' };
  }

  /**
   * 解析 GitHub skill 仓库链接：支持仓库根 / tree/<branch>/<path> / blob/<branch>/<file>.md
   */
  parseGitHubUrl(url) {
    const u = String(url || '').trim();
    const m = u.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/);
    if (!m) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '不是有效的 GitHub 链接: ' + url);
    const rest = u.slice(m[0].length);
    if (!rest) return { owner: m[1], repo: m[2], branch: 'main', subPath: '' };
    const tree = rest.match(/^tree\/([^/]+)(?:\/(.*))?$/);
    if (tree) return { owner: m[1], repo: m[2], branch: tree[1], subPath: tree[2] || '' };
    const blob = rest.match(/^blob\/([^/]+)\/(.+\.md)$/);
    if (blob) return { owner: m[1], repo: m[2], branch: blob[1], subPath: blob[2] };
    throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '暂不支持该 GitHub 路径（支持仓库根或 /tree/<branch>/<path>）');
  }

  /**
   * 从 GitHub 下载并导入技能（codeload zip → 解压 → 定位 SKILL.md → 原子安装）
   */
  async importFromGitHub(url, options = {}) {
    const { owner, repo, branch: parsedBranch, subPath } = this.parseGitHubUrl(url);
    // 尝试从 GitHub API 获取仓库的默认分支（直连 + 国内镜像自动回退）
    let defaultBranch = parsedBranch;
    const apiUrl = 'https://api.github.com/repos/' + owner + '/' + repo;
    const apiCandidates = githubProxyUrls(apiUrl);
    const apiHeaders = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dsh-manager/' + MANAGER_VERSION };
    const parseBranch = async (resp) => {
      if (resp && resp.ok) {
        try {
          const data = await resp.json();
          return data.default_branch || null;
        } catch { return null; }
      }
      return null;
    };
    // DoH 直连（绕过 DNS 污染）+ 直连/镜像竞速
    const branchResults = await Promise.all([
      tryFetchViaDoh(apiUrl, { timeoutMs: 5000, headers: apiHeaders }).then(parseBranch),
      ...apiCandidates.map(async (apiCandidate) => {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 5000);
          try {
            const resp = await fetch(apiCandidate, { headers: apiHeaders, signal: ac.signal });
            return await parseBranch(resp);
          } finally {
            clearTimeout(t);
          }
        } catch { return null; }
      }),
    ]);
    if (branchResults.find(Boolean)) defaultBranch = branchResults.find(Boolean);
    // 构建候选列表：首选 API 返回的默认分支，其次解析出的分支，再尝试常见分支
    const candidates = [defaultBranch, parsedBranch, 'main', 'master'].filter((v, i, a) => a.indexOf(v) === i);
    let buf = null;
    // 每个分支候选：直连 + 国内镜像并行竞速（codeload zip 经镜像加速，解决国内超时）
    for (const ref of candidates) {
      const downloadUrl = 'https://codeload.github.com/' + owner + '/' + repo + '/zip/refs/heads/' + encodeURIComponent(ref);
      const downloadUrls = githubProxyUrls(downloadUrl);
      // DoH 直连（绕过 DNS 污染）+ 直连/镜像并行竞速
      const dlResults = await Promise.all([
        tryFetchViaDoh(downloadUrl, { timeoutMs: DOWNLOAD_TIMEOUT_MS }).then(async (resp) => {
          if (resp && resp.ok) return Buffer.from(await resp.arrayBuffer());
          return null;
        }),
        ...downloadUrls.map(async (url) => {
          try {
            const abortController = new AbortController();
            const timeoutTimer = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);
            try {
              const resp = await fetch(url, { signal: abortController.signal });
              if (resp.ok) return Buffer.from(await resp.arrayBuffer());
              return null;
            } finally {
              clearTimeout(timeoutTimer);
            }
          } catch { return null; }
        }),
      ]);
      buf = dlResults.find(Boolean);
      if (buf) break; // 该分支成功 → 停止
    }
    if (!buf) throw new DSHError(DSHErrorCodes.NETWORK_ERROR, '下载失败：仓库 ' + owner + '/' + repo + ' 分支 ' + branch + ' 不可访问');
    let files;
    try { files = unzipToMap(buf); } catch (e) { throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'zip 解压失败: ' + e.message); }
    // 定位 SKILL.md（顶层单包裹目录自动剥离）
    const tops = new Set(Object.keys(files).map(k => k.split('/')[0]));
    const base = tops.size === 1 ? [...tops][0] + '/' : '';
    const prefix = base + (subPath ? subPath.replace(/\/$/, '') + '/' : '');
    const skillKey = Object.keys(files).find(k => k.startsWith(prefix) && k.endsWith('/SKILL.md'));
    if (!skillKey) throw new DSHError(DSHErrorCodes.NOT_FOUND, '仓库中未找到 SKILL.md');
    const skillDir = skillKey.slice(0, -'/SKILL.md'.length);
    const dirName = skillDir.split('/').pop() || '';
    // 按最新 DSH 规则校验并规范化 frontmatter（缺 name/description、旧 camelCase 字段自动修复/报错）
    const normalized = normalizeSkillFrontmatter(files[skillKey].toString('utf8'));
    const name = normalized.name;
    const target = join(this.userSkillsDir, name);
    if (existsSync(target)) {
      if (!options.overwrite) throw new DSHError(DSHErrorCodes.ALREADY_EXISTS, '技能已存在: ' + name + '（可使用 overwrite 覆盖）');
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(this.userSkillsDir, { recursive: true });
    const installed = [];
    for (const [k, data] of Object.entries(files)) {
      if (!k.startsWith(skillDir + '/')) continue;
      const rel = k.slice(skillDir.length + 1);
      if (!rel) continue;
      const dest = join(target, rel);
      const relToTarget = relative(target, dest);
      if (relToTarget.startsWith('..') || isAbsolute(relToTarget)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      // SKILL.md 写规范化版本，其余文件原样写入
      writeFileSync(dest, rel === 'SKILL.md' ? normalized.text : data);
      installed.push(rel);
    }
    // 记录来源仓库（供后续同步更新使用）
    try { this.recordSkillSource(name, url); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
    return { success: true, name, path: join(target, 'SKILL.md'), source: 'user', installed };
  }

  /** 从本地 .skill / .zip 文件导入技能 */
  async importFromZipFile(filePath, options = {}) {
    if (!existsSync(filePath)) throw new DSHError(DSHErrorCodes.NOT_FOUND, '文件不存在: ' + filePath);
    const buf = readFileSync(filePath);
    let files;
    try { files = unzipToMap(buf); } catch (e) { throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'zip 解压失败: ' + e.message); }
    const tops = new Set(Object.keys(files).map(k => k.split('/')[0]));
    const base = tops.size === 1 ? [...tops][0] + '/' : '';
    const skillKey = Object.keys(files).find(k => k.startsWith(base) && k.endsWith('/SKILL.md'));
    if (!skillKey) throw new DSHError(DSHErrorCodes.NOT_FOUND, '压缩包中未找到 SKILL.md');
    const skillDir = skillKey.slice(0, -'/SKILL.md'.length);
    const dirName = skillDir.split('/').pop() || '';
    // 按最新 DSH 规则校验并规范化 frontmatter
    const normalized = normalizeSkillFrontmatter(files[skillKey].toString('utf8'));
    const name = normalized.name;
    const target = join(this.userSkillsDir, name);
    if (existsSync(target)) {
      if (!options.overwrite) throw new DSHError(DSHErrorCodes.ALREADY_EXISTS, '技能已存在: ' + name);
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(this.userSkillsDir, { recursive: true });
    for (const [k, data] of Object.entries(files)) {
      if (!k.startsWith(skillDir + '/')) continue;
      const rel = k.slice(skillDir.length + 1);
      if (!rel) continue;
      const dest = join(target, rel);
      const relToTarget = relative(target, dest);
      if (relToTarget.startsWith('..') || isAbsolute(relToTarget)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      // SKILL.md 写规范化版本，其余文件原样写入
      writeFileSync(dest, rel === 'SKILL.md' ? normalized.text : data);
    }
    return { success: true, name, path: join(target, 'SKILL.md'), source: 'user' };
  }

  // ====== 技能仓库（skill sources）管理 ======

  /**
   * 技能来源注册表路径：~/.dsh/manager/skill-sources.json
   * 记录用户技能与来源仓库的对应关系，支持后续"一键同步更新"
   */
  get sourceRegistryPath() {
    return join(DSH_PATHS.managerDir, 'skill-sources.json');
  }

  /**
   * 读取技能来源注册表
   * @returns {Record<string, {url: string, owner: string, repo: string, branch: string, subPath: string, installedAt: string}>}
   */
  readSkillSources() {
    try {
      if (existsSync(this.sourceRegistryPath)) {
        return JSON.parse(readFileSync(this.sourceRegistryPath, 'utf-8')) || {};
      }
    } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
    return {};
  }

  /**
   * 写入技能来源注册表
   * @param {Record<string, object>} sources
   * @private
   */
  writeSkillSources(sources) {
    mkdirSync(DSH_PATHS.managerDir, { recursive: true });
    writeFileSync(this.sourceRegistryPath, JSON.stringify(sources, null, 2) + '\n', 'utf-8');
  }

  /**
   * 记录技能的来源仓库（在 importFromGitHub 成功后调用）
   * @param {string} name - 技能名
   * @param {string} url - GitHub 仓库 URL
   */
  recordSkillSource(name, url) {
    const sources = this.readSkillSources();
    try {
      const parsed = this.parseGitHubUrl(url);
      sources[name] = {
        url,
        owner: parsed.owner,
        repo: parsed.repo,
        branch: parsed.branch,
        subPath: parsed.subPath,
        installedAt: new Date().toISOString(),
      };
      this.writeSkillSources(sources);
      return { success: true, name, ...sources[name] };
    } catch {
      return { success: false, name, error: '无法解析来源 URL' };
    }
  }

  /**
   * 列出所有已记录来源的技能
   * @returns {Array<{name: string, url: string, owner: string, repo: string, branch: string, subPath: string, installedAt: string}>}
   */
  listSkillSources() {
    const sources = this.readSkillSources();
    return Object.entries(sources).map(([name, info]) => ({ name, ...info }));
  }

  /**
   * 从记录的来源仓库同步更新单个技能（覆盖安装）
   * @param {string} name - 技能名
   * @returns {Promise<{success: boolean, name: string, updated: boolean, error?: string}>}
   */
  async syncSkillFromSource(name) {
    const sources = this.readSkillSources();
    const src = sources[name];
    if (!src) {
      return { success: false, name, updated: false, error: '该技能未记录来源仓库（使用"从 GitHub 导入"安装的技能才有来源记录）' };
    }
    try {
      // 复用 importFromGitHub 的下载逻辑，强制覆盖
      const result = await this.importFromGitHub(src.url, { overwrite: true });
      return { success: true, name, updated: true, ...result };
    } catch (error) {
      return { success: false, name, updated: false, error: error.message };
    }
  }

  /**
   * 同步所有已记录来源的技能
   * @param {object} [options]
   * @param {function} [options.onProgress] - 进度回调 (name, result) => void
   * @returns {Promise<{synced: Array, failed: Array, skipped: Array}>}
   */
  async syncAllSkills(options = {}) {
    const sources = this.readSkillSources();
    const names = Object.keys(sources);
    const synced = [];
    const failed = [];
    const skipped = [];

    for (const name of names) {
      const result = await this.syncSkillFromSource(name);
      if (result.success && result.updated) {
        synced.push(result);
        if (options.onProgress) options.onProgress(name, result);
      } else if (result.error && result.error.includes('未记录来源')) {
        skipped.push(result);
      } else {
        failed.push(result);
        if (options.onProgress) options.onProgress(name, result);
      }
    }

    return { synced, failed, skipped, total: names.length };
  }

  /** 技能统计（用于仪表盘/展示） */
  stats() {
    const items = this.scan();
    return {
      total: items.length,
      active: items.filter(s => !s.shadowed).length,
      shadowed: items.filter(s => s.shadowed).length,
      bySource: Object.fromEntries(['user', 'custom', 'project', 'bundled'].map(k => [k, items.filter(s => s.source === k).length])),
    };
  }
}