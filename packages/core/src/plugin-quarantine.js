/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh');

/** 隔离事件落盘文件（DSH 侧 vendor-patch 追加写，Manager 侧只读/清空） */
export const QUARANTINE_FILE = () => join(DSH_HOME(), 'manager', 'plugin-quarantine.jsonl');

/** 同一 provider 自动暂停的最小间隔（防止循环崩溃反复弹） */
export const QUARANTINE_COOLDOWN_MS = 30 * 60 * 1000;

/** 是否系统/官方核心组件（永不自动暂停，仅提示） */
const SYSTEM_PROVIDER_PREFIXES = ['deepseek', 'pi-ai', 'ark', 'dashscope', '@deepseek-ai'];

function ensureDir(file) {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch { /* 忽略 */ }
}

/**
 * 读取全部隔离事件（按时间升序）。坏行跳过，不影响其余。
 * 事件结构（由 dsh-llm vendor patch 写入）：
 *   { ts, type: 'adapter-crash', provider, model, stage, adapter, message }
 * @returns {Array<object>}
 */
export function readQuarantineEvents() {
  const file = QUARANTINE_FILE();
  if (!existsSync(file)) return [];
  const events = [];
  try {
    const raw = readFileSync(file, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        if (ev && typeof ev.provider === 'string' && ev.ts) events.push(ev);
      } catch { /* 坏行忽略 */ }
    }
  } catch (e) {
    console.warn('[dsh-manager] 读取插件隔离事件失败:', e?.message || e);
  }
  return events;
}

/**
 * 取最近的隔离事件（倒序，最多 limit 条）。
 * @param {number} [limit=50]
 */
export function latestQuarantineEvents(limit = 50) {
  return readQuarantineEvents().slice(-limit).reverse();
}

/**
 * 把事件按 provider 聚合为“待办/已隔离”卡片（倒序：最新在前）。
 * @param {object} [opts]
 * @param {number} [opts.sinceTs] - 只统计该时间之后的事件（毫秒时间戳）
 * @returns {Array<{provider: string, adapter: string, model: string, message: string, lastTs: string, count: number}>}
 */
export function groupQuarantineByProvider({ sinceTs } = {}) {
  const events = readQuarantineEvents();
  const groups = new Map();
  for (const ev of events) {
    const tsMs = Date.parse(ev.ts || '');
    if (sinceTs && (!tsMs || tsMs <= sinceTs)) continue;
    const key = ev.provider;
    if (!groups.has(key)) {
      groups.set(key, {
        provider: key,
        adapter: ev.adapter || key,
        model: ev.model || '',
        message: ev.message || '',
        lastTs: ev.ts,
        count: 0,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    if (!g.lastTs || ev.ts > g.lastTs) {
      g.lastTs = ev.ts;
      if (ev.message) g.message = ev.message;
      if (ev.model) g.model = ev.model;
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
}

/**
 * provider → 本地插件 启发式映射：
 * 1. provider 精确等于插件 id/尾段；
 * 2. provider 按分隔符切段，前缀逐段缩短后匹配插件 id 尾段（modlens-yang-2 → modlens）；
 * 3. 仅在本地插件列表内匹配（local 不含系统组件，天然规避官方核心插件）。
 * @param {string} provider
 * @param {Array<{id: string}>} localPlugins
 * @returns {{ pluginId: string, matchedBy: string } | null}
 */
export function resolvePluginForProvider(provider, localPlugins) {
  if (!provider || !Array.isArray(localPlugins) || localPlugins.length === 0) return null;
  const candidates = localPlugins.filter((p) => p && typeof p.id === 'string');
  if (candidates.length === 0) return null;

  const tail = (id) => {
    const parts = String(id).split('/');
    return parts[parts.length - 1] || id;
  };

  // 1) 精确匹配（整 id / 尾段 / 去掉 @scope 后的 id）
  for (const p of candidates) {
    const id = p.id;
    if (provider === id || provider === tail(id) || provider === id.replace(/^@[^/]+\//, '')) {
      return { pluginId: id, matchedBy: 'exact' };
    }
  }

  // 2) provider 前缀逐段缩短匹配尾段
  const segments = provider.split(/[-_.:]/).filter(Boolean);
  for (let len = segments.length; len >= 1; len--) {
    const prefix = segments.slice(0, len).join('-');
    if (prefix.length < 2) continue;
    for (const p of candidates) {
      const t = tail(p.id);
      if (t === prefix) return { pluginId: p.id, matchedBy: `prefix:${prefix}` };
    }
  }

  // 3) 前缀包含（尾段是 provider 前缀的真前缀，如 provider=modlens-yang-2, tail=modlens）
  const sorted = candidates.slice().sort((a, b) => tail(b.id).length - tail(a.id).length);
  for (const p of sorted) {
    const t = tail(p.id);
    if (t.length >= 2 && provider.startsWith(t) && provider !== t) {
      return { pluginId: p.id, matchedBy: `startsWith:${t}` };
    }
  }

  return null;
}

/** 供 UI 判断：provider 是否疑似系统/官方核心（避免误导用户去暂停官方插件） */
export function isSystemProvider(provider) {
  const p = String(provider || '').toLowerCase();
  return SYSTEM_PROVIDER_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '-') || p.startsWith(prefix + '_'));
}

/**
 * 给本地插件列表合并隔离状态（供插件管理页展示“已自动暂停”徽标与原因）。
 * @param {Array<object>} plugins - PluginManager.listAll().local
 * @returns {Array<object>} 原数组的浅拷贝扩展：{ quarantine: {active, provider, message, lastTs, count} | null }
 */
export function attachQuarantineState(plugins, events = readQuarantineEvents()) {
  const groups = new Map();
  for (const ev of events) {
    const key = ev.provider;
    if (!groups.has(key)) {
      groups.set(key, {
        provider: key,
        adapter: ev.adapter || key,
        message: ev.message || '',
        lastTs: ev.ts,
        count: 0,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    if (!g.lastTs || ev.ts > g.lastTs) {
      if (ev.message) g.message = ev.message;
    }
  }
  return (plugins || []).map((p) => {
    let quarantine = null;
    for (const g of groups.values()) {
      const hit = resolvePluginForProvider(g.provider, [{ id: p.id }]);
      if (hit && hit.pluginId === p.id) {
        quarantine = {
          active: true,
          provider: g.provider,
          message: g.message,
          lastTs: g.lastTs,
          count: g.count,
        };
        break;
      }
    }
    return { ...p, quarantine };
  });
}

/** 清空全部隔离事件（恢复操作前的清理；不影响插件 disabled 标记本身） */
export function clearQuarantineEvents() {
  const file = QUARANTINE_FILE();
  try {
    ensureDir(file);
    writeFileSync(file, '', { encoding: 'utf-8' });
    return true;
  } catch (e) {
    console.warn('[dsh-manager] 清空插件隔离事件失败:', e?.message || e);
    return false;
  }
}

/** 手动写入一条事件（测试/其它通道复用） */
export function appendQuarantineEvent(ev) {
  const file = QUARANTINE_FILE();
  try {
    ensureDir(file);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: 'adapter-crash',
      provider: ev.provider,
      model: ev.model || '',
      stage: ev.stage || 'manual',
      adapter: ev.adapter || ev.provider,
      message: ev.message || '',
    }) + '\n';
    appendFileSync(file, line, { encoding: 'utf-8' });
    return true;
  } catch (e) {
    console.warn('[dsh-manager] 追加插件隔离事件失败:', e?.message || e);
    return false;
  }
}
