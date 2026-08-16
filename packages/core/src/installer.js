/**
 * @dsh-manager/core - DSH 安装器
 * 
 * 支持多种安装方式：npm、源码编译、版本切换
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS, isDSHInstalled, getDSHVersion } from './dsh-utils.js';

/**
 * 安装器配置
 */
const INSTALL_OPTIONS = {
  /** npm 安装超时（毫秒） */
  npmInstallTimeout: 300_000,
  /** 默认 npm registry */
  defaultRegistry: 'https://registry.npmjs.org',
  /** 镜像 registry */
  mirrors: {
    npm: 'https://registry.npmjs.org',
    npmmirror: 'https://registry.npmmirror.com',
  },
};

export class DSHInstaller {
  /**
   * @param {object} [options]
   * @param {string} [options.registry] - npm registry URL
   * @param {boolean} [options.verbose] - 是否显示详细日志
   * @param {function} [options.onProgress] - 进度回调
   */
  constructor(options = {}) {
    this.options = {
      ...INSTALL_OPTIONS,
      ...options,
    };
    this.logs = [];
  }

  /**
   * 安装 DSH
   * @param {string} [version] - 指定版本，默认最新
   * @param {object} [opts]
   * @param {boolean} [opts.global] - 全局安装
   * @returns {Promise<{success: boolean, version: string, path: string}>}
   */
  async install(version, opts = {}) {
    const { global = true } = opts;
    
    this._log('开始安装 DSH...');
    
    // 检查是否已安装
    const alreadyInstalled = await isDSHInstalled();
    if (alreadyInstalled) {
      const currentVersion = await getDSHVersion();
      this._log(`DSH ${currentVersion} 已安装`);
    }

    // 构建 npm 安装参数
    const packageName = version 
      ? `@deepseek-ai/dsh@${version}`
      : '@deepseek-ai/dsh';

    const args = ['install', '-g', packageName];
    
    // 如果指定了镜像 registry
    if (this.options.registry && this.options.registry !== INSTALL_OPTIONS.defaultRegistry) {
      args.push('--registry', this.options.registry);
    }

    this._log(`执行: npm ${args.join(' ')}`);

    try {
      // 先创建 DSH_HOME 目录结构
      this._ensureDSHHome();

      const { stdout, stderr } = await execa('npm', args, {
        timeout: this.options.npmInstallTimeout,
        stdio: this.options.verbose ? 'inherit' : 'pipe',
      });

      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      // 验证安装
      const installed = await isDSHInstalled();
      if (!installed) {
        throw new DSHError(
          DSHErrorCodes.DSH_INSTALL_FAILED,
          'DSH 安装验证失败，dsh 命令不可用'
        );
      }

      const newVersion = await getDSHVersion();
      this._log(`DSH ${newVersion} 安装成功！`);

      return {
        success: true,
        version: newVersion,
        path: await this._getDSHPath(),
      };
    } catch (error) {
      if (error instanceof DSHError) throw error;
      throw new DSHError(
        DSHErrorCodes.DSH_INSTALL_FAILED,
        `DSH 安装失败: ${error.message}`,
        { originalError: error.message }
      );
    }
  }

  /**
   * 卸载 DSH
   * @returns {Promise<{success: boolean}>}
   */
  async uninstall() {
    this._log('开始卸载 DSH...');

    const installed = await isDSHInstalled();
    if (!installed) {
      this._log('DSH 未安装，无需卸载');
      return { success: true };
    }

    try {
      await execa('npm', ['uninstall', '-g', '@deepseek-ai/dsh'], {
        timeout: 60_000,
        stdio: this.options.verbose ? 'inherit' : 'pipe',
      });
      this._log('DSH 卸载成功');
      return { success: true };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.DSH_UNINSTALL_FAILED,
        `DSH 卸载失败: ${error.message}`,
        { originalError: error.message }
      );
    }
  }

  /**
   * 升级 DSH 到最新版本
   * @returns {Promise<{success: boolean, oldVersion: string|null, newVersion: string}>}
   */
  async upgrade() {
    const oldVersion = await getDSHVersion();
    this._log(`当前版本: ${oldVersion || '未安装'}`);

    const result = await this.install('latest');
    return {
      success: result.success,
      oldVersion,
      newVersion: result.version,
    };
  }

  /**
   * 切换 DSH 版本
   * @param {string} version - 目标版本
   * @returns {Promise<{success: boolean, oldVersion: string|null, newVersion: string}>}
   */
  async switchVersion(version) {
    const oldVersion = await getDSHVersion();
    this._log(`版本切换: ${oldVersion || '未安装'} → ${version}`);

    // 先卸载旧版本
    await this.uninstall();
    // 安装指定版本
    const result = await this.install(version);

    return {
      success: result.success,
      oldVersion,
      newVersion: result.version,
    };
  }

  /**
   * 获取可用的 DSH 版本列表
   * @returns {Promise<string[]>}
   */
  async getAvailableVersions() {
    try {
      const registry = this.options.registry || INSTALL_OPTIONS.defaultRegistry;
      const { stdout } = await execa('npm', [
        'view', '@deepseek-ai/dsh', 'versions', '--json',
        '--registry', registry,
      ], { timeout: 30_000, reject: false });

      if (stdout) {
        return JSON.parse(stdout)
          .filter(v => v.startsWith('0.'))
          .reverse();
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * 获取安装日志
   * @returns {string[]}
   */
  getLogs() {
    return [...this.logs];
  }

  /** @private */
  _log(message, level = 'info') {
    this.logs.push({ level, message, timestamp: new Date().toISOString() });
    if (this.options.onProgress) {
      this.options.onProgress({ level, message });
    }
  }

  /** @private */
  _ensureDSHHome() {
    const dirs = [
      DSH_PATHS.home,
      DSH_PATHS.profiles,
      DSH_PATHS.sessions,
      DSH_PATHS.skills,
      DSH_PATHS.storages,
      DSH_PATHS.managerDir,
      DSH_PATHS.pluginCache,
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        this._log(`创建目录: ${dir}`);
      }
    }
  }

  /** @private */
  async _getDSHPath() {
    try {
      const { stdout } = await execa('node', [
        '-e', 'console.log(require.resolve("@deepseek-ai/dsh/package.json"))'
      ], { reject: false });
      if (stdout) {
        const { dirname } = await import('node:path');
        return dirname(stdout.trim());
      }
    } catch {}
    return null;
  }
}