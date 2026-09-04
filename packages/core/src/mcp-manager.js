/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS } from './dsh-utils.js';

const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function yamlString(value) {
  const str = String(value);
  const envMatch = str.match(ENV_REF_PATTERN);
  if (envMatch) return '!!js process.env.' + envMatch[1];
  if (/^[A-Za-z0-9_\-./:@]*$/.test(str)) return str;
  // 双引号标量：转义反斜杠/引号/换行/制表符，避免 YAML 注入
  return '"' + str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"'
}
function yamlList(indent, items) {
  const pad = ' '.repeat(indent);
  return items.map(i => pad + '- ' + yamlString(i)).join('\n');
}
function yamlDict(indent, obj) {
  const pad = ' '.repeat(indent);
  return Object.entries(obj).map(([k, v]) => pad + k + ': ' + yamlString(v)).join('\n');
}
// countEnvRefs removed — unused (use getEnvVarNames instead)
function getEnvVarNames(text) {
  const m = text.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
  if (!m) return [];
  return [...new Set(m.map(x => x.slice(2, -1)))];
}
function parseKvLine(line) {
  if (!line || !line.trim() || line.trim().startsWith('#')) return null;
  const indent = line.length - line.trimStart().length;
  const content = line.trim();
  const ci = content.indexOf(':');
  if (ci < 0) return null;
  const key = content.slice(0, ci).trim();
  let value = content.slice(ci + 1).trim();
  // 对称引号剥离：仅当首尾引号相同时才剥除
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  const js = value.match(/^!!js\s+process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (js) value = '\${' + js[1] + '}';
  return { indent, key, value };
}
export class MCPServerManager {
  constructor(opts = {}) { this.profile = opts.profile || 'web'; this.patchFile = join(DSH_PATHS.home, 'profiles', this.profile, 'cordis.patch.yml'); }
  _parseBlocks() {
    if (!existsSync(this.patchFile)) return [];
    const lines = readFileSync(this.patchFile, 'utf-8').split(/\r?\n/);
    const blocks = []; let cur = null;
    for (const line of lines) {
      const t = line.trim();
      if (t.match(/^-\s*insert:\s*$/) && line.startsWith('- ')) { if (cur) blocks.push(cur); cur = { lines: [line], id: null, name: null, configName: null }; continue; }
      if (cur) {
        cur.lines.push(line);
        const idM = line.match(/^\s*-\s*id:\s*(.+)$/); if (idM) cur.id = idM[1].trim().replace(/^['"]|['"]$/g, '');
        const nmM = line.match(/^\s*name:\s*(.+)$/); if (nmM) cur.name = nmM[1].trim().replace(/^['"]|['"]$/g, '');
        const snM = line.match(/^ {8}serverName:\s*(.+)$/); if (snM) cur.configName = snM[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
    if (cur) blocks.push(cur);
    return blocks.map(b => ({ ...b, block: b.lines.join('\n') }));
  }
  list() { return this._parseBlocks().filter(b => b.name === MCP_PLUGIN_NAME && b.configName).map(b => { const c = this._parseConfig(b.block); return { id: b.id || ('mcp-' + b.configName), serverName: b.configName, pluginName: b.name, ...c, block: b.block }; }); }
  _parseConfig(block) {
    const cfg = {}; let ctr = null; let args = null;
    for (const line of block.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const ind = line.length - line.trimStart().length; const cont = line.trim();
      if (ctr && ind <= ctr.indent) { if (ctr.type === 'env') cfg.env = ctr.obj; else if (ctr.type === 'headers') cfg.headers = ctr.obj; else if (ctr.type === 'reconnect') cfg.reconnect = ctr.obj; ctr = null; }
      if (args !== null && ind < 10) { cfg.args = args; args = null; }
      const kv = parseKvLine(line);
      if (kv && kv.indent === 8) {
        if (['env','headers'].includes(kv.key) && kv.value === '') { ctr = { type: kv.key, indent: 8, obj: {} }; continue; }
        if (kv.key === 'reconnect' && kv.value === '') { ctr = { type: 'reconnect', indent: 8, obj: {} }; continue; }
        cfg[kv.key] = kv.value; continue;
      }
      if (ctr && kv && kv.indent === 10) {
        if (kv.key === 'enabled' && ctr.type === 'reconnect') ctr.obj.enabled = kv.value === 'true';
        else if (['initialDelayMs','maxDelayMs','maxAttempts'].includes(kv.key)) { const n = Number(kv.value); ctr.obj[kv.key] = isNaN(n) ? kv.value : n; }
        else ctr.obj[kv.key] = kv.value; continue;
      }
      if (ind === 10 && cont.startsWith('- ') && !kv) { if (!args) args = []; const v = cont.slice(2).trim(); v && args.push(v.replace(/^['"]|['"]$/g, '')); }
      if (kv && kv.indent === 8) { if (kv.key === 'toolCallTimeoutMs') { const n = Number(kv.value); cfg[kv.key] = isNaN(n) ? kv.value : n; } else if (kv.key === 'failOnStartupError') cfg.failOnStartupError = kv.value === 'true'; else if (kv.key === 'transport' || kv.key === 'serverName') cfg[kv.key] = kv.value; }
    }
    if (ctr) { if (ctr.type === 'env') cfg.env = ctr.obj; else if (ctr.type === 'headers') cfg.headers = ctr.obj; else if (ctr.type === 'reconnect') cfg.reconnect = ctr.obj; } if (args !== null) cfg.args = args;
    if (!cfg.serverName) { const sn = block.match(/^ {8}serverName:\s*(.+)$/m); if (sn) cfg.serverName = sn[1].trim().replace(/^['"]|['"]$/g, ''); }
    if (!cfg.transport) { const tr = block.match(/^ {8}transport:\s*(.+)$/m); if (tr) cfg.transport = tr[1].trim().replace(/^['"]|['"]$/g, ''); } return cfg;
  }
  get(serverName) { const s = this.list(); return s.find(x => x.serverName === serverName) || null; }
  _buildBlock(cfg, idSuffix = '') {
    const id = 'mcp-' + cfg.serverName + idSuffix;
    const lines = ['- insert:', '    - id: ' + id, "      name: '@deepseek-ai/dsh-mcp-client'"];
    if (cfg.transport === 'streamable-http') { lines.push('      config:'); lines.push('        transport: streamable-http'); lines.push('        serverName: ' + yamlString(cfg.serverName)); lines.push('        url: ' + yamlString(cfg.url)); if (cfg.headers) { lines.push('        headers:'); lines.push(yamlDict(10, cfg.headers)); } }
    else { lines.push('      config:'); lines.push('        transport: stdio'); lines.push('        serverName: ' + yamlString(cfg.serverName)); lines.push('        command: ' + yamlString(cfg.command)); if (cfg.args) { lines.push('        args:'); lines.push(yamlList(10, cfg.args)); } if (cfg.env) { lines.push('        env:'); lines.push(yamlDict(10, cfg.env)); } if (cfg.cwd) lines.push('        cwd: ' + yamlString(cfg.cwd)); }
    if (cfg.toolCallTimeoutMs !== undefined) lines.push('        toolCallTimeoutMs: ' + Number(cfg.toolCallTimeoutMs));
    if (cfg.failOnStartupError !== undefined) lines.push('        failOnStartupError: ' + cfg.failOnStartupError);
    if (cfg.reconnect) { lines.push('        reconnect:'); lines.push('          enabled: ' + (cfg.reconnect.enabled ?? true)); if (cfg.reconnect.initialDelayMs !== undefined) lines.push('          initialDelayMs: ' + Number(cfg.reconnect.initialDelayMs)); if (cfg.reconnect.maxDelayMs !== undefined) lines.push('          maxDelayMs: ' + Number(cfg.reconnect.maxDelayMs)); if (cfg.reconnect.maxAttempts !== undefined) lines.push('          maxAttempts: ' + Number(cfg.reconnect.maxAttempts)); }
    return lines.join('\n');
  }
  _atomicWrite(nc) {
    let bk = ''; if (existsSync(this.patchFile)) { try { const ts = Date.now(); bk = this.patchFile + '.bak-' + ts; copyFileSync(this.patchFile, bk); try { const m = statSync(this.patchFile).mode & 0o777; if (m) chmodSync(bk, m); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); } } catch (e) { console.warn('[mcp] 备份失败:', e.message); } }
    const dir = dirname(this.patchFile); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = this.patchFile + '.tmp-' + Date.now();
    try { writeFileSync(tmp, nc, 'utf-8'); renameSync(tmp, this.patchFile); } catch (err) { try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); } throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'MCP 写入失败: ' + err.message); }
    return bk;
  }
  async add(cfg) {
    if (!cfg || !cfg.serverName) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'serverName 不能为空');
    if (!SERVER_NAME_PATTERN.test(cfg.serverName)) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'serverName 命名不规范');
    if (cfg.transport === 'streamable-http') { if (!cfg.url) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'URL 不能为空'); } else { if (!cfg.command) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'command 不能为空'); cfg.transport = 'stdio'; }
    const dir = join(DSH_PATHS.home, 'profiles', this.profile); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.patchFile)) writeFileSync(this.patchFile, '# dsh profile patch layer\n[]\n', 'utf-8');
    const raw = readFileSync(this.patchFile, 'utf-8').replace(/\r\n/g, '\n');
    // 统一重建合法顶层数组：保留头部注释、剔除残留空数组（[]），
    // 避免旧文件头注释不同时生成 "[] + - insert:" 非法 YAML 导致 patch 加载失败
    const headerLines = [];
    for (const line of raw.split('\n')) { if (/^\s*#/.test(line)) headerLines.push(line); else break; }
    const blocks = this._parseBlocks().filter(b => !headerLines.includes(b.block));
    const ordered = [];
    for (const b of blocks) { if (b.configName !== cfg.serverName) ordered.push(b.block); }
    ordered.push(this._buildBlock(cfg));
    const body = ordered.join('\n\n');
    const nc = (headerLines.length > 0 ? headerLines.join('\n') + '\n\n' : '') + body + '\n';
    return { success: true, serverName: cfg.serverName, backupPath: this._atomicWrite(nc) };
  }
  async remove(serverName) {
    if (!existsSync(this.patchFile)) return { success: true }; const ex = this.get(serverName); if (!ex) return { success: true };
    // CRLF 兼容：归一化行尾再匹配（_parseBlocks 已用 \r?\n 切分，但 block 用 \n 拼接）
    const raw = readFileSync(this.patchFile, 'utf-8').replace(/\r\n/g, '\n');
    const nc = raw.replace(new RegExp('\\n?\\n?' + escapeRegExp(ex.block)), '\n').replace(/\n{3,}/g, '\n\n');
    return { success: true, backupPath: this._atomicWrite(nc) };
  }
  parseMcpJson(jsonText) {
    let data; try { data = JSON.parse(jsonText); } catch (e) { throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'JSON 解析失败: ' + e.message); }
    const ms = data && data.mcpServers ? data.mcpServers : null;
    if (!ms) { if (Array.isArray(data)) { const s = []; const w = []; for (const item of data) { if (item && item.name && (item.command || item.url)) s.push(this._normalizeServer(item)); else w.push('跳过无效: ' + JSON.stringify(item)); } return { servers: s, warnings: w }; } throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, '需要 { mcpServers: { ... } } 或数组'); }
    const w = []; const s = [];
    for (const [name, rc] of Object.entries(ms)) {
      if (!SERVER_NAME_PATTERN.test(name)) { w.push('serverName「' + name + '」不符合命名规范，已跳过'); continue; }
      const r = (rc && typeof rc === 'object') ? rc : {};
      if (typeof r.command === 'string' && r.command.trim()) { const sv = { serverName: name, transport: 'stdio', command: r.command.trim() }; if (Array.isArray(r.args)) sv.args = r.args.map(String); if (r.env) sv.env = Object.fromEntries(Object.entries(r.env).map(([k, v]) => [k, String(v)])); if (r.cwd) sv.cwd = String(r.cwd); s.push(sv); }
      else { const type = String(r.type || 'http').toLowerCase(); const url = (typeof r.url === 'string' && r.url.trim()) ? r.url.trim() : (typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : ''); if (type === 'sse') w.push('「' + name + '」type=sse：只支持 streamable-http'); if (!url) { w.push('「' + name + '」缺少 url，已跳过'); continue; } const sv = { serverName: name, transport: 'streamable-http', url }; if (r.headers) sv.headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, String(v)])); s.push(sv); }
    }
    return { servers: s, warnings: w };
  }
  _normalizeServer(s) { const sv = { serverName: String(s.name) }; if (typeof s.command === 'string' && s.command.trim()) { sv.transport = 'stdio'; sv.command = s.command.trim(); if (Array.isArray(s.args)) sv.args = s.args.map(String); if (s.env) sv.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)])); if (s.cwd) sv.cwd = String(s.cwd); } else { sv.transport = 'streamable-http'; sv.url = String(s.url || s.baseUrl || ''); if (s.headers) sv.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, String(v)])); } return sv; }
  convertJsonToYaml(jsonText) {
    try { const { servers, warnings } = this.parseMcpJson(jsonText); if (servers.length === 0) return { ok: false, error: '没有可转换的服务器', warnings }; const yamlText = servers.map(s => this._buildBlock({ ...s })).join('\n'); const envVars = getEnvVarNames(yamlText); if (envVars.length > 0) warnings.push('检测到环境变量引用，已转换为 !!js process.env.*'); return { ok: true, rows: servers, yaml: yamlText, warnings, envVars }; } catch (err) { return { ok: false, error: err.message }; }
  }
  async importServers(servers, opts = {}) {
    const mode = opts.mode || 'merge';
    const w = []; const add = []; const upd = []; const skip = [];
    // ① 先统一校验/规范化（与 add/remove 相同的规则），失败项直接跳过
    const ready = []; const existingMap = new Map();
    for (const sv of servers) {
      try {
        if (!sv || !sv.serverName) { skip.push('(unnamed)'); continue; }
        if (!SERVER_NAME_PATTERN.test(sv.serverName)) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'serverName 命名不规范');
        const cfg = { ...sv };
        if (cfg.transport === 'streamable-http') { if (!cfg.url) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'URL 不能为空'); }
        else { if (!cfg.command) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, 'command 不能为空'); cfg.transport = 'stdio'; }
        ready.push(cfg);
      } catch (e) { const n = (sv && sv.serverName) || '?'; skip.push(n); w.push(n + ': ' + e.message); }
    }
    // ② 读写合并为一次原子操作：replace=清空全部现有 MCP 块；merge=仅剔除同名块（更新语义）
    const dir = join(DSH_PATHS.home, 'profiles', this.profile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.patchFile)) writeFileSync(this.patchFile, '# dsh profile patch layer\n[]\n', 'utf-8');
    const raw = readFileSync(this.patchFile, 'utf-8').replace(/\r\n/g, '\n');
    const headerLines = [];
    for (const line of raw.split('\n')) { if (/^\s*#/.test(line)) headerLines.push(line); else break; }
    let blocks = this._parseBlocks().filter(b => !headerLines.includes(b.block));
    for (const b of blocks) { if (b.name === MCP_PLUGIN_NAME && b.configName) existingMap.set(b.configName, b); }
    const keepNames = new Set(ready.map(c => c.serverName));
    // 保留的现有块取 b.block（字符串），新块用 _buildBlock 字符串，避免 [object Object] 序列化
    if (mode === 'replace') {
      blocks = blocks.filter(b => !(b.name === MCP_PLUGIN_NAME && b.configName)).map(b => b.block);
    } else {
      blocks = blocks.filter(b => !(b.name === MCP_PLUGIN_NAME && b.configName && keepNames.has(b.configName))).map(b => b.block);
    }
    // ③ 追加新块，输出分类
    for (const cfg of ready) {
      if (existingMap.has(cfg.serverName)) upd.push(cfg.serverName); else add.push(cfg.serverName);
      blocks.push(this._buildBlock(cfg));
    }
    const body = blocks.join('\n\n');
    const nc = (headerLines.length > 0 ? headerLines.join('\n') + '\n\n' : '') + body + '\n';
    this._atomicWrite(nc);
    return { success: true, added: add, updated: upd, skipped: skip, warnings: w };
  }
  exportJson() { const ms = {}; for (const s of this.list()) { const e = {}; if (s.transport === 'streamable-http') { e.type = 'http'; e.url = s.url || ''; if (s.headers) e.headers = s.headers; } else { e.command = s.command || ''; if (s.args) e.args = s.args; if (s.env) e.env = s.env; if (s.cwd) e.cwd = s.cwd; } ms[s.serverName] = e; } return JSON.stringify({ mcpServers: ms }, null, 2); }
  async backup() { if (!existsSync(this.patchFile)) return { success: true, backupPath: null }; const ts = Date.now(); const bk = this.patchFile + '.bak-' + ts; copyFileSync(this.patchFile, bk); try { const m = statSync(this.patchFile).mode & 0o777; if (m) chmodSync(bk, m); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); } return { success: true, backupPath: bk }; }
  async listBackups() { const dir = dirname(this.patchFile); if (!existsSync(dir)) return []; const entries = []; try { const { readdirSync } = await import('node:fs'); for (const f of readdirSync(dir)) { const m = f.match(/^cordis\.patch\.yml\.bak-(\d+)$/); if (!m) continue; const p = join(dir, f); try { const st = statSync(p); entries.push({ path: p, name: f, mtime: st.mtime.toISOString() }); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); } } } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); } return entries.sort((a, b) => b.mtime.localeCompare(a.mtime)); }
  getInstallHint() { return 'dsh plugin --profile ' + this.profile + ' add ' + MCP_PLUGIN_NAME; }
}
function escapeRegExp(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }