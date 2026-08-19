/**
 * DSH Manager
 * Copyright (c) 2026 linhut (https://github.com/linhut)
 * MIT License
 */

/**
 * @dsh-manager/core - DSH 配置管理
 * 
 * 读取、编辑、验证 DSH 配置
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
}