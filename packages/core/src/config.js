/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS } from './dsh-utils.js';
import { parseYAML, toYAML } from './yaml-utils.js';

/**
 * Manager「提供商类型」→ DSH 真实 adapter 命名空间映射。
 * DSH 0.1.2-alpha.4 只注册两个 LLM 段：
 *   - llm-pi-ai  通用多 provider 字典 { providers: { <路由>: {apiKeyEnv, api, baseURL, models} } }
 *   - llm-deepseek 官方 DeepSeek 平铺单段（非 providers 字典）
 * 旧 Manager 用 provider 类型当 adapter 名（llm-openai-compatible 等）写出 DSH 永不读取的段。
 * 统一归一化到 pi-ai：它支持 openai-completions / openai-responses / anthropic-messages。
 */
export const LLM_ADAPTER_MAP = {
  'openai': 'pi-ai',
  'openai-compatible': 'pi-ai',
  'azure': 'pi-ai',
  'ollama': 'pi-ai',
  'google': 'pi-ai',
  'anthropic': 'pi-ai',
  'custom': 'pi-ai',
  'claude': 'pi-ai',
  'deepseek': 'pi-ai',
  'pi-ai': 'pi-ai',
};

/** 提供商类型 → pi-ai 线路协议（默认 openai-completions）。 */
export const LLM_API_MAP = {
  'anthropic': 'anthropic-messages',
  'claude': 'anthropic-messages',
};

export class DSHConfig {
  constructor() {
    this.configPath = DSH_PATHS.settings;
    this.credPath = DSH_PATHS.credentials;
  }

  /**
   * 读取 DSH 配置
   * @returns {Promise<object>}
   */
  async read() {
    if (!existsSync(this.configPath)) {
      return { settings: {}, credentials: {} };
    }

    let settings = {};
    try {
      const content = readFileSync(this.configPath, 'utf-8');
      settings = this._parseYAML(content);
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.CONFIG_PARSE_ERROR,
        'settings 文件解析失败 (' + this.configPath + '): ' + error.message
      );
    }

    let credentials = {};
    if (existsSync(this.credPath)) {
      try {
        const credContent = readFileSync(this.credPath, 'utf-8');
        credentials = this._parseCredentials(credContent);
      } catch (error) {
        throw new DSHError(
          DSHErrorCodes.CONFIG_PARSE_ERROR,
          '凭据文件解析失败 (' + this.credPath + '): ' + error.message
        );
      }
    }

