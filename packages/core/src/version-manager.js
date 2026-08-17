/**
 * @dsh-manager/core - DSH 版本管理器
 * 
 * 多版本管理、版本切换、版本回滚
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS, getDSHVersion, isDSHInstalled } from './dsh-utils.js';

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
      isCurrent: v.version === current,
    }));
  }

  /**
   * 记录一个版本
   * @param {string} version
   */
  async recordVersion(version) {
    const versions = this._readVersions();
    
    const existing = versions.find(v => v.version === version);
    if (existing) {
      existing.installedAt = new Date().toISOString();
    } else {
      versions.push({
        version,
        installedAt: new Date().toISOString(),
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
   * 获取最新稳定版本信息（多源检查：npm → GitHub API）
   * @returns {Promise<{version: string, publishedAt: string, source: string}|null>}
   */
  async getLatestVersion() {
    // ① 优先从 npm registry 获取（国内通常可访问）
    try {
      const { stdout } = await execa('npm', [
        'view', '@deepseek-ai/dsh', 'version', '--json',
      ], { timeout: 15_000, reject: false });

      if (stdout && stdout.trim()) {
        const version = JSON.parse(stdout);
        if (typeof version === 'string' && version) {
          return { version, publishedAt: new Date().toISOString(), source: 'npm' };
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
        { signal: controller.signal, headers: { 'User-Agent': 'dsh-manager/0.3.0' } }
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
        return JSON.parse(readFileSync(this.versionsFile, 'utf-8'));
      }
    } catch {}
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
   * 简易版本比较
   * @private
   */
  _compareVersions(a, b) {
    const partsA = a.replace(/[^0-9.]/g, '').split('.').map(Number);
    const partsB = b.replace(/[^0-9.]/g, '').split('.').map(Number);
    
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA !== numB) return numA - numB;
    }
    return 0;
  }
}