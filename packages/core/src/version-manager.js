/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS, getDSHVersion, isDSHInstalled, compareDSHVersions } from './dsh-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** DSH Manager 自身版本（读取仓库根 package.json，避免硬编码漂移） */
const MANAGER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** 归一化版本号：去掉 v 前缀与首尾空白，用于等值比较 */
function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

export class DSHVersionManager {
  constructor() {
    this.versionsFile = join(DSH_PATHS.managerDir, 'versions.json');
  }

  /**
   * 获取所有已安装的版本
   * @returns {Promise<Array<{version: string, installedAt: string, isCurrent: boolean}>>}
   */
  async getInstalledVersions() {
    const current = await getDSHVersion();
    const versions = this._readVersions();
    
    return versions.map(v => ({
      ...v,
      // 语义化比较（忽略 v 前缀差异），比字符串 === 更健壮
      isCurrent: v.version ? normalizeVersion(v.version) === normalizeVersion(current) : false,
    }));
  }

  /**
   * 记录一个版本
   * @param {string} version
   */
  async recordVersion(version, installPath = null) {
    const versions = this._readVersions();

    const existing = versions.find(v => v.version === version);
    if (existing) {
      existing.installedAt = new Date().toISOString();
      // 记录实际安装路径（用于检测兜底与诊断）
      if (installPath) existing.path = installPath;
    } else {
      versions.push({
        version,
        installedAt: new Date().toISOString(),
        ...(installPath ? { path: installPath } : {}),
      });
    }

    this._writeVersions(versions);
  }

  /**
   * 删除版本记录
   * @param {string} version
   */
  async removeVersion(version) {
    let versions = this._readVersions();
    versions = versions.filter(v => v.version !== version);
    this._writeVersions(versions);
  }

  /**
   * 获取最新版本信息（多源检查：npm dist-tags → GitHub API）
   *
   * 注意：@deepseek-ai/dsh 目前全部为 rc 预发布版本，npm 的 latest tag
   * 往往滞后于 next tag（如 latest=0.1.0-rc.7 而 next=0.1.0-rc.8）。
   * 只查 `npm view version`（latest）会漏掉 next 上的更新，
   * 因此这里读取全部 dist-tags 并取语义化版本号最高的一个。
   * @returns {Promise<{version: string, publishedAt: string, source: string}|null>}
   */
  async getLatestVersion() {
    // ① 优先从 npm registry 获取 dist-tags（国内通常可访问）
    try {
      const { stdout } = await execa('npm', [
        'view', '@deepseek-ai/dsh', 'dist-tags', '--json',
      ], { timeout: 15_000, reject: false, windowsHide: true });

      if (stdout && stdout.trim()) {
        const tags = JSON.parse(stdout);
        const versions = Object.values(tags)
          .filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v.trim()));
        if (versions.length > 0) {
          // 语义化版本号最高的 tag 视为最新（覆盖 latest/next 双通道）
          const latest = versions.reduce((best, v) =>
            compareDSHVersions(v, best) > 0 ? v : best, versions[0]);
          return { version: latest, publishedAt: new Date().toISOString(), source: 'npm' };
        }
      }
    } catch {
      // npm 不可用，继续尝试 GitHub API
    }

    // ② npm 失败时从 GitHub API 获取 DSH 最新 release
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(
        'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/latest',
        { signal: controller.signal, headers: { 'User-Agent': 'dsh-manager/' + MANAGER_VERSION } }
      );
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const tag = (data.tag_name || '').replace(/^v/, '');
        if (tag) {
          return { version: tag, publishedAt: data.published_at, source: 'github' };
        }
      }
    } catch {
      // GitHub API 也不可用
    }

    return null;
  }

  /**
   * 获取版本获取方式的说明（用于 UI 提示）
   * @returns {Promise<{method: string, source: string}>}
   */
  async getUpdateSourceInfo() {
    const latest = await this.getLatestVersion();
    if (!latest) {
      return { method: '离线', source: '无可用源' };
    }
    const sourceLabels = {
      npm: 'npm registry',
      github: 'GitHub API',
    };
    return {
      method: sourceLabels[latest.source] || latest.source,
      source: latest.source,
    };
  }

  /**
   * 检查是否有新版本
   * @returns {Promise<{hasUpdate: boolean, current: string|null, latest: string|null}>}
   */
  async checkForUpdate() {
    const current = await getDSHVersion();
    const latest = await this.getLatestVersion();
    
    if (!current || !latest) {
      return { hasUpdate: false, current, latest: latest?.version || null };
    }

    const hasUpdate = this._compareVersions(current, latest.version) < 0;
    return { hasUpdate, current, latest: latest.version };
  }

  /**
   * @private
   */
  _readVersions() {
    try {
      if (existsSync(this.versionsFile)) {
        const data = JSON.parse(readFileSync(this.versionsFile, 'utf-8'));
        // 校验必须是数组（防止坏文件/异常结构导致 find/filter 崩溃）
        if (Array.isArray(data)) return data;
        // 非法结构：备份坏文件并重置（避免反复解析失败）
        try { renameSync(this.versionsFile, this.versionsFile + '.corrupt-' + Date.now()); } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
      }
    } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
    return [];
  }

  /**
   * @private
   */
  _writeVersions(versions) {
    const dir = join(DSH_PATHS.managerDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.versionsFile, JSON.stringify(versions, null, 2), 'utf-8');
  }

  /**
   * 版本比较（支持 DSH 的 0.x-rc.N 预发布格式）
   * 规则：主/次/修订逐段比较；带 -rc.N 的预发布版本 < 对应正式版本（正式版 pre=Infinity）
   * 实现复用 dsh-utils 的公共 compareDSHVersions，保证各模块排序/比较一致。
   * @param {string} a
   * @param {string} b
   * @returns {number} a<b 返回负数，a>b 返回正数，相等返回 0
   * @private
   */
  _compareVersions(a, b) {
    return compareDSHVersions(a, b);
  }
}