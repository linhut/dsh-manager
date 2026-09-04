/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, mkdirSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS } from './dsh-utils.js';

/** 合法 profile 名称（与 DSH 一致） */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class DSHProfileManager {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.profilesDir = DSH_PATHS.profiles;
    this.backupDir = join(DSH_PATHS.managerDir, 'backups');
  }

  /**
   * 列出所有 profile
   * @returns {Array<{name: string, path: string, mtime: string|null, size: number}>}
   */
  list() {
    if (!existsSync(this.profilesDir)) return [];
    const result = [];
    for (const entry of readdirSync(this.profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(this.profilesDir, entry.name);
      let mtime = null;
      let entryCount = 0;
      try {
        const st = statSync(path);
        mtime = st.mtime.toISOString();
        // 目录的 stat.size 在 Windows 上恒为 0，没有展示意义；
        // 改为统计直接子条目数（快速、有意义的目录规模指标）
        entryCount = readdirSync(path, { withFileTypes: true }).length;
      } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
      result.push({ name: entry.name, path, mtime, size: 0, entryCount });
    }
    return result;
  }

  /**
   * 新建 profile 目录
   * @param {string} name
   * @returns {Promise<{success: boolean, name: string, path: string}>}
   */
  async create(name) {
    const trimmed = (name || '').trim();
    if (!trimmed || !PROFILE_NAME_PATTERN.test(trimmed)) {
      throw new DSHError(
        DSHErrorCodes.CONFIG_PARSE_ERROR,
        'Profile 名称只能包含字母、数字、下划线、连字符且不超过 32 字符'
      );
    }
    const path = join(this.profilesDir, trimmed);
    if (existsSync(path)) {
      throw new DSHError(DSHErrorCodes.ALREADY_EXISTS, `Profile "${trimmed}" 已存在`);
    }
    mkdirSync(path, { recursive: true });
    return { success: true, name: trimmed, path };
  }

  /**
   * 备份 profile 到 manager/backups/<name>-<时间戳>/
   * @param {string} name
   * @returns {Promise<{success: boolean, name: string, backupPath: string}>}
   */
  async backup(name) {
    const trimmed = (name || '').trim();
    // 安全校验：name 必须是合法 profile 名（与 create 一致），防止 ../ 备份任意目录
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, `非法的 profile 名称: "${trimmed}"`);
    }
    const src = join(this.profilesDir, trimmed);
    if (!existsSync(src)) {
      throw new DSHError(DSHErrorCodes.NOT_FOUND, `Profile "${trimmed}" 不存在`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(this.backupDir, `${trimmed}-${timestamp}`);
    mkdirSync(this.backupDir, { recursive: true });
    // 排除 node_modules/.git 等大目录，避免备份过慢且占空间
    const IGNORE = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.venv', 'venv']);
    const filter = (src) => {
      const base = src.split(/[\\/]/).pop();
      return !IGNORE.has(base);
    };
    cpSync(src, dest, { recursive: true, filter });

    return { success: true, name: trimmed, backupPath: dest };
  }
}
