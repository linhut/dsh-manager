/**
 * @dsh-manager/core - DSH 配置管理
 * 
 * 读取、编辑、验证 DSH 配置
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS } from './dsh-utils.js';

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
      const dir = filePath.substring(0, filePath.lastIndexOf('\\'));
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
   * @returns {Promise<Array<{name: string, provider: string, model: string}>>}
   */
  async listLLMProviders() {
    const { settings } = await this.read();
    const providers = [];
    
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
      if (config && typeof config === 'object') {
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
   * 简易 YAML 解析器（兼容 dsh 格式）
   * @private
   */
  _parseYAML(yaml) {
    const result = {};
    const lines = yaml.split('\n');
    const stack = [{ indent: -1, obj: result }];

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;

      const indent = line.search(/\S/);
      const content = trimmed.trim();

      // 弹出缩进更大的栈顶
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].obj;

      if (content.endsWith(':')) {
        // 对象键
        const key = content.slice(0, -1).trim();
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
      } else if (content.includes(':')) {
        // 键值对
        const colonIdx = content.indexOf(':');
        const key = content.slice(0, colonIdx).trim();
        let value = content.slice(colonIdx + 1).trim();
        
        if (value === '') {
          parent[key] = null;
        } else {
          parent[key] = this._parseScalar(value);
        }
      } else if (content.startsWith('- ')) {
        // 列表项
        // 简化处理，暂不处理复杂列表
        const item = content.slice(2).trim();
        if (!Array.isArray(parent._items)) {
          parent._items = [];
        }
        parent._items.push(this._parseScalar(item));
      }
    }

    // 将 _items 转换为数组
    this._convertItems(result);
    return result;
  }

  /** @private */
  _convertItems(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') {
        if (value._items) {
          obj[key] = value._items;
          delete value._items;
        }
        this._convertItems(value);
      }
    }
  }

  /** @private */
  _parseScalar(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    const num = Number(value);
    if (!isNaN(num) && value !== '') return num;
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      return value.slice(1, -1);
    }
    return value;
  }

  /**
   * 简易 YAML 序列化
   * @private
   */
  _toYAML(obj, indent = 0) {
    const prefix = '  '.repeat(indent);
    let result = '';

    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('_')) continue;
      
      if (value === null || value === undefined) {
        result += `${prefix}${key}: null\n`;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        if (Object.keys(value).length === 0) {
          result += `${prefix}${key}: {}\n`;
        } else {
          result += `${prefix}${key}:\n`;
          result += this._toYAML(value, indent + 1);
        }
      } else if (Array.isArray(value)) {
        result += `${prefix}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            result += `${prefix}  - `;
            result += this._toYAML(item, indent + 2).trimStart();
          } else {
            result += `${prefix}  - ${this._formatValue(item)}\n`;
          }
        }
      } else {
        result += `${prefix}${key}: ${this._formatValue(value)}\n`;
      }
    }

    return result;
  }

  /** @private */
  _formatValue(value) {
    if (typeof value === 'string') {
      if (value.includes(':') || value.includes('#') || value.includes("'")) {
        return `"${value}"`;
      }
      return value;
    }
    return String(value);
  }
}