/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS, isDSHInstalled, getDSHVersion, getDSHPath } from './dsh-utils.js';
import { requireNodeAndNpm } from './env-check.js';

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
   * @param {string} [opts.tool] - 安装工具 'auto' | 'npm' | 'pnpm' | 'mirror'（默认 auto：npm 失败自动切 pnpm）
   * @returns {Promise<{success: boolean, version: string, path: string, tool: string}>}
   */
  async install(version, opts = {}) {
    const { global = true, tool = 'auto' } = opts;
    
    this._log('开始安装 DSH...');

    // 基础环境检测：npm 未安装时给出 Node.js 安装引导，而非 ENOENT 报错
    try {
      await requireNodeAndNpm('安装 DSH');
    } catch (error) {
      throw new DSHError(DSHErrorCodes.DSH_INSTALL_FAILED, error.message);
    }

    // 检查是否已安装
    const alreadyInstalled = await isDSHInstalled();
    if (alreadyInstalled) {
      const currentVersion = await getDSHVersion();
      this._log(`DSH ${currentVersion} 已安装`);
    }

    // 尝试的安装工具列表
    let tools = [];
    if (tool === 'auto') tools = ['npm', 'pnpm', 'corepack'];
    else if (tool === 'mirror') tools = ['npm-mirror', 'pnpm'];
    else tools = [tool];

    let errors = [];
    for (const t of tools) {
      try {
        const result = await this._installWithTool(version, t);
        return { ...result, tool: t };
      } catch (error) {
        errors.push({ tool: t, message: error.message });
        this._log(`${t} 安装尝试失败: ${error.message}`, 'warn');
      }
    }

    // 汇总所有工具的失败原因，便于用户排查
    const summary = errors.map(e => `  - ${e.tool}: ${e.message}`).join('\n');
    throw new DSHError(
      DSHErrorCodes.DSH_INSTALL_FAILED,
      `DSH 安装失败（已尝试 ${tools.join(' / ')}）:\n${summary}\n\n请检查网络连接、npm 全局安装权限，或更换镜像源后重试。`
    );
  }

  /**
   * 使用指定工具安装 DSH
   * @private
   */
  async _installWithTool(version, tool) {
    // 构建包名
    const packageName = version
      ? `@deepseek-ai/dsh@${version}`
      : '@deepseek-ai/dsh';

    this._ensureDSHHome();

    if (tool === 'npm' || tool === 'npm-mirror') {
      const args = ['install', '-g', packageName];
      if (tool === 'npm-mirror') {
        args.push('--registry', INSTALL_OPTIONS.mirrors.npmmirror);
      } else if (this.options.registry && this.options.registry !== INSTALL_OPTIONS.defaultRegistry) {
        args.push('--registry', this.options.registry);
      }
      this._log(`执行: npm ${args.join(' ')}`);
      await execa('npm', args, {
        timeout: this.options.npmInstallTimeout,
        stdio: this.options.verbose ? 'inherit' : 'pipe',
      });
    } else if (tool === 'pnpm') {
      // pnpm 全局安装
      const args = ['add', '-g', packageName];
      if (this.options.registry) {
        args.push('--registry', this.options.registry);
      }
      this._log(`执行: pnpm ${args.join(' ')}`);
      await execa('pnpm', args, {
        timeout: this.options.npmInstallTimeout,
        stdio: this.options.verbose ? 'inherit' : 'pipe',
      });
    } else if (tool === 'corepack') {
      // corepack 引导 + pnpm 安装组合：
      // corepack 只能分发 yarn/pnpm 等包管理器，故先用 corepack enable 启用 pnpm，再走 pnpm 全局安装
      this._log('执行: corepack enable（启用 Node 内置包管理器）');
      try {
        await execa('corepack', ['enable'], {
          timeout: 60_000,
          stdio: this.options.verbose ? 'inherit' : 'pipe',
        });
      } catch (error) {
        // Node.js 16.9+ 自带 corepack，失败多为 PATH/权限问题，给出明确提示而非再次尝试安装
        throw new DSHError(
          DSHErrorCodes.DSH_INSTALL_FAILED,
          `corepack 不可用: ${error.shortMessage || error.message}\nNode.js 16.9+ 已内置 corepack，请确认 Node 版本与 PATH 配置，或改用 npm/pnpm 安装。`
        );
      }
      // 复用 pnpm 安装逻辑
      const args = ['add', '-g', packageName];
      if (this.options.registry) {
        args.push('--registry', this.options.registry);
      }
      this._log(`执行: pnpm ${args.join(' ')}`);
      await execa('pnpm', args, {
        timeout: this.options.npmInstallTimeout,
        stdio: this.options.verbose ? 'inherit' : 'pipe',
      });
    }

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
    // 安装指定版本（失败时回滚到旧版本）
    try {
      const result = await this.install(version);
      return {
        success: result.success,
        oldVersion,
        newVersion: result.version,
      };
    } catch (error) {
      this._log(`版本切换失败，尝试恢复旧版本 ${oldVersion}...`, 'warn');
      try {
        await this.install(oldVersion);
        this._log(`已恢复旧版本 ${oldVersion}`, 'info');
      } catch (restoreError) {
        this._log(`恢复旧版本失败: ${restoreError.message}。DSH 当前可能已卸载。`, 'error');
      }
      throw error;
    }
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
    // 复用 dsh-utils 的共享实现，避免重复
    return getDSHPath();
  }
}