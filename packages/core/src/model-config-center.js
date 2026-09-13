/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * 模型配置中心（Model Config Center）
 *
 * 类似 cc-switch 的"配置档案 + 一键应用"能力：
 * 把一套 provider/模型参数保存为命名档案（profile），一键写入各个 AI 编码工具的
 * 本地配置文件，实现跨工具（AtomCode / Claude Code / WorkBuddy 等）的模型切换，
 * 并支持写入前自动备份、一键还原。
 *
 * 安全约束：档案中的 API Key 以明文保存在 Manager 数据目录
 * （默认 ~/.dsh/manager/model-config-center.json），对渲染进程只暴露脱敏值；
 * 写入工具时按工具格式展开（AtomCode 支持 $ENV 环境变量引用，可只存变量名）。
 */

import { homedir } from 'node:os';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync, rmSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/** 受支持的工具适配器元信息（file 可用 toolPaths 覆盖，便于测试） */
export const SUPPORTED_TOOLS = {
  atomcode: {
    id: 'atomcode',
    name: 'AtomCode',
    desc: '~/.atomcode/config.toml',
    file: () => join(homedir(), '.atomcode', 'config.toml'),
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    desc: '~/.claude/settings.json',
    file: () => join(homedir(), '.claude', 'settings.json'),
  },
  workbuddy: {
    id: 'workbuddy',
    name: 'WorkBuddy',
    desc: '~/.codebuddy/models.json',
    file: () => join(homedir(), '.codebuddy', 'models.json'),
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    desc: '~/.codex/config.toml + auth.json',
    file: () => join(homedir(), '.codex', 'config.toml'),
  },
};

export const SUPPORTED_TOOL_IDS = Object.keys(SUPPORTED_TOOLS);

const PROFILES_FILE = 'model-config-center.json';
const BACKUP_ROOT = join('backups', 'model-config-center');
const KEEP_BACKUPS = 10;

// ====== 通用小工具 ======

function slugify(str) {
  const s = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'profile';
}

/** API Key 脱敏：sk-abc...xyz */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

function stripTrailingSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

function tomlEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 解析 TOML 标量值（字符串/布尔/数字），其余原样返回 */
function parseTomlValue(v) {
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) {
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/** 解析一段 TOML 正文（key = value 行）为对象 */
function parseTomlEntries(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    val = val.replace(/#.*$/, '').trim();
    out[key] = parseTomlValue(val);
  }
  return out;
}

/**
 * 将 TOML 文本切分为顶级 table 段落。
 * @returns {{lines: string[], sections: Array<{header: string, start: number, end: number, body: string[]}>}}
 */
export function parseTomlSections(content) {
  const lines = String(content || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/);
    if (m) {
      if (current) current.end = i;
      current = { header: m[1].trim(), start: i, end: i, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(lines[i]);
    }
  }
  if (current) current.end = lines.length;
  return { lines, sections };
}

/**
 * 对 TOML 文本做段落级 upsert（保留无关段落与注释，仅替换/新增目标 table）。
 * @param {string} content 原文本
 * @param {Array<{header: string, text: string, topLevel?: boolean, value?: string}>} upserts
 *   - 普通项：header = table 头（如 `models."y/xxx"`），text = 该段正文（不含表头行）
 *   - topLevel 项：header = 顶层键名，value = 键值文本（用于 default_model 等）
 */
export function renderTomlUpserts(content, upserts) {
  const { lines, sections } = parseTomlSections(content);
  const out = [];
  const replaced = new Set();
  let i = 0;
  while (i < lines.length) {
    const sec = sections.find((s) => s.start === i);
    if (sec) {
      const up = upserts.find((u) => !u.topLevel && u.header === sec.header);
      if (up) {
        out.push(`[${sec.header}]`);
        out.push(...up.text.split(/\r?\n/));
        replaced.add(up);
        i = sec.end;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  for (const up of upserts) {
    if (!up.topLevel || replaced.has(up)) continue;
    const re = new RegExp('^' + up.header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
    const idx = out.findIndex((l) => re.test(l));
    if (idx >= 0) {
      out[idx] = `${up.header} = ${up.value}`;
    } else {
      out.splice(0, 0, `${up.header} = ${up.value}`);
    }
    replaced.add(up);
  }
  for (const up of upserts) {
    if (replaced.has(up)) continue;
    out.push('');
    out.push(`[${up.header}]`);
    out.push(...up.text.split(/\r?\n/));
  }
  return out.join('\n') + '\n';
}

/** 读取 JSON 文件，出错/非法时返回 fallback（不抛异常） */
function safeReadJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 把 baseUrl 规范为 WorkBuddy 需要的完整 /chat/completions URL */
export function ensureChatCompletionsUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  return u.endsWith('/v1') ? u + '/chat/completions' : u + '/v1/chat/completions';
}

/** 模型配置中心主类 */
export class ModelConfigCenter {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir] 档案/备份目录（默认 ~/.dsh/manager）
   * @param {object} [options.toolPaths] 覆盖工具配置文件路径（如 { atomcode: '/tmp/x.toml' }，测试用）
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir || join(homedir(), '.dsh', 'manager');
    this.toolPaths = options.toolPaths || {};
  }

  _storeFile() {
    return join(this.dataDir, PROFILES_FILE);
  }

  _backupDir() {
    return join(this.dataDir, BACKUP_ROOT);
  }

  _toolConfigFile(toolId) {
    return this.toolPaths[toolId] || SUPPORTED_TOOLS[toolId].file();
  }

  _readProfiles() {
    const data = safeReadJson(this._storeFile(), null);
    if (data && Array.isArray(data.profiles)) return data.profiles;
    return [];
  }

  _writeProfiles(profiles) {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      this._storeFile(),
      JSON.stringify({ version: 1, profiles }, null, 2) + '\n',
      'utf-8',
    );
  }

  /** 序列化给渲染进程：默认去掉明文 apiKey，附加脱敏摘要 */
  serializeProfile(p, { full = false } = {}) {
    const copy = JSON.parse(JSON.stringify(p));
    copy.apiKeyMasked = p.apiKey ? maskKey(p.apiKey) : '';
    copy.hasApiKey = !!p.apiKey;
    if (!full) copy.apiKey = '';
    return copy;
  }

  _findProfile(id) {
    return this._readProfiles().find((p) => p && p.id === id);
  }

  // ====== 档案 CRUD ======

  /** 列出全部档案（脱敏） */
  listProfiles() {
    return this._readProfiles().map((p) => this.serializeProfile(p));
  }

  /** 获取单个档案（脱敏）；不存在返回 null */
  getProfile(id) {
    const p = this._findProfile(id);
    return p ? this.serializeProfile(p) : null;
  }

  /**
   * 新建/更新档案。
   * 更新时：input.apiKey 为空或为脱敏占位值（含 ****）则保留原密钥。
   */
  saveProfile(input = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('档案名称不能为空');
    const baseUrl = String(input.baseUrl || '').trim();
    if (!baseUrl) throw new Error('API 地址不能为空');
    const model = String(input.model || '').trim();
    if (!model) throw new Error('模型名称不能为空');

    const profiles = this._readProfiles();
    const now = new Date().toISOString();
    let rec;
    if (input.id) {
      rec = profiles.find((p) => p.id === input.id);
      if (!rec) throw new Error(`配置档案不存在: ${input.id}`);
    } else {
      let id = slugify(name);
      let n = 2;
      while (profiles.some((p) => p.id === id)) id = `${slugify(name)}-${n++}`;
      rec = { id, createdAt: now };
      profiles.push(rec);
    }

    rec.name = name;
    rec.baseUrl = baseUrl;
    rec.model = model;
    if (input.apiKey && !String(input.apiKey).includes('****')) {
      rec.apiKey = String(input.apiKey).trim();
    } else if (!('apiKey' in rec)) {
      rec.apiKey = '';
    }
    if (input.apiKeyEnv !== undefined) rec.apiKeyEnv = String(input.apiKeyEnv || '').trim();
    if (input.smallModel !== undefined) rec.smallModel = String(input.smallModel || '').trim();
    if (input.vendor !== undefined) rec.vendor = String(input.vendor || '').trim();
    if (input.contextWindow !== undefined) rec.contextWindow = Number(input.contextWindow) || 0;
    if (input.maxTokens !== undefined) rec.maxTokens = Number(input.maxTokens) || 0;
    if (input.temperature !== undefined) rec.temperature = Number(input.temperature) || 0;
    if (input.supportsVision !== undefined) rec.supportsVision = !!input.supportsVision;
    if (input.supportsToolCall !== undefined) rec.supportsToolCall = !!input.supportsToolCall;
    if (input.setDefault !== undefined) rec.setDefault = !!input.setDefault;
    rec.updatedAt = now;

    this._writeProfiles(profiles);
    return this.serializeProfile(rec);
  }

  /** 连通性检测：请求 OpenAI 兼容 /models 端点，验证 baseUrl/apiKey 并返回延迟与可用模型（借鉴 Cherry Studio 的 Check） */
  async testConnection(input = {}) {
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return { ok: false, latencyMs: null, error: 'API 地址为空' };
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, latencyMs: null, error: 'API 地址必须以 http(s):// 开头' };
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
    const headers = { 'Content-Type': 'application/json' };
    const key = String(input.apiKey || '').trim();
    if (key && !key.includes('****')) headers.Authorization = `Bearer ${key}`;
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 120); } catch { /* 非文本响应忽略 */ }
        return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `：${detail}` : ''}` };
      }
      let models = [];
      try {
        const data = await res.json();
        if (Array.isArray(data) || Array.isArray(data?.data)) {
          const list = Array.isArray(data) ? data : data.data;
          models = list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean).slice(0, 200);
        }
      } catch { /* 非 JSON 响应也算连通成功 */ }
      return { ok: true, latencyMs, models };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, error: e?.name === 'AbortError' ? '请求超时（>8s，请检查地址与网络）' : (e?.message || String(e)) };
    }
  }

  /** 删除档案，返回是否删除成功 */
  deleteProfile(id) {
    const profiles = this._readProfiles();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    profiles.splice(idx, 1);
    this._writeProfiles(profiles);
    return true;
  }

  /** 导出全部档案（含明文密钥，JSON 字符串） */
  exportProfiles() {
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), profiles: this._readProfiles() }, null, 2);
  }

  /** 导入档案（按 id 合并/覆盖），返回导入数量 */
  importProfiles(jsonText) {
    const data = JSON.parse(jsonText || '{}');
    if (!data || !Array.isArray(data.profiles)) throw new Error('导入内容格式不正确');
    const profiles = this._readProfiles();
    let count = 0;
    for (const item of data.profiles) {
      if (!item || !item.name || !item.baseUrl || !item.model) continue;
      const now = new Date().toISOString();
      const idx = profiles.findIndex((p) => p.id === item.id);
      const rec = { ...item, updatedAt: now };
      if (idx >= 0) profiles[idx] = rec;
      else {
        rec.createdAt = now;
        profiles.push(rec);
      }
      count++;
    }
    this._writeProfiles(profiles);
    return count;
  }

  // ====== 工具配置应用 ======

  /** 列出受支持工具及其配置文件当前状态（含“当前应用了哪个档案”检测） */
  listTools() {
    const profiles = this._readProfiles();
    return SUPPORTED_TOOL_IDS.map((id) => {
      const file = this._toolConfigFile(id);
      const exists = existsSync(file);
      let current = null;
      if (exists) {
        try {
          current = this._detectTool(id, file, profiles);
        } catch (e) {
          current = { error: (e && e.message) || String(e) };
        }
      }
      return {
        id,
        name: SUPPORTED_TOOLS[id].name,
        desc: SUPPORTED_TOOLS[id].desc,
        file,
        exists,
        current,
      };
    });
  }

  /** 写入前把现有配置备份到备份目录（每个工具保留最近 KEEP_BACKUPS 份） */
  _backupFile(target, toolId) {
    const dir = this._backupDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(dir, `${toolId}-${stamp}.bak`);
    copyFileSync(target, backup);
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(toolId + '-') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (const f of files.slice(KEEP_BACKUPS)) {
      try { rmSync(join(dir, f), { force: true }); } catch { /* 忽略清理失败 */ }
    }
    return backup;
  }

  /** 列出某工具的历史备份 */
  listBackups(toolId) {
    const dir = this._backupDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith(toolId + '-') && f.endsWith('.bak'))
      .sort()
      .reverse()
      .map((f) => {
        try {
          return { file: f, size: statSync(join(dir, f)).size };
        } catch {
          return { file: f, size: 0 };
        }
      });
  }

  /**
   * 把档案一键应用到指定工具（可多个）。写入前自动备份原配置。
   * @returns {{profileId: string, results: Array<{tool: string, ok: boolean, file?: string, error?: string}>}}
   */
  apply(profileId, toolIds) {
    const profile = this._findProfile(profileId);
    if (!profile) throw new Error(`配置档案不存在: ${profileId}`);
    const ids = Array.isArray(toolIds) ? toolIds : [toolIds];
    const results = [];
    for (const toolId of ids) {
      if (!SUPPORTED_TOOLS[toolId]) {
        results.push({ tool: toolId, ok: false, error: `不支持的工具: ${toolId}` });
        continue;
      }
      const target = this._toolConfigFile(toolId);
      try {
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target)) this._backupFile(target, toolId);
        if (toolId === 'atomcode') this._applyAtomCode(profile, target);
        else if (toolId === 'claude-code') this._applyClaudeCode(profile, target);
        else if (toolId === 'workbuddy') this._applyWorkBuddy(profile, target);
        else if (toolId === 'codex') this._applyCodex(profile, target);
        results.push({ tool: toolId, ok: true, file: target });
      } catch (e) {
        results.push({ tool: toolId, ok: false, error: (e && e.message) || String(e) });
      }
    }
    return { profileId, results };
  }

  /** 把指定工具还原到最近一次应用前的备份 */
  revert(toolId) {
    if (!SUPPORTED_TOOLS[toolId]) throw new Error(`不支持的工具: ${toolId}`);
    const dir = this._backupDir();
    if (!existsSync(dir)) return { ok: false, error: '没有可还原的备份' };
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(toolId + '-') && f.endsWith('.bak'))
      .sort()
      .reverse();
    if (!files.length) return { ok: false, error: '没有可还原的备份' };
    const target = this._toolConfigFile(toolId);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dir, files[0]), target);
    return { ok: true, restoredFrom: files[0] };
  }

  // ====== 工具适配器：写入 ======

  /** AtomCode：~/.atomcode/config.toml（段落级 upsert，保留无关段落） */
  _applyAtomCode(profile, file) {
    const id = profile.id;
    const key = profile.apiKey || (profile.apiKeyEnv ? `$${profile.apiKeyEnv}` : '');
    const accountText = [
      'provider = "openai-compatible"',
      key ? `api_key = "${tomlEscape(key)}"` : null,
      `base_url = "${tomlEscape(profile.baseUrl)}"`,
    ].filter(Boolean).join('\n');
    const modelText = [
      `account = "${tomlEscape(id)}"`,
      `model = "${tomlEscape(profile.model)}"`,
      `supports_vision = ${profile.supportsVision ? 'true' : 'false'}`,
      profile.contextWindow ? `context_window = ${profile.contextWindow}` : null,
      profile.maxTokens ? `max_tokens = ${profile.maxTokens}` : null,
    ].filter(Boolean).join('\n');
    const upserts = [
      { header: `provider_accounts.${id}`, text: accountText },
      { header: `models."${id}/${profile.model}"`, text: modelText },
    ];
    if (profile.setDefault) {
      upserts.push({ topLevel: true, header: 'default_provider', value: `"${tomlEscape(id)}"` });
      upserts.push({ topLevel: true, header: 'default_model', value: `"${tomlEscape(id + '/' + profile.model)}"` });
    }
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    writeFileSync(file, renderTomlUpserts(existing, upserts), 'utf-8');
  }

  /** Claude Code：~/.claude/settings.json（env 块合并，保留其他键） */
  _applyClaudeCode(profile, file) {
    let settings = safeReadJson(file, {});
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
    const env = Object.assign({}, settings.env && typeof settings.env === 'object' ? settings.env : {});
    env['ANTHROPIC_BASE_URL'] = profile.baseUrl;
    if (profile.apiKey) env['ANTHROPIC_AUTH_TOKEN'] = profile.apiKey;
    env['ANTHROPIC_MODEL'] = profile.model;
    if (profile.smallModel) env['ANTHROPIC_SMALL_FAST_MODEL'] = profile.smallModel;
    env['ANTHROPIC_CUSTOM_MODEL_OPTION'] = profile.model;
    settings.env = env;
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  /** WorkBuddy：~/.codebuddy/models.json（models 按 id 合并 + availableModels 更新） */
  _applyWorkBuddy(profile, file) {
    let data = safeReadJson(file, {});
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    if (!Array.isArray(data.models)) data.models = [];
    const entry = {
      id: profile.model,
      name: profile.name,
      vendor: profile.vendor || '',
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      maxInputTokens: profile.contextWindow || 200000,
      maxOutputTokens: profile.maxTokens || 8192,
      url: ensureChatCompletionsUrl(profile.baseUrl),
      ...(profile.temperature ? { temperature: profile.temperature } : {}),
      supportsToolCall: profile.supportsToolCall !== false,
      supportsImages: !!profile.supportsVision,
    };
    const idx = data.models.findIndex((m) => m && m.id === entry.id);
    if (idx >= 0) data.models[idx] = entry;
    else data.models.push(entry);
    if (!Array.isArray(data.availableModels)) data.availableModels = [];
    if (profile.setDefault) {
      data.availableModels = [entry.id];
    } else if (!data.availableModels.includes(entry.id)) {
      data.availableModels.push(entry.id);
    }
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  /** Codex CLI：~/.codex/auth.json（OPENAI_API_KEY 合并，保留其他键）+ config.toml（model / model_provider / [model_providers.<id>] 段落 upsert） */
  _applyCodex(profile, file) {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    // ① auth.json：OpenAI 兼容认证（Codex 官方格式；有明文 key 才写，否则跳过不破坏既有认证）
    if (profile.apiKey) {
      const authFile = join(dir, 'auth.json');
      let auth = safeReadJson(authFile, {});
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) auth = {};
      auth['OPENAI_API_KEY'] = profile.apiKey;
      if (existsSync(authFile)) this._backupFile(authFile, 'codex-auth');
      writeFileSync(authFile, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
    }
    // ② config.toml：OpenAI 兼容 provider 段落（env_key 指向 auth.json 的 OPENAI_API_KEY）
    const base = stripTrailingSlash(profile.baseUrl).replace(/\/chat\/completions$/i, '');
    const upserts = [
      { topLevel: true, header: 'model', value: `"${tomlEscape(profile.model)}"` },
      { topLevel: true, header: 'model_provider', value: `"${tomlEscape(profile.id)}"` },
      {
        header: `model_providers.${profile.id}`,
        text: [
          `name = "${tomlEscape(profile.name || profile.id)}"`,
          `base_url = "${tomlEscape(base)}"`,
          'env_key = "OPENAI_API_KEY"',
          'wire_api = "chat"',
        ].join('\n'),
      },
    ];
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    writeFileSync(file, renderTomlUpserts(existing, upserts), 'utf-8');
  }

  // ====== 工具适配器：当前状态检测 ======

  _detectTool(toolId, file, profiles) {
    if (toolId === 'atomcode') return this._detectAtomCode(file, profiles);
    if (toolId === 'claude-code') return this._detectClaudeCode(file, profiles);
    if (toolId === 'workbuddy') return this._detectWorkBuddy(file, profiles);
    if (toolId === 'codex') return this._detectCodex(file, profiles);
    return null;
  }

  /** 按 baseUrl+model 匹配已保存档案（须已配置密钥），用于状态识别 */
  _matchProfile(baseUrl, model, profiles) {
    const b = stripTrailingSlash(baseUrl);
    const m = String(model || '');
    return (
      profiles.find(
        (p) =>
          p && p.model === m && stripTrailingSlash(p.baseUrl) === b && (p.apiKey || p.apiKeyEnv),
      ) || null
    );
  }

  _detectAtomCode(file, profiles) {
    const content = readFileSync(file, 'utf-8');
    const { sections } = parseTomlSections(content);
    const accounts = {};
    const modelEntries = [];
    for (const s of sections) {
      if (s.header.startsWith('provider_accounts.')) {
        const id = s.header.slice('provider_accounts.'.length).replace(/"/g, '').trim();
        accounts[id] = parseTomlEntries(s.body.join('\n'));
      } else if (s.header.startsWith('models.')) {
        const m = s.header.match(/^models\.(?:"([^"]+)"|([^".]+))$/);
        if (!m) continue;
        const key = (m[1] || m[2] || '').trim();
        modelEntries.push({ key, ...parseTomlEntries(s.body.join('\n')) });
      }
    }
    const first = modelEntries[0] || null;
    if (!first) return { appliedProfileId: null, model: null, baseUrl: null, hasApiKey: false };
    const acc = accounts[first.account] || {};
    const baseUrl = acc.base_url || '';
    const matched = this._matchProfile(baseUrl, first.model, profiles);
    return {
      appliedProfileId: matched ? matched.id : null,
      appliedName: matched ? matched.name : null,
      model: first.model || null,
      baseUrl: baseUrl || null,
      hasApiKey: !!acc.api_key,
    };
  }

  _detectClaudeCode(file, profiles) {
    const settings = safeReadJson(file, {});
    const env = settings && settings.env && typeof settings.env === 'object' ? settings.env : {};
    const baseUrl = env['ANTHROPIC_BASE_URL'] || '';
    const model = env['ANTHROPIC_MODEL'] || '';
    const matched = this._matchProfile(baseUrl, model, profiles);
    return {
      appliedProfileId: matched ? matched.id : null,
      appliedName: matched ? matched.name : null,
      model: model || null,
      baseUrl: baseUrl || null,
      hasApiKey: !!env['ANTHROPIC_AUTH_TOKEN'] || !!env['ANTHROPIC_API_KEY'],
    };
  }

  _detectWorkBuddy(file, profiles) {
    const data = safeReadJson(file, {});
    const models = Array.isArray(data.models) ? data.models : [];
    const first = models[0] || null;
    if (!first) return { appliedProfileId: null, model: null, baseUrl: null, hasApiKey: false };
    const model = first.id || '';
    const baseUrl = String(first.url || '').replace(/\/chat\/completions$/i, '');
    const matched = this._matchProfile(baseUrl, model, profiles);
    return {
      appliedProfileId: matched ? matched.id : null,
      appliedName: matched ? matched.name : null,
      model: model || null,
      baseUrl: baseUrl || null,
      hasApiKey: !!first.apiKey,
    };
  }

  /** Codex CLI：读取 config.toml 的 model / model_provider / [model_providers.<id>] 段，反查匹配档案 */
  _detectCodex(file, profiles) {
    let content = '';
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
    const { sections, lines } = parseTomlSections(content);
    const entries = (body) => {
      const out = {};
      for (const line of body || []) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*"([^"]*)"\s*$/);
        if (m) out[m[1]] = m[2];
      }
      return out;
    };
    let model = '';
    for (const line of lines) {
      const lm = line.match(/^\s*model\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
      if (lm) {
        model = lm[1];
        break;
      }
    }
    for (const s of sections) {
      if (!s.header.startsWith('model_providers.')) continue;
      const id = s.header.slice('model_providers.'.length).trim();
      const e = entries(s.body);
      const baseUrl = String(e.base_url || '').replace(/\/chat\/completions$/i, '');
      if (!baseUrl) continue;
      const matched = this._matchProfile(baseUrl, model || id, profiles);
      if (matched) {
        return {
          appliedProfileId: matched.id,
          appliedName: matched.name,
          model: model || null,
          baseUrl: baseUrl || null,
          hasApiKey: e.env_key === 'OPENAI_API_KEY' ? null : !!e.env_key,
        };
      }
    }
    return { appliedProfileId: null, model: model || null, baseUrl: null, hasApiKey: false };
  }
}