    return { settings, credentials };
  }

  /**
   * 写入 DSH 配置
   * @param {object} config - 配置对象
   * @param {string} [type] - 'settings' 或 'credentials'
   */
  async write(config, type = 'settings') {
    const filePath = type === 'credentials' ? this.credPath : this.configPath;
    const dir = dirname(filePath);

    // 写前结构校验
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new DSHError(
        DSHErrorCodes.INVALID_PARAMS,
        '写入内容必须为非数组对象，收到 ' + (config === null ? 'null' : typeof config)
      );
    }

    if (type === 'settings') {
      config = this._normalizeModels(config);
      const v = this.validateSettings(config);
      if (!v.ok) {
        throw new DSHError(
          DSHErrorCodes.CONFIG_VALIDATION_ERROR,
          '配置校验失败，已阻止写入：\n- ' + v.errors.join('\n- ')
        );
      }
    }
    // type === 'credentials' 只校验对象结构，不校验具体字段；
    // 一律写「版本化布局」（新版 DSH 要求顶层只有 version/refs/records，
    // 旧扁平布局会导致 dsh-credentials-local 拒绝启动）
    if (type === 'credentials') {
      config = this._wrapCredentialsVersioned(config);
    }

    const yaml = this._toYAML(config);

    // 保存当前磁盘内容，用于写后校验失败时自动回滚
    const diskContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;

    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 先备份现有文件
      if (diskContent !== null) {
        const backupPath = this._backupPath(filePath);
        copyFileSync(filePath, backupPath);
        this._pruneBackups(dir, filePath);
      }

      // 写入
      writeFileSync(filePath, yaml, 'utf-8');

      // 写后校验（settings 类型）：读回 + 结构校验 → 失败自动回滚
      if (type === 'settings') {
        try {
          const written = this._parseYAML(readFileSync(filePath, 'utf-8'));
          const v2 = this.validateSettings(written);
          if (!v2.ok) {
            throw new Error('写入后校验不通过:\n' + v2.errors.join('\n'));
          }
        } catch (verifyErr) {
          // 自动回滚到写前内容；若原文件不存在则删除刚写入的坏文件
          if (diskContent !== null) {
            try { writeFileSync(filePath, diskContent, 'utf-8'); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
          } else {
            try { rmSync(filePath, { force: true }); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
          }
          throw new DSHError(
            DSHErrorCodes.CONFIG_WRITE_VERIFY_ERROR,
            '配置写入后校验失败，已自动回滚至备份：\n' + verifyErr.message
          );
        }
      }
    } catch (error) {
      if (error instanceof DSHError) throw error;
      throw new DSHError(
        DSHErrorCodes.CONFIG_PARSE_ERROR,
        '配置写入失败: ' + error.message
      );
    }
  }

  /**
   * 获取配置项
   * @param {string} key - 点号分隔的键路径，如 'llm.provider'
   * @returns {Promise<any>}
   */
  async get(key) {
    const { settings } = await this.read();
    return this._getNested(settings, key);
  }

  /**
   * 设置配置项
   * @param {string} key - 点号分隔的键路径
   * @param {any} value
   */
  async set(key, value) {
    const { settings } = await this.read();
    this._setNested(settings, key, value);
    await this.write(settings);
  }

  /**
   * 删除配置项
   * @param {string} key - 点号分隔的键路径
   */
  async delete(key) {
    const { settings } = await this.read();
    if (this._deleteNested(settings, key)) {
      await this.write(settings);
    }
  }

  /**
   * 列出所有已配置的 LLM 提供商
   * 兼容两种配置形态：
   *   - 旧格式: settings.llm.<name> = { provider, model, apiKey, baseUrl }
   *   - DSH 官方格式: settings.llm-<adapter>.<providers>.<name> = { api, baseURL, models, apiKeyEnv }
   * @returns {Promise<Array<{name: string, provider: string, model: string, apiKeyEnv?: string}>>}
   */
  async listLLMProviders() {
    const { settings } = await this.read();
    const providers = [];
    
    // 旧格式 settings.llm.<name>
    const llm = settings.llm || {};
    for (const [name, config] of Object.entries(llm)) {
      if (config && typeof config === 'object') {
        providers.push({
          name,
          provider: config.provider || 'unknown',
          model: config.model || 'unknown',
        });
      }
    }

    // DSH 官方格式 settings.llm-<adapter>.providers.<name>
    for (const [adapter, adapterCfg] of Object.entries(settings)) {
      if (!/^llm-/.test(adapter) || !adapterCfg || typeof adapterCfg !== 'object') continue;
      const adapterProviders = adapterCfg.providers || {};
      for (const [name, config] of Object.entries(adapterProviders)) {
        if (config && typeof config === 'object') {
          const model = Array.isArray(config.models) && config.models[0]
            ? (config.models[0].id || config.models[0])
            : 'unknown';
          providers.push({
            name,
            provider: adapter,
            model,
            apiKeyEnv: config.apiKeyEnv || '',
          });
        }
      }
    }
    
    return providers;
  }

  /**
   * 列出所有已配置的 Agent Presets
   * @returns {Promise<Array<{id: string, name: string, path: string}>>}
   */
  async listAgentPresets() {
    const { settings } = await this.read();
    const presets = [];
    
    const agentPresets = settings['agent-presets'] || {};
    for (const [id, config] of Object.entries(agentPresets)) {
      // 兼容 DSH 官方格式：agent-presets.default = 'preset-id'（字符串）
      if (typeof config === 'string') {
        presets.push({ id, name: config, path: '', isDefaultRef: true });
      } else if (config && typeof config === 'object') {
        presets.push({
          id,
          name: config.name || id,
          path: config.path || '',
        });
      }
    }
    
    return presets;
  }

  /** @private */
  _getNested(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /** @private */
  _setNested(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  /** @private */
  _deleteNested(obj, path) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]] || typeof current[keys[i]] !== 'object') return false;
      current = current[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (current && last in current) {
      delete current[last];
      return true;
    }
    return false;
  }

  /**
   * 简易 YAML 解析器（兼容 dsh 格式，复用共享实现）
   * @private
   */
  _parseYAML(yaml) {
    return parseYAML(yaml);
  }

  /**
   * 简易 YAML 序列化（复用共享实现）
   * @private
   */
  _toYAML(obj, indent = 0) {
    return toYAML(obj, indent);
  }

  /**
   * 解析凭据文件内容，兼容两种布局：
   *  - 旧扁平布局：`KEY: value`（顶层即凭据引用名）
   *  - 新版版本化布局（DSH 官方）：`version: 1` + `refs:`（+ 可选 `records:`）
   * 内部统一返回扁平对象（引用名 → 字符串值），对调用方透明。
   * @param {string} content
   * @returns {object}
   * @private
   */
  _parseCredentials(content) {
    const parsed = this._parseYAML(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed || {};
    // 版本化布局：提取 refs（+ records 中的普通字符串值）
    if ('version' in parsed) {
      const flat = {};
      const refs = parsed.refs && typeof parsed.refs === 'object' ? parsed.refs : {};
      for (const [k, v] of Object.entries(refs)) {
        if (typeof v === 'string' && v.length > 0) flat[k] = v;
      }
      const records = parsed.records && typeof parsed.records === 'object' ? parsed.records : {};
      for (const [k, v] of Object.entries(records)) {
        if (typeof v === 'string' && v.length > 0) flat[k] = v;
      }
      return flat;
    }
    // 旧扁平布局：原样返回
    return parsed;
  }

  /**
   * 把扁平凭据对象包装为 DSH 新版版本化布局（`version: 1` + `refs:`）。
   * 新版 dsh-credentials-local 只接受顶层 `version`/`refs`/`records`，
   * 旧扁平布局会导致 DSH 启动即拒绝（unknown top-level key）。
   * @param {object} flat - 扁平凭据（引用名 → 字符串值）
   * @returns {object} 版本化布局对象
   * @private
   */
  _wrapCredentialsVersioned(flat) {
    const refs = {};
    for (const [k, v] of Object.entries(flat || {})) {
      if (k.startsWith('_comment') || k === '_order') continue;
      if (typeof v === 'string' && v.length > 0) refs[k] = v;
    }
    return { version: 1, refs };
  }

  /**
   * 迁移旧扁平布局的凭据文件为 DSH 新版版本化布局（启动 DSH 前调用）。
   * 旧文件先备份再重写，防止新版 DSH 因 unknown top-level key 拒绝启动。
   * @returns {Promise<{migrated: boolean, reason?: string, backup?: string, keys?: number}>}
   */
  async migrateCredentialsToVersioned() {
    if (!existsSync(this.credPath)) return { migrated: false, reason: 'no-file' };
    const content = readFileSync(this.credPath, 'utf-8');
    // ===== 结构判定：解析顶层键（行首无缩进的 KEY:）=====
    const lines = content.split('\n');
    const topKeys = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^[ \t]/.test(line)) continue; // 缩进行不是顶层
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      if (m) topKeys.push(m[1]);
    }
    const hasVersion = topKeys.includes('version');
    const illegalTop = topKeys.filter(k => k !== 'version' && k !== 'refs' && k !== 'records');
    // 已版本化：顶层仅 version/refs/records，且无残留扁平键
    if (hasVersion && illegalTop.length === 0) return { migrated: false, reason: 'already-versioned' };
    // 混搭布局：有 version 但顶层残留扁平键 → 将残留顶层键移入 refs（修复 DSH 启动崩溃）
    if (hasVersion && illegalTop.length > 0) {
      try {
        const backupPath = this._backupPath(this.credPath);
        copyFileSync(this.credPath, backupPath);
        this._pruneBackups(dirname(this.credPath), this.credPath);
        const out = ['version: 1', 'refs:'];
        let block = null;
        let orphan = [];
        const refsItems = [];
        const recordsItems = [];
        const comments = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          if (trimmed.startsWith('#')) { comments.push(line); continue; }
          const isIndented = /^[ \t]/.test(line);
          if (!isIndented) {
            const k = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
            if (k && k[1] === 'version') { block = 'version'; }
            else if (k && k[1] === 'refs') { block = 'refs'; }
            else if (k && k[1] === 'records') { block = 'records'; }
            else { block = null; orphan.push(line); }
          } else {
            if (block === 'refs') refsItems.push(line);
            else if (block === 'records') recordsItems.push(line);
            else orphan.push(line);
          }
        }
        for (const item of refsItems) out.push(item);
        for (const o of orphan) { const t = o.trim(); if (t && !t.startsWith('#')) out.push('  ' + t); }
        if (recordsItems.length > 0) { out.push('records:'); for (const i of recordsItems) out.push(i); }
        if (comments.length) out.push('');
        for (const c of comments) out.push(c);
        writeFileSync(this.credPath, out.join('\n') + '\n', 'utf-8');
        return { migrated: true, reason: 'mixed-layout', backup: backupPath, keys: illegalTop.length };
      } catch (e) {
        return { migrated: false, reason: 'write-error', error: e.message };
      }
    }
    // ===== 纯扁平布局：整体迁移 =====
    // 有 version 键但值不是 1 → 不自动处理，避免破坏其它版本布局
    if (/^version:/m.test(content)) return { migrated: false, reason: 'version-mismatch' };
    // 文本级兜底迁移（与 DSH 官方 renderFlatLayoutMigration 逐字节一致）：
    // 不解析 YAML 值，只把每一行缩进 2 空格包进 refs:，值原样保留（含特殊字符/注释/空行）
    // 先做安全检查：扁平布局的每行顶层应是「POSIX 名: 非空值」，否则不迁移（避免破坏非扁平内容）
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('-') || trimmed.startsWith('%') || trimmed.startsWith('---') || trimmed.startsWith('...')) {
        return { migrated: false, reason: 'not-flat-layout', line: trimmed.slice(0, 40) };
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*)?$/.exec(trimmed);
      if (!m) return { migrated: false, reason: 'not-flat-layout', line: trimmed.slice(0, 40) };
      if (m[1] === 'version') return { migrated: false, reason: 'version-mismatch' };
      if (!m[2]) return { migrated: false, reason: 'empty-value', key: m[1] };
    }
    // 执行迁移：备份原文件 → 逐行缩进 → 写入版本化布局
    try {
      const backupPath = this._backupPath(this.credPath);
      copyFileSync(this.credPath, backupPath);
      this._pruneBackups(dirname(this.credPath), this.credPath);
      const body = lines.map(l => (l.length === 0 ? l : '  ' + l)).join('\n');
      const migrated = 'version: 1\nrefs:\n' + body + (content.endsWith('\n') ? '' : '\n');
      writeFileSync(this.credPath, migrated, 'utf-8');
      const keys = lines.filter(l => /^\S[^:]*:\s*\S/.test(l.trim())).length;
      return { migrated: true, backup: backupPath, keys };
    } catch (e) {
      return { migrated: false, reason: 'write-error', error: e.message };
    }
  }

  // ====== 配置校验与备份 ======

  /**
   * 校验 settings 对象结构（DSH 官方格式），重点检查 llm-* 提供商的 models 列表。
   * @param {object} settings
   * @returns {{ok: boolean, errors: string[]}}
   */
  validateSettings(settings) {
    const errors = [];
    for (const [adapter, adapterCfg] of Object.entries(settings || {})) {
      if (!/^llm-/.test(adapter)) continue;
      if (!adapterCfg || typeof adapterCfg !== 'object') {
        errors.push('[' + adapter + '] 应为对象');
        continue;
      }
      const providers = adapterCfg.providers;
      if (providers === undefined) continue;
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
        errors.push('[' + adapter + '.providers] 应为对象映射');
        continue;
      }
      for (const [name, pcfg] of Object.entries(providers)) {
        if (!pcfg || typeof pcfg !== 'object') {
          errors.push('[' + adapter + '.providers.' + name + '] 提供商配置应为对象');
          continue;
        }
        if (Array.isArray(pcfg.models)) {
          pcfg.models.forEach(function(m, i) {
            if (typeof m === 'string') {
              errors.push('[' + adapter + '.providers.' + name + '.models[' + i + ']] 模型项格式错误：应为对象（- id: xxx），当前为字符串 "' + m + '"');
            } else if (!m || typeof m !== 'object') {
              errors.push('[' + adapter + '.providers.' + name + '.models[' + i + ']] 模型项应为对象');
            } else if (m.id === undefined || m.id === null || m.id === '') {
              errors.push('[' + adapter + '.providers.' + name + '.models[' + i + ']] 模型项缺少 id 字段');
            }
          });
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * 自动修复：将字符串形态的模型项转为 { id: xxx } 对象形态
   * @private
   */
  _normalizeModels(settings) {
    for (const [adapter, adapterCfg] of Object.entries(settings || {})) {
      if (!/^llm-/.test(adapter) || !adapterCfg || typeof adapterCfg !== 'object') continue;
      const providers = adapterCfg.providers;
      if (!providers || typeof providers !== 'object') continue;
      for (const [name, pcfg] of Object.entries(providers)) {
        if (!pcfg || typeof pcfg !== 'object') continue;
        if (Array.isArray(pcfg.models)) {
          pcfg.models = pcfg.models.map(function(m) {
            if (typeof m === 'string') {
              const s = m.trim();
              const m2 = /^id\s*:\s*(.+)$/.exec(s);
              return { id: m2 ? m2[1].trim() : s };
            }
            return m;
          });
        }
      }
    }
    return settings;
  }

  /**
   * 生成备份文件路径：settings.yaml.bak-<YYYYMMDD-HHmmss>
   * @private
   */
  _backupPath(filePath) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + String(d.getMilliseconds()).padStart(3, '0');
    return filePath + '.bak-' + ts;
  }

  /**
   * 清理旧备份，保留最近 MAX 个
   * @private
   */
  _pruneBackups(dir, filePath) {
    const MAX = 10;
    try {
      const prefix = filePath.split(/[/\\]/).pop();
      const entries = readdirSync(dir);
      const backups = entries.filter(f => f.startsWith(prefix + '.bak-')).sort().reverse();
      for (let i = MAX; i < backups.length; i++) {
        rmSync(join(dir, backups[i]), { force: true });
      }
    } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
  }

  /**
   * 列出所有配置备份
   * @param {string} [type] - 'settings' 或 'credentials'
   * @returns {Promise<Array<{name: string, path: string, mtime: number, size: number}>>}
   */
  async listBackups(type) {
    type = type || 'settings';
    const filePath = type === 'credentials' ? this.credPath : this.configPath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) return [];
    try {
      const prefix = filePath.split(/[/\\]/).pop();
      return readdirSync(dir).filter(f => f.startsWith(prefix + '.bak-')).map(f => {
        const full = join(dir, f);
        const st = statSync(full);
        return { name: f, path: full, mtime: st.mtimeMs, size: st.size };
      }).sort((a, b) => b.mtime - a.mtime);
    } catch (e) { return []; }
  }

  /**
   * 创建配置备份
   * @param {string} [reason] - 备份原因标记
   * @returns {Promise<{name: string, path: string}>}
   */
  async createBackup(reason) {
    // reason 参数保留供扩展使用（当前未在备份名中体现）
    const filePath = this.configPath;
    if (!existsSync(filePath)) {
      throw new DSHError(DSHErrorCodes.NOT_FOUND, '配置文件不存在，无法备份');
    }
    const backupPath = this._backupPath(filePath);
    copyFileSync(filePath, backupPath);
    const dir = dirname(filePath);
    this._pruneBackups(dir, filePath);
    return { name: backupPath.split(/[/\\]/).pop(), path: backupPath };
  }

  /**
   * 从备份还原配置
   * @param {string|number} nameOrIndex - 备份文件名或索引（0=最新）
   * @returns {Promise<{success: boolean, name: string, path: string}>}
   */
  async restoreBackup(nameOrIndex) {
    const filePath = this.configPath;
    const backups = await this.listBackups('settings');
    const target = backups.find(b => b.name === nameOrIndex || b.path === nameOrIndex);
    if (!target && /^\d+$/.test(String(nameOrIndex))) {
      const idx = Number(nameOrIndex);
      target = backups[idx];
    }
    if (!target) {
      throw new DSHError(DSHErrorCodes.NOT_FOUND, '未找到备份: ' + nameOrIndex);
    }
    // 还原前先备份当前文件
    let prePath = null;
    if (existsSync(filePath)) {
      prePath = filePath + '.bak-pre-restore-' + Date.now();
      copyFileSync(filePath, prePath);
    }
    // 执行还原
    copyFileSync(target.path, filePath);
    // 校验还原内容
    try {
      let restored = this._parseYAML(readFileSync(filePath, 'utf-8'));
      restored = this._normalizeModels(restored);
      const v = this.validateSettings(restored);
      if (!v.ok) {
        // 自动修复：将字符串模型转为对象后重写
        const yaml = this._toYAML(restored);
        writeFileSync(filePath, yaml, 'utf-8');
        // 再次校验
        restored = this._parseYAML(readFileSync(filePath, 'utf-8'));
        const v2 = this.validateSettings(restored);
        if (!v2.ok) {
          // 修复后仍失败 → 回滚
          if (prePath) {
            try { copyFileSync(prePath, filePath); rmSync(prePath, { force: true }); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
          }
          throw new DSHError(DSHErrorCodes.CONFIG_VALIDATION_ERROR, '还原失败：备份内容校验不通过，已回滚\n' + v2.errors.join('\n'));
        }
      }
    } catch (e) {
      if (e instanceof DSHError) throw e;
      // 解析失败 → 回滚
      if (prePath) {
        try { copyFileSync(prePath, filePath); rmSync(prePath, { force: true }); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
      }
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '还原失败：备份文件解析失败，已回滚');
    }
    // 清理 restore 前备份
    if (prePath) { try { rmSync(prePath, { force: true }); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); } }
    return { success: true, name: target.name, path: target.path };
  }

  /**
   * 校验当前配置并返回错误列表
   * @returns {Promise<{ok: boolean, errors: string[]}>}
   */
  async checkConfig() {
    try {
      const content = readFileSync(this.configPath, 'utf-8');
      let settings = this._parseYAML(content);
      // 自动修复模型格式
      settings = this._normalizeModels(settings);
      return this.validateSettings(settings);
    } catch (e) {
      return { ok: false, errors: ['读取或解析失败: ' + e.message] };
    }
  }


  /**
   * 保存 LLM 提供商（DSH 官方格式：settings.llm-<adapter>.providers.<name>）
   *
   * 官方规范（dsh-base cordis.patch.yml / dsh-credentials-local）：
   *   - settings.llm-<adapter>.providers.<name> = { apiKeyEnv, api, baseURL, models }
   *   - `apiKeyEnv` 只保存「凭据引用名」（环境变量名 / .credentials.yaml 键名），
   *     密钥值一律存于 $DSH_HOME/.credentials.yaml（provider-managed, writable），
   *     DSH 按引用名逐请求解析，绝不明文落盘到 settings.yaml。
   * 因此：
   *   - 传入 `config.apiKeyEnv`（env:XXX 或裸 XXX）→ 直接作为引用名；
   *   - 传入明文 `config.apiKey` → 生成引用名并写入 .credentials.yaml，
   *     settings 中仅存引用名，避免"把明文密钥当环境变量名"导致模型不可用。
   * @param {string} name - 提供商名称（路由键）
   * @param {object} config - { provider, model, apiKey?, apiKeyEnv?, baseUrl?, models? }
   * @param {string} [adapter] - LLM 适配器名称，默认取 provider
   * @returns {Promise<object>}
   */
  async saveLLMProvider(name, config, adapter) {
    if (!name || !config) throw new DSHError(DSHErrorCodes.INVALID_PARAMS, "名称和配置不能为空");
    // 先迁移历史错误命名空间（llm-openai-compatible 等 DSH 不读的段）到 llm-pi-ai
    try { await this.migrateLLMProviders(); } catch (migErr) { console.warn('[dsh-manager] migrateLLMProviders:', migErr?.message); }
    const { settings, credentials } = await this.read();
    // DSH alpha4 只有 llm-pi-ai（通用多 provider）/ llm-deepseek（平铺单段）两个真 adapter；
    // Manager 的「提供商类型」全部归一化为 pi-ai，避免写出 DSH 永不读取的命名空间
    const providerType = String(adapter || config.provider || 'pi-ai').toLowerCase();
    const adapterName = LLM_ADAPTER_MAP[providerType] || 'pi-ai';
    const llmKey = "llm-" + adapterName;
    if (!settings[llmKey]) settings[llmKey] = { providers: {} };
    if (!settings[llmKey].providers) settings[llmKey].providers = {};

    // —— 密钥解析：只允许「引用名」进入 settings，明文一律进凭据文件 ——
    let apiKeyEnv = "";
    if (config.apiKeyEnv) {
      // 显式环境变量引用：env:XXX 或裸 XXX
      apiKeyEnv = String(config.apiKeyEnv).replace(/^env:\s*/i, '').trim();
    } else if (config.apiKey) {
      const rawKey = String(config.apiKey).trim();
      if (rawKey.startsWith('env:')) {
        // 前端以 env:XXX 形式提交 → 环境变量引用
        apiKeyEnv = rawKey.slice(4).trim();
      } else if (rawKey) {
        // 明文密钥 → 生成稳定引用名并写入凭据文件
        apiKeyEnv = this._credentialKeyFor(name);
        credentials[apiKeyEnv] = rawKey;
        await this.write(credentials, 'credentials');
      }
    }
    if (!apiKeyEnv && !config.apiKey) {
      // 无密钥提供商（如本地 ollama）允许 apiKeyEnv 为空
      apiKeyEnv = config.apiKeyEnv || "";
    }

    const baseURL = String(config.baseUrl || config.baseURL || "").trim();
    // pi-ai 的 resolveProfiles 对空 baseURL 抛错 → 整个 llm-pi-ai 段被 DSH 拒绝；
    // 这里直接拦下，避免写出 DSH 不读取的死配置
    if (!baseURL) {
      throw new DSHError(DSHErrorCodes.INVALID_PARAMS, '请填写 API Base URL（pi-ai 适配器要求非空，否则 DSH 会拒绝整段配置）');
    }
    const models = Array.isArray(config.models) && config.models.length > 0
      ? config.models.map(m => {
          const id = typeof m === 'string' ? m : (m && (m.id || m.model)) || '';
          if (!id) return null;
          // 只保留 pi-ai modelProfile 认识的字段（id/name），ownedBy 等未知字段可能被拒；
          // input 字段用于声明模型模态（text/image）——缺少 image 声明时 DSH 会在发送前
          // 拒绝图片（MODEL_DOES_NOT_SUPPORT_IMAGES），导致"图片无法上传/识别"。
          const out = { id };
          if (m && typeof m === 'object') {
            if (m.name) out.name = String(m.name);
            const input = m.input || m.modalities;
            if (Array.isArray(input) && input.length > 0) {
              const valid = input.map(x => String(x).trim()).filter(x => x === 'text' || x === 'image');
              if (valid.length > 0) out.input = valid;
            }
          }
          return out;
        }).filter(Boolean)
      : [{ id: String(config.model || 'gpt-4o').trim() }];
    const providerConfig = {
      api: LLM_API_MAP[providerType] || "openai-completions",
      baseURL,
      models,
    };
    // apiKeyEnv 为空时省略字段：pi-ai 的 credentialRef("") 会抛 TypeError，
    // 使 assertServiceable 失败并拒绝整个 llm-pi-ai 段
    if (apiKeyEnv) providerConfig.apiKeyEnv = apiKeyEnv;
    settings[llmKey].providers[name] = providerConfig;
    await this.write(settings);
    return { success: true, name, adapter: adapterName, key: llmKey, apiKeyEnv, baseURL };
  }

  /**
   * 迁移历史错误命名空间（llm-openai-compatible / llm-openai / llm-anthropic 等
   * DSH alpha4 不存在的 adapter 段）到 llm-pi-ai.providers，并清理空段；
   * 同时「就地清洗」已经位于 llm-pi-ai / llm-deepseek 下的条目
   * （apiKeyEnv:"" 会让 DSH 的 credentialRef("") 抛错并整段拒绝、空 baseURL 会让
   * resolveProfiles 抛错、provider/apiKey 未知字段会触发 rejectRemovedFields）。
   * DSH alpha4 只读取 llm-pi-ai（providers 字典）与 llm-deepseek（平铺单段）。
   * @returns {Promise<{moved: number, cleaned: string[], normalized: number}>}
   */
  /**
   * 启发式判断模型名是否为视觉模型（支持图片输入）。
   * DSH 发送前按模型 input 检查图片支持；视觉模型需声明 input 含 image，
   * 否则上传图片报 MODEL_DOES_NOT_SUPPORT_IMAGES（"当前模型不支持图片"）。
   */
  static isVisionModelName(id) {
    const n = String(id || '').toLowerCase();
    if (!n) return false;
    if (n.includes('vision') || n.includes('visual')) return true;
    if (n.includes('-vl') || n.includes('.vl') || n.startsWith('vl')) return true;
    if (/(^|[-\d])[45]v($|[-_])/.test(n)) return true; // glm-5v / glm-4v
    if (n.includes('omni')) return true;
    if (n.includes('-4o') || n === 'gpt-4o') return true;
    if (n.includes('gemini')) return true;
    if (n.includes('llava') || n.includes('minicpm') || n.includes('internvl')) return true;
    return false;
  }

  async migrateLLMProviders() {
    const { settings } = await this.read();
    const INVALID_PREFIXES = ['llm-openai', 'llm-openai-compatible', 'llm-azure', 'llm-ollama', 'llm-google', 'llm-anthropic', 'llm-custom', 'llm-openai-responses', 'llm-claude'];
    const target = 'llm-pi-ai';
    let moved = 0;
    const cleaned = [];
    let normalized = 0;

    // —— 清洗单个 pi-ai provider 条目 ——
    // DSH alpha4 dsh-llm-pi-ai：apiKeyEnv 空串会在 credentialRef("") 抛 TypeError、
    // baseURL 空串在 resolveProfiles 抛错 → assertServiceable 失败 → 整个 llm-pi-ai 段被拒。
    // provider/apiKey 等未知字段同样会触发 rejectRemovedFields。models 非必填，存在才清洗。
    const cleanPiEntry = (pconf) => {
      if (!pconf || typeof pconf !== 'object') return null;
      const clean = { ...pconf };
      if (!clean.apiKeyEnv) delete clean.apiKeyEnv;   // credentialRef("") 抛错 → 整段拒绝
      delete clean.provider;                            // pi-ai rejectRemovedFields 拒 provider 字段
      delete clean.apiKey;                              // 明文密钥不进 settings（应存凭据文件）
      const b = String(clean.baseURL || '').trim();
      if (!b) return null;                              // 空 baseURL → 该条不可服务，直接丢弃
      clean.baseURL = b;
      clean.api = clean.api || 'openai-completions';
      if (Array.isArray(clean.models)) {
        clean.models = clean.models.map(m => {
          const id = typeof m === 'string' ? m : (m && (m.id || m.model)) || '';
          if (!id) return null;
          const out = { id };
          if (m && typeof m === 'object') {
            if (m.name) out.name = String(m.name);
            // 保留声明的 input（text/image），并给视觉模型自动补 input 含 image——
            // 否则 DSH 发送前按模型 input 检查图片，报"当前模型不支持图片"。
            const declared = Array.isArray(m.input) ? m.input.map(x => String(x).trim()).filter(x => x === 'text' || x === 'image') : [];
            if (declared.length > 0) out.input = declared;
            else if (DSHConfig.isVisionModelName(id)) out.input = ['text', 'image'];
          }
          return out;
        }).filter(Boolean);
        if (clean.models.length === 0) delete clean.models;
      }
      return clean;
    };

    // 第一遍：迁移历史错误命名空间（llm-openai-compatible 等 DSH 不读的段）
    for (const key of Object.keys(settings || {})) {
      const isInvalid = key === 'llm-openai' || INVALID_PREFIXES.some(p => key.startsWith(p));
      if (!isInvalid) continue;
      const section = settings[key];
      if (!section || typeof section !== 'object') { delete settings[key]; cleaned.push(key); continue; }
      const providers = section.providers;
      if (!providers || typeof providers !== 'object' || Object.keys(providers).length === 0) {
        delete settings[key]; cleaned.push(key); continue;
      }
      if (!settings[target]) settings[target] = { providers: {} };
      if (!settings[target].providers) settings[target].providers = {};
      for (const [pname, pconf] of Object.entries(providers)) {
        const clean = cleanPiEntry(pconf);
        if (!clean) continue;
        if (!settings[target].providers[pname]) { settings[target].providers[pname] = clean; moved++; }
      }
      if (Object.keys(settings[target].providers).length > 0) {
        delete settings[key]; cleaned.push(key);
      } else if (settings[target] && Object.keys(settings[target].providers).length === 0) {
        // 迁移后 llm-pi-ai 为空 → 一并删除
        delete settings[target]; cleaned.push(target);
      }
    }

    // —— 第二遍：就地清洗「已经位于 llm-pi-ai 下」的条目 ——
    // 用户配置可能早已是正确命名空间，但带 apiKeyEnv:"" / provider 字段 / 空 baseURL 等脏数据，
    // 第一遍迁移循环不会碰它，而 DSH 仍会整段拒绝 → 必须就地归一化。
    const piSection = settings[target];
    if (piSection && typeof piSection === 'object') {
      if (!piSection.providers || typeof piSection.providers !== 'object') {
        delete settings[target]; cleaned.push(target);
      } else {
        for (const [pname, pconf] of Object.entries(piSection.providers)) {
          const clean = cleanPiEntry(pconf);
          if (!clean) { delete piSection.providers[pname]; normalized++; continue; }
          if (JSON.stringify(clean) !== JSON.stringify(pconf)) {
            piSection.providers[pname] = clean;
            normalized++;
          }
        }
        if (Object.keys(piSection.providers).length === 0) {
          delete settings[target]; cleaned.push(target);
        }
      }
    }

    // —— llm-deepseek 官方平铺单段：同样清理空 apiKeyEnv / 明文密钥 / models 形态 ——
    const ds = settings['llm-deepseek'];
    if (ds && typeof ds === 'object') {
      if (!ds.apiKeyEnv) { delete ds.apiKeyEnv; normalized++; }
      if (ds.apiKey) { delete ds.apiKey; normalized++; }
      if (Array.isArray(ds.models)) {
        const cleanedModels = ds.models.map(m => {
          const id = typeof m === 'string' ? m : (m && (m.id || m.model)) || '';
          if (!id) return null;
          const out = { id };
          if (m && typeof m === 'object' && m.name) out.name = String(m.name);
          return out;
        }).filter(Boolean);
        ds.models = cleanedModels;
        normalized++;
      }
    }

    if (moved || cleaned.length || normalized) await this.write(settings);
    return { moved, cleaned, normalized };
  }

  /**
   * 由提供商名称生成稳定的凭据引用名（大写、字母数字，避免与现有键冲突）
   * @param {string} name
   * @returns {string} 如 "LLM_MY_PROVIDER_API_KEY"
   * @private
   */
  _credentialKeyFor(name) {
    const stem = String(name || 'provider')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    return (stem ? stem + '_' : '') + 'API_KEY';
  }

  /**
   * 删除 LLM 提供商（兼容旧格式和官方格式）
   * @param {string} name - 提供商名称
   * @returns {Promise<object>}
   */
  async removeLLMProvider(name) {
    if (!name) throw new DSHError(DSHErrorCodes.INVALID_PARAMS, "名称不能为空");
    const { settings } = await this.read();
    // 从旧格式删除
    if (settings.llm && settings.llm[name]) {
      delete settings.llm[name];
      await this.write(settings);
      return { success: true, from: "legacy" };
    }
    // 从官方格式删除（遍历所有 llm-<adapter>）
    for (const [adapter, adapterCfg] of Object.entries(settings)) {
      if (!/^llm-/.test(adapter) || !adapterCfg || typeof adapterCfg !== "object") continue;
      if (adapterCfg.providers && adapterCfg.providers[name]) {
        delete adapterCfg.providers[name];
        if (Object.keys(adapterCfg.providers).length === 0) {
          delete settings[adapter];
        }
        await this.write(settings);
        return { success: true, from: "official", adapter };
      }
    }
    throw new DSHError(DSHErrorCodes.NOT_FOUND, "提供商 " + name + " 不存在");
  }

  // ====== LLM 能力路由（按能力自动切换模型） ======

  /**
   * 读取能力路由配置（manager.llm-routing）
   * 能力路由是 DSH Manager 自己的配置层，引用 DSH 已配置的 llm-<adapter>.providers，
   * 不改动 providers 结构。能力：semantic(语义) / vision(识图) / image(生图) / code(代码) / embedding(嵌入)。
   * @returns {Promise<object>} { enabled, defaultCapability, capabilities }
   */
  async getLLMRouting() {
    const { settings } = await this.read();
    // 优先读 DSH 能力路由插件可读的 settings 段 capability-router（热加载）。
    // 旧版本把配置写在 manager.llm-routing（Manager 私有层，DSH 不读），作为迁移回退。
    const cfg = (settings && settings['capability-router'] && typeof settings['capability-router'] === 'object')
      ? settings['capability-router']
      : ((settings.manager && settings.manager['llm-routing']) || {});
    return {
      enabled: cfg.enabled !== false,
      defaultCapability: cfg.defaultCapability || 'semantic',
      capabilities: (cfg.capabilities && typeof cfg.capabilities === 'object') ? cfg.capabilities : {},
    };
  }

  /**
   * 保存能力路由配置
   * @param {object} routing - { enabled, defaultCapability, capabilities }
   * @returns {Promise<object>}
   */
  async saveLLMRouting(routing) {
    if (!routing || typeof routing !== 'object') throw new DSHError(DSHErrorCodes.INVALID_PARAMS, '能力路由配置不能为空');
    const { settings } = await this.read();
    if (!settings.manager) settings.manager = {};
    const clean = {
      enabled: routing.enabled !== false,
      defaultCapability: routing.defaultCapability || 'semantic',
      capabilities: {},
    };
    const caps = (routing.capabilities && typeof routing.capabilities === 'object') ? routing.capabilities : {};
    for (const [cap, spec] of Object.entries(caps)) {
      if (spec && typeof spec === 'object' && spec.provider && spec.model) {
        clean.capabilities[cap] = { provider: String(spec.provider), model: String(spec.model) };
      }
    }
    // 双写：DSH 能力路由插件读 settings.capability-router（热加载生效）；
    // manager.llm-routing 保留作为旧版 Manager UI 的兼容回退
    settings['capability-router'] = clean;
    settings.manager['llm-routing'] = clean;
    await this.write(settings);
    return { success: true, ...clean };
  }

  /**
   * 收集所有已配置 provider 的可用模型（供能力路由 UI 下拉）
   * 只读 DSH 官方格式 llm-<adapter>.providers.<name>.models
   * @returns {Promise<Array<{provider: string, model: string, apiKeyEnv: string, baseURL: string, adapter: string}>>}
   */
  async listCapabilityModels() {
    const { settings } = await this.read();
    const out = [];
    for (const [adapter, adapterCfg] of Object.entries(settings || {})) {
      if (!/^llm-/.test(adapter) || !adapterCfg || typeof adapterCfg !== 'object') continue;
      const adapterName = adapter.replace(/^llm-/, '');
      for (const [name, conf] of Object.entries(adapterCfg.providers || {})) {
        if (!conf || typeof conf !== 'object') continue;
        const models = Array.isArray(conf.models) ? conf.models : [];
        if (models.length === 0 && conf.model) models.push({ id: conf.model });
        for (const m of models) {
          const id = (typeof m === 'string' ? m : m.id) || '';
          if (!id) continue;
          out.push({
            provider: adapterName,
            providerKey: name,
            model: id,
            apiKeyEnv: conf.apiKeyEnv || '',
            baseURL: conf.baseURL || '',
            adapter,
          });
        }
      }
    }
    return out;
  }

  /**
   * 把某能力路由应用为 DSH 默认模型（写入 DSH 原生读取的 agent-default-model）
   * DSH 的 dsh-agent-default-model 服务读取 settings 的 agent-default-model 分节，
   * 新建 Agent / 会话时使用该 provider+model，因此此改动真实生效。
   * @param {string} capability - 能力名（semantic/vision/image/code/embedding）
   * @returns {Promise<object>} { success, provider, model }
   */
  async applyDefaultModel(capability) {
    const routing = await this.getLLMRouting();
    const spec = routing.capabilities[capability];
    if (!spec || !spec.provider || !spec.model) {
      throw new DSHError(DSHErrorCodes.NOT_FOUND, '能力 "' + capability + '" 未配置模型');
    }
    // 校验 provider(路由id)/model 真实存在
    const all = await this.listCapabilityModels();
    const found = all.some(x => x.providerKey === spec.provider && x.model === spec.model);
    if (!found) {
      throw new DSHError(DSHErrorCodes.INVALID_PARAMS, 'provider="' + spec.provider + '" 的模型 "' + spec.model + '" 不存在，请先在 LLM 提供商中配置');
    }
    const { settings } = await this.read();
    settings['agent-default-model'] = { provider: spec.provider, model: spec.model };
    await this.write(settings);
    return { success: true, provider: spec.provider, model: spec.model, capability };
  }

  /**
   * 校验并解析一个能力应使用的 provider/model
   * 供外部（DSH 插件 / API / 测试）调用：给定能力名，返回真实的 provider/model/apiKeyEnv/baseURL。
   * @param {string} capability - 能力名
   * @returns {Promise<object>} { capability, provider, model, apiKeyEnv, baseURL } 或抛错
   */
  async resolveCapability(capability) {
    const routing = await this.getLLMRouting();
    const spec = routing.capabilities[capability] || routing.capabilities[routing.defaultCapability];
    if (!spec || !spec.provider || !spec.model) {
      throw new DSHError(DSHErrorCodes.NOT_FOUND, '能力 "' + capability + '" 未配置模型，请先在设置中配置能力路由');
    }
    const all = await this.listCapabilityModels();
    const match = all.find(x => x.providerKey === spec.provider && x.model === spec.model);
    if (!match) {
      throw new DSHError(DSHErrorCodes.INVALID_PARAMS, 'provider="' + spec.provider + '" 的模型 "' + spec.model + '" 不存在');
    }
    return { capability, provider: spec.provider, model: spec.model, apiKeyEnv: match.apiKeyEnv, baseURL: match.baseURL };
  }
}