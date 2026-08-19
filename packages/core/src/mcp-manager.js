/**
 * @dsh-manager/core - MCP 服务端管理器
 * 
 * 管理 DSH profile 中配置的 MCP 服务端（@deepseek-ai/dsh-mcp-client 插件）。
 * 
 * DSH 的 MCP 配置位于 ~/.dsh/profiles/<profile>/cordis.patch.yml，
 * 每个服务端对应一个 insert 条目：
 * 
 *   - insert:
 *       - id: mcp-<serverName>
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           transport: stdio | streamable-http
 *           serverName: xxx
 *           command: npx
 *           args: [...]
 *           env: {...}
 *           url: https://...
 *           headers: {...}
 *           reconnect: {...}
 * 
 * 采用"文本级操作"策略：读取时轻量解析；写入时追加/替换块，
 * 以保留文件中的注释和其他用户配置（js-yaml 序列化会破坏 !!js 表达式）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS } from './dsh-utils.js';

/** MCP 客户端插件名 */
const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';
/** 合法 serverName 正则（与 DSH 一致） */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 将 JS 字符串安全地表示为 YAML 标量
 */
function yamlString(value) {
  const str = String(value);
  // 含特殊字符时加引号
  if (/^[A-Za-z0-9_\-./:@]*$/.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}

/**
 * 将 args 数组格式化为 YAML 序列
 */
function yamlList(indent, items) {
  const pad = ' '.repeat(indent);
  return items.map(item => `${pad}- ${yamlString(item)}`).join('\n');
}

/**
 * 将字符串对象格式化为 YAML 字典
 */
function yamlDict(indent, obj) {
  const pad = ' '.repeat(indent);
  return Object.entries(obj)
    .map(([k, v]) => `${pad}${k}: ${yamlString(v)}`)
    .join('\n');
}

export class MCPServerManager {
  /**
   * @param {object} [options]
   * @param {string} [options.profile] - 目标 profile，默认 web
   */
  constructor(options = {}) {
    this.profile = options.profile || 'web';
    this.patchFile = join(DSH_PATHS.home, 'profiles', this.profile, 'cordis.patch.yml');
  }

  /**
   * 解析 patch 文件，提取所有 insert 条目
   * @returns {Array<{raw: string, id: string|null, name: string|null, configName: string|null, block: string}>}
   */
  _parseBlocks() {
    if (!existsSync(this.patchFile)) return [];

    const lines = readFileSync(this.patchFile, 'utf-8').split(/\r?\n/);
    const blocks = [];
    let current = null;  // 当前 insert 块的收集
    let indent = -1;

    for (const line of lines) {
      const trimmed = line.trim();
      // 顶层 insert 开始（缩进为 0 且以 "- insert:" 开头）
      const insertMatch = trimmed.match(/^-\s*insert:\s*$/);
      if (insertMatch && line.startsWith('- ')) {
        if (current) blocks.push(current);
        current = { lines: [line], id: null, name: null, configName: null };
        indent = line.length - line.trimStart().length;
        continue;
      }
      if (current) {
        current.lines.push(line);
        // 提取 id
        const idMatch = line.match(/^\s*-\s*id:\s*(.+)$/);
        if (idMatch) current.id = idMatch[1].trim().replace(/^['"]|['"]$/g, '');
        // 提取 name
        const nameMatch = line.match(/^\s*name:\s*(.+)$/);
        if (nameMatch) current.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
        // 提取 config 下的 serverName（缩进 8+）
        const snMatch = line.match(/^ {8}serverName:\s*(.+)$/);
        if (snMatch) current.configName = snMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
    if (current) blocks.push(current);

    return blocks.map(b => ({ ...b, block: b.lines.join('\n') }));
  }

  /**
   * 列出已配置的 MCP 服务端
   * @returns {Array<{id: string, serverName: string, pluginName: string, block: string, transport: string|null}>}
   */
  list() {
    const blocks = this._parseBlocks();
    return blocks
      .filter(b => b.name === MCP_PLUGIN_NAME && b.configName)
      .map(b => {
        // 从原始文本中尝试提取 transport
        const tMatch = b.block.match(/^\s{8}transport:\s*(.+)$/m);
        return {
          id: b.id || `mcp-${b.configName}`,
          serverName: b.configName,
          pluginName: b.name,
          transport: tMatch ? tMatch[1].trim().replace(/^['"]|['"]$/g, '') : 'stdio',
          block: b.block,
        };
      });
  }

  /**
   * 获取单个服务端配置
   * @param {string} serverName
   * @returns {object|null}
   */
  get(serverName) {
    const servers = this.list();
    return servers.find(s => s.serverName === serverName) || null;
  }

  /**
   * 生成 MCP insert 块的 YAML 文本
   * @param {object} config - 服务端配置（transport/serverName/...）
   * @param {string} [idSuffix] - 可选 id 后缀
   * @returns {string}
   */
  _buildBlock(config, idSuffix = '') {
    const id = `mcp-${config.serverName}${idSuffix}`;
    const lines = [`- insert:`, `    - id: ${id}`, `      name: '@deepseek-ai/dsh-mcp-client'`];

    if (config.transport === 'streamable-http') {
      lines.push(`      config:`);
      lines.push(`        transport: streamable-http`);
      lines.push(`        serverName: ${yamlString(config.serverName)}`);
      lines.push(`        url: ${yamlString(config.url)}`);
      if (config.headers && Object.keys(config.headers).length > 0) {
        lines.push(`        headers:`);
        lines.push(yamlDict(10, config.headers));
      }
    } else {
      lines.push(`      config:`);
      lines.push(`        transport: stdio`);
      lines.push(`        serverName: ${yamlString(config.serverName)}`);
      lines.push(`        command: ${yamlString(config.command)}`);
      if (config.args && config.args.length > 0) {
        lines.push(`        args:`);
        lines.push(yamlList(10, config.args));
      }
      if (config.env && Object.keys(config.env).length > 0) {
        lines.push(`        env:`);
        lines.push(yamlDict(10, config.env));
      }
      if (config.cwd) {
        lines.push(`        cwd: ${yamlString(config.cwd)}`);
      }
    }

    // 可选高级配置
    if (config.toolCallTimeoutMs !== undefined) {
      lines.push(`        toolCallTimeoutMs: ${Number(config.toolCallTimeoutMs)}`);
    }
    if (config.failOnStartupError !== undefined) {
      lines.push(`        failOnStartupError: ${config.failOnStartupError}`);
    }
    // reconnect
    if (config.reconnect && typeof config.reconnect === 'object') {
      lines.push(`        reconnect:`);
      lines.push(`          enabled: ${config.reconnect.enabled ?? true}`);
      if (config.reconnect.initialDelayMs !== undefined) lines.push(`          initialDelayMs: ${Number(config.reconnect.initialDelayMs)}`);
      if (config.reconnect.maxDelayMs !== undefined) lines.push(`          maxDelayMs: ${Number(config.reconnect.maxDelayMs)}`);
      if (config.reconnect.maxAttempts !== undefined) lines.push(`          maxAttempts: ${Number(config.reconnect.maxAttempts)}`);
    }

    return lines.join('\n');
  }

  /**
   * 添加或更新一个 MCP 服务端
   * @param {object} config - 服务端配置
   * @returns {Promise<{success: boolean, serverName: string}>}
   */
  async add(config) {
    if (!config || !config.serverName) {
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'serverName 不能为空');
    }
    if (!SERVER_NAME_PATTERN.test(config.serverName)) {
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'serverName 只能包含字母、数字、下划线、连字符且不超过32字符');
    }
    if (config.transport === 'streamable-http') {
      if (!config.url) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'URL 不能为空');
    } else {
      if (!config.command) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'command 不能为空');
      config.transport = 'stdio';
    }

    const dir = join(DSH_PATHS.home, 'profiles', this.profile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.patchFile)) {
      writeFileSync(this.patchFile, '# dsh profile patch layer\n[]\n', 'utf-8');
    }

    // 检查同名 serverName 是否已存在
    const existing = this.get(config.serverName);
    const rawContent = readFileSync(this.patchFile, 'utf-8');
    let newContent;

    if (existing) {
      // 替换已有块
      newContent = rawContent.replace(existing.block, this._buildBlock(config));
    } else {
      // 空 patch 文件（[] 占位）→ 替换占位为真实条目；否则在末尾追加新块
      const placeholderMatch = rawContent.match(/^# dsh profile patch layer\n\[\s*\]/);
      if (placeholderMatch) {
        newContent = rawContent.replace(/\[\s*\]/, this._buildBlock(config));
      } else {
        newContent = rawContent.trimEnd() + '\n\n' + this._buildBlock(config) + '\n';
      }
    }

    writeFileSync(this.patchFile, newContent, 'utf-8');
    return { success: true, serverName: config.serverName };
  }

  /**
   * 删除一个 MCP 服务端
   * @param {string} serverName
   * @returns {Promise<{success: boolean}>}
   */
  async remove(serverName) {
    if (!existsSync(this.patchFile)) return { success: true };
    const existing = this.get(serverName);
    if (!existing) return { success: true };

    const rawContent = readFileSync(this.patchFile, 'utf-8');
    // 删除块及其前的空行
    const newContent = rawContent
      .replace(new RegExp(`\\n?\\n?${escapeRegExp(existing.block)}`), '\n')
      .replace(/\n{3,}/g, '\n\n');

    writeFileSync(this.patchFile, newContent, 'utf-8');
    return { success: true };
  }

  /**
   * 生成安装 MCP 客户端插件的提示命令
   */
  getInstallHint() {
    return `dsh plugin --profile ${this.profile} add ${MCP_PLUGIN_NAME}`;
  }
}

/** 正则转义 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}