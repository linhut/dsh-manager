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
   * 获取最新稳定版本信息
   * @returns {Promise<{version: string, publishedAt: string}|null>}
   */
  async getLatestVersion() {
    try {
      const { stdout } = await execa('npm', [
        'view', '@deepseek-ai/dsh', 'version', '--json',
      ], { timeout: 30_000, reject: false });

      if (stdout) {
        const version = JSON.parse(stdout);
        return { version, publishedAt: new Date().toISOString() };
      }
      return null;
    } catch {
      return null;
    }
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