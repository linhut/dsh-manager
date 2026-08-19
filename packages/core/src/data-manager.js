/**
 * DSH Manager
 * Copyright (c) 2026 linhut (https://github.com/linhut)
 * MIT License
 */

/**
 * @dsh-manager/core - 数据管理
 * 
 * 统计 DSH 各数据目录占用，按需清理会话/缓存/存储。
 * 清理只删除目录内文件与子目录，保留目录本身。
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
function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += dirSize(full);
        } else if (entry.isSymbolicLink()) {
          // 符号链接不跟随，避免循环
          continue;
        } else {
          total += statSync(full).size;
        }
      } catch {}
    }
  } catch {}
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
    const size = existsSync(path) ? dirSize(path) : 0;
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
    cache: opts.cache ? DSH_PATHS.managerDir : null,
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
