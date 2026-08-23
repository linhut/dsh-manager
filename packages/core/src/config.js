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

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const settings = this._parseYAML(content);
      
      let credentials = {};
      if (existsSync(this.credPath)) {
        const credContent = readFileSync(this.credPath, 'utf-8');
        credentials = this._parseYAML(credContent);
      }

      return { settings, credentials };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.CONFIG_PARSE_ERROR,
        `配置解析失败: ${error.message}`
      );
    }
  }

  /**
   * 写入 DSH 配置
   * @param {object} config - 配置对象
   * @param {string} [type] - 'settings' 或 'credentials'
   */
  async write(config, type = 'settings') {
    const filePath = type === 'credentials' ? this.credPath : this.configPath;
    const dir = dirname(filePath);

    // 写前结构校验（settings 专属） + 自动修复字符串模型项
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
          // 自动回滚到写前内容
          if (diskContent !== null) {
            try { writeFileSync(filePath, diskContent, 'utf-8'); } catch {}
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
              var s = m.trim();
              var m2 = /^id\s*:\s*(.+)$/.exec(s);
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
    var d = new Date();
    var p = function(n) { return String(n).padStart(2, '0'); };
    var ts = d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return filePath + '.bak-' + ts;
  }

  /**
   * 清理旧备份，保留最近 MAX 个
   * @private
   */
  _pruneBackups(dir, filePath) {
    const MAX = 10;
    try {
      var prefix = filePath.split(/[/\\]/).pop();
      var entries = readdirSync(dir);
      var backups = entries.filter(function(f) { return f.startsWith(prefix + '.bak-'); }).sort().reverse();
      for (var i = MAX; i < backups.length; i++) {
        rmSync(join(dir, backups[i]), { force: true });
      }
    } catch (e) {}
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
      var prefix = filePath.split(/[/\\]/).pop();
      return readdirSync(dir).filter(function(f) { return f.startsWith(prefix + '.bak-'); }).map(function(f) {
        var full = join(dir, f);
        var st = statSync(full);
        return { name: f, path: full, mtime: st.mtimeMs, size: st.size };
      }).sort(function(a, b) { return b.mtime - a.mtime; });
    } catch (e) { return []; }
  }

  /**
   * 创建配置备份
   * @param {string} [reason] - 备份原因标记
   * @returns {Promise<{name: string, path: string}>}
   */
  async createBackup(reason) {
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
    var target = backups.find(function(b) { return b.name === nameOrIndex || b.path === nameOrIndex; });
    if (!target && /^\d+$/.test(String(nameOrIndex))) {
      var idx = Number(nameOrIndex);
      target = backups[idx];
    }
    if (!target) {
      throw new DSHError(DSHErrorCodes.NOT_FOUND, '未找到备份: ' + nameOrIndex);
    }
    // 还原前先备份当前文件
    var prePath = null;
    if (existsSync(filePath)) {
      prePath = filePath + '.bak-pre-restore-' + Date.now();
      copyFileSync(filePath, prePath);
    }
    // 执行还原
    copyFileSync(target.path, filePath);
    // 校验还原内容
    try {
      var restored = this._parseYAML(readFileSync(filePath, 'utf-8'));
      restored = this._normalizeModels(restored);
      var v = this.validateSettings(restored);
      if (!v.ok) {
        // 自动修复：将字符串模型转为对象后重写
        var yaml = this._toYAML(restored);
        writeFileSync(filePath, yaml, 'utf-8');
        // 再次校验
        restored = this._parseYAML(readFileSync(filePath, 'utf-8'));
        var v2 = this.validateSettings(restored);
        if (!v2.ok) {
          // 修复后仍失败 → 回滚
          if (prePath) {
            try { copyFileSync(prePath, filePath); rmSync(prePath, { force: true }); } catch {}
          }
          throw new DSHError(DSHErrorCodes.CONFIG_VALIDATION_ERROR, '还原失败：备份内容校验不通过，已回滚\n' + v2.errors.join('\n'));
        }
      }
    } catch (e) {
      if (e instanceof DSHError) throw e;
      // 解析失败 → 回滚
      if (prePath) {
        try { copyFileSync(prePath, filePath); rmSync(prePath, { force: true }); } catch {}
      }
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '还原失败：备份文件解析失败，已回滚');
    }
    // 清理 restore 前备份
    if (prePath) { try { rmSync(prePath, { force: true }); } catch {} }
    return { success: true, name: target.name, path: target.path };
  }

  /**
   * 校验当前配置并返回错误列表
   * @returns {Promise<{ok: boolean, errors: string[]}>}
   */
  async checkConfig() {
    try {
      var content = readFileSync(this.configPath, 'utf-8');
      var settings = this._parseYAML(content);
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
    const { settings, credentials } = await this.read();
    const adapterName = adapter || config.provider || "openai";
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

    const providerConfig = {
      apiKeyEnv,
      api: "openai-completions",
      baseURL: config.baseUrl || "",
      models: Array.isArray(config.models) && config.models.length > 0
        ? config.models.map(m => typeof m === "string" ? { id: m } : { id: m.id || m })
        : [{ id: config.model || "gpt-4o" }],
    };
    settings[llmKey].providers[name] = providerConfig;
    await this.write(settings);
    return { success: true, name, adapter: adapterName, key: llmKey, apiKeyEnv };
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

}