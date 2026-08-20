/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
    const yaml = this._toYAML(config);
    
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // 原子写入（带 .bak 备份）：先备份，再写入，确保写操作不损坏原文件
      if (existsSync(filePath)) {
        const backupPath = filePath + '.bak-' + Date.now();
        copyFileSync(filePath, backupPath);
        // 清理旧备份（保留最近 5 个）
        try {
          const dirEntries = readdirSync(dir);
          const prefix = filePath.split(/[/\\]/).pop();
          const backups = dirEntries
            .filter(f => f.startsWith(prefix + '.bak-'))
            .sort()
            .reverse();
          for (let i = 5; i < backups.length; i++) {
            rmSync(join(dir, backups[i]), { force: true });
          }
        } catch {}
      }
      writeFileSync(filePath, yaml, 'utf-8');
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.CONFIG_PARSE_ERROR,
        `配置写入失败: ${error.message}`
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
   * 保存 LLM 提供商（DSH 官方格式：settings.llm-<adapter>.providers.<name>）
   * @param {string} name - 提供商名称（路由键）
   * @param {object} config - { provider, model, apiKey?, baseUrl?, models? }
   * @param {string} [adapter] - LLM 适配器名称，默认取 provider
   * @returns {Promise<object>}
   */
  async saveLLMProvider(name, config, adapter) {
    if (!name || !config) throw new DSHError(DSHErrorCodes.INVALID_PARAMS, "名称和配置不能为空");
    const { settings } = await this.read();
    const adapterName = adapter || config.provider || "openai";
    const llmKey = "llm-" + adapterName;
    if (!settings[llmKey]) settings[llmKey] = { providers: {} };
    if (!settings[llmKey].providers) settings[llmKey].providers = {};
    const providerConfig = {
      apiKeyEnv: config.apiKeyEnv || "",
      api: "openai-completions",
      baseURL: config.baseUrl || "",
      models: Array.isArray(config.models) && config.models.length > 0
        ? config.models.map(m => typeof m === "string" ? { id: m } : { id: m.id || m })
        : [{ id: config.model || "gpt-4o" }],
    };
    if (config.apiKey) providerConfig.apiKeyEnv = config.apiKey;
    settings[llmKey].providers[name] = providerConfig;
    await this.write(settings);
    return { success: true, name, adapter: adapterName, key: llmKey };
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