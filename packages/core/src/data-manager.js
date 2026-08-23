/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_PATHS } from './dsh-utils.js';

/** 数据目录清单（name → 路径） */
function getDataDirs() {
  return {
    profiles: DSH_PATHS.profiles,
    sessions: DSH_PATHS.sessions,
    skills: DSH_PATHS.skills,
    storages: DSH_PATHS.storages,
    manager: DSH_PATHS.managerDir,
  };
}

/**
 * 递归统计目录大小（字节）
 * @param {string} dir
 * @returns {number}
 */
async function dirSize(dir, depth = 0) {
  // 深度上限与条目上限，避免超大目录（如 storages 上百 GB）长时间阻塞
  if (depth > 12) return 0;
  let total = 0;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  // 分批让出事件循环，避免同步递归长时间阻塞 UI
  const BATCH = 64;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    // 每批让出一次事件循环（仅层数多时再让，浅目录零开销）
    if (depth > 2) await new Promise(resolve => setImmediate(resolve));
    for (const entry of batch) {
      const full = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += await dirSize(full, depth + 1);
        } else if (entry.isSymbolicLink()) {
          // 符号链接不跟随，避免循环
          continue;
        } else {
          total += statSync(full).size;
        }
      } catch {}
    }
  }
  return total;
}

/**
 * 获取 DSH 各数据目录占用
 * @returns {Promise<{total: number, dirs: Array<{name: string, path: string, size: number}>}>}
 */
export async function getDSHStorageInfo() {
  const dirs = getDataDirs();
  const result = [];
  let total = 0;

  for (const [name, path] of Object.entries(dirs)) {
    const size = existsSync(path) ? await dirSize(path) : 0;
    total += size;
    result.push({ name, path, size });
  }

  return { total, dirs: result };
}

/**
 * 清空指定数据目录内容（保留目录本身）
 * @param {object} opts
 * @param {boolean} [opts.sessions] - 清理会话
 * @param {boolean} [opts.storages] - 清理存储
 * @param {boolean} [opts.cache] - 清理 manager 目录（含插件缓存）
 * @returns {Promise<{cleaned: string[]}>} 实际清理的目录名
 */
export async function cleanDSHData(opts = {}) {
  const map = {
    sessions: opts.sessions ? DSH_PATHS.sessions : null,
    storages: opts.storages ? DSH_PATHS.storages : null,
    cache: opts.cache ? DSH_PATHS.pluginCache : null,
  };

  const cleaned = [];
  for (const [name, path] of Object.entries(map)) {
    if (!path || !existsSync(path)) continue;
    let removed = 0;
    try {
      for (const entry of readdirSync(path)) {
        rmSync(join(path, entry), { recursive: true, force: true });
        removed++;
      }
    } catch {}
    if (removed > 0) cleaned.push(name);
  }

  return { cleaned };
}
