/**
 * @dsh-manager/marketplace - 插件安装器
 * 
 * 从 GitHub/npm 安装 DSH 插件到指定 profile
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DSHError, DSHErrorCodes, requirePnpm, DSH_PATHS } from '../../core/src/index.js';
import { PluginRegistry } from './registry.js';

export class PluginInstaller {
  /**
   * @param {object} [options]
   * @param {PluginRegistry} [options.registry]
   * @param {string} [options.profile='web'] - 目标 profile
   * @param {boolean} [options.verbose] - 详细日志
   */
  constructor(options = {}) {
    this.registry = options.registry || new PluginRegistry(options);
    this.profile = options.profile || 'web';
    this.verbose = options.verbose || false;
    this.logs = [];
    this.onProgress = options.onProgress || null;
  }

  /**
   * 安装插件
   * @param {string} source - 插件来源 (github:owner/repo 或 npm:package-name)
   * @param {object} [options]
   * @param {string} [options.profile] - 目标 profile
   * @param {boolean} [options.fromMarketplace] - 是否从市场安装
   * @returns {Promise<{success: boolean, id: string, name: string, version: string, path: string}>}
   */
  async install(source, options = {}) {
    const profile = options.profile || this.profile;
    this._log(`安装插件: ${source} → profile: ${profile}`);

    // 解析来源
    const parsed = this._parseSource(source);
    
    // 获取插件信息
    let pluginInfo = {};
    if (parsed.type === 'github') {
      this._log(`获取 GitHub 仓库信息: ${parsed.owner}/${parsed.repo}`);
      pluginInfo = await this._getGitHubPluginInfo(parsed.owner, parsed.repo);
      // 有 npm 包名则优先走 npm（更快），否则 git 安装
      if (pluginInfo.npmPackage) {
        this._log(`发现 npm 包: ${pluginInfo.npmPackage}，优先使用 npm 安装`);
        return await this._installFromNpm(pluginInfo.npmPackage, profile, pluginInfo);
      }
    }

    // 执行安装
    if (parsed.type === 'npm') {
      return await this._installFromNpm(parsed.packageName, profile, pluginInfo);
    } else if (parsed.type === 'github') {
      return await this._installFromGitHub(parsed.owner, parsed.repo, profile, pluginInfo);
    } else if (parsed.type === 'git') {
      return await this._installFromGit(parsed.url, profile, pluginInfo);
    } else if (parsed.type === 'file') {
      return await this._installFromFile(parsed.path, profile);
    } else {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `不支持的插件来源: ${source}`
      );
    }
  }

  /**
   * 卸载插件
   * @param {string} pluginId - 插件 ID
   * @param {object} [options]
   * @param {string} [options.profile]
   * @returns {Promise<{success: boolean}>}
   */
  async uninstall(pluginId, options = {}) {
    const profile = options.profile || this.profile;
    this._log(`卸载插件: ${pluginId} from ${profile}`);

    try {
      // 检查 pnpm 是否已安装（dsh plugin 命令依赖 pnpm）
      await requirePnpm('卸载插件');

      // 从本地注册表移除
      this.registry.unregisterLocalPlugin(pluginId);

      // 通过 dsh plugin 命令卸载
      const { stdout, stderr } = await execa('dsh', [
        'plugin', '--profile', profile, 'remove', pluginId,
      ], { reject: false });

      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      return { success: true };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `插件卸载失败: ${error.message}`
      );
    }
  }

  /**
   * 更新插件
   * @param {string} pluginId
   * @param {object} [options]
   * @returns {Promise<{success: boolean, oldVersion: string, newVersion: string}>}
   */
  async update(pluginId, options = {}) {
    this._log(`更新插件: ${pluginId}`);

    const plugins = this.registry.getLocalPlugins();
    const plugin = plugins.find(p => p.id === pluginId);
    
    if (!plugin) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `插件未找到: ${pluginId}`);
    }

    const oldVersion = plugin.version;

    // 重新安装（覆盖更新）
    const result = await this.install(plugin.source, {
      ...options,
      profile: plugin.profile || options.profile,
    });

    return {
      success: result.success,
      oldVersion,
      newVersion: result.version,
    };
  }

  /**
   * @private
   */
  async _installFromNpm(packageName, profile, info) {
    this._log(`通过 npm 安装: ${packageName}`);

    try {
      // 检查 pnpm 是否已安装（dsh plugin 命令依赖 pnpm）
      await requirePnpm('安装插件');

      const { stdout, stderr } = await execa('dsh', [
        'plugin', '--profile', profile, 'add', packageName,
      ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe' });

      this._log(stdout || '');

      // 获取 npm 包信息
      const npmInfo = await this._getNpmPackageInfo(packageName);
      const pluginId = info.id || packageName.split('/').pop() || packageName;

      // 注册到本地列表
      this.registry.registerLocalPlugin({
        id: pluginId,
        name: info.name || npmInfo.name || packageName,
        version: npmInfo.version || 'latest',
        source: `npm:${packageName}`,
        profile,
        type: 'npm',
        installedAt: new Date().toISOString(),
        description: info.description || npmInfo.description || '',
      });

      return {
        success: true,
        id: pluginId,
        name: info.name || packageName,
        version: npmInfo.version || 'latest',
        path: '',
      };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `npm 安装失败: ${error.message}`
      );
    }
  }

  /**
   * @private
   */
  async _installFromGitHub(owner, repo, profile, info) {
    this._log(`从 GitHub 安装: ${owner}/${repo}`);

    // 检查是否有 npm 包名
    if (info.npmPackage) {
      this._log(`发现 npm 包: ${info.npmPackage}，通过 npm 安装`);
      return await this._installFromNpm(info.npmPackage, profile, info);
    }

    // 没有 npm 包，尝试通过 git URL 安装
    const gitUrl = `https://github.com/${owner}/${repo}.git`;
    
    try {
      const { stdout, stderr } = await execa('dsh', [
        'plugin', '--profile', profile, 'add', gitUrl,
      ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe' });

      this._log(stdout || '');

      const pluginId = info.id || repo;

      this.registry.registerLocalPlugin({
        id: pluginId,
        name: info.name || repo,
        version: info.latestRelease || 'main',
        source: `github:${owner}/${repo}`,
        profile,
        type: 'github',
        installedAt: new Date().toISOString(),
        description: info.description || '',
        repoUrl: `https://github.com/${owner}/${repo}`,
      });

      return {
        success: true,
        id: pluginId,
        name: info.name || repo,
        version: info.latestRelease || 'main',
        path: '',
      };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `GitHub 安装失败: ${error.message}`
      );
    }
  }

  /**
   * @private
   */
  async _getGitHubPluginInfo(owner, repo) {
    try {
      const details = await this.registry.github.getRepoDetails(owner, repo);
      const packageJson = await this.registry.github.getPackageJson(owner, repo);
      const releases = await this.registry.github.getReleases(owner, repo, 1);
      
      return {
        id: repo,
        name: details.name,
        description: details.description,
        npmPackage: packageJson?.name || null,
        version: packageJson?.version || null,
        latestRelease: releases[0]?.tag?.replace(/^v/, '') || null,
      };
    } catch {
      return { id: repo, name: repo };
    }
  }

  /**
   * @private
   */
  async _getNpmPackageInfo(packageName) {
    try {
      const { stdout } = await execa('npm', [
        'view', packageName, 'name', 'version', 'description', '--json',
      ], { timeout: 30_000, reject: false });
      
      if (stdout) {
        return JSON.parse(stdout);
      }
    } catch {}
    return { name: packageName, version: 'latest', description: '' };
  }

  /**
   * @private
   */
  _parseSource(source) {
    if (source.startsWith('github:')) {
      const fullName = source.replace('github:', '');
      const [owner, repo] = fullName.split('/');
      return { type: 'github', owner, repo, fullName };
    }
    
    if (source.startsWith('npm:')) {
      return { type: 'npm', packageName: source.replace('npm:', '') };
    }

    // 本地目录安装：file:<绝对路径>
    if (source.startsWith('file:')) {
      return { type: 'file', path: source.replace(/^file:/, '') };
    }

    // Git URL 直装：git:<url> / git+https:// / git+ssh:// / git@
    if (source.startsWith('git:') || source.startsWith('git+https://') || source.startsWith('git+ssh://') || source.startsWith('git@')) {
      const url = source.startsWith('git:') ? source.replace(/^git:/, '') : source;
      return { type: 'git', url };
    }
    
    if (source.includes('/') && source.includes('github.com')) {
      const match = source.match(/github\.com\/([^/]+)\/([^/.]+)/);
      if (match) {
        return { type: 'github', owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
      }
    }
    
    // 默认视为 npm 包
    if (source.includes('/') || source.startsWith('@')) {
      return { type: 'npm', packageName: source };
    }
    
    // 假设是 GitHub owner/repo 格式
    if (source.includes('/')) {
      const [owner, repo] = source.split('/');
      return { type: 'github', owner, repo, fullName: source };
    }
    
    // 默认 npm
    return { type: 'npm', packageName: source };
  }

  /**
   * @private
   * 从 Git URL 安装插件（git clone 到插件缓存并注册）
   * @param {string} url - git 仓库地址
   * @param {string} profile
   * @param {object} [info]
   */
  async _installFromGit(url, profile, info = {}) {
    this._log(`从 Git 安装: ${url}`);

    // 从 URL 提取仓库名
    const repoMatch = url.match(/([^/]+?)(?:\.git)?$/);
    const repoName = repoMatch ? repoMatch[1] : basename(url) || 'plugin';

    // 目标缓存目录
    const cacheRoot = DSH_PATHS.pluginCache;
    const dest = join(cacheRoot, repoName);

    try {
      if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
      // 清空旧缓存避免冲突
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

      this._log(`执行: git clone --depth 1 ${url}`);
      const { stdout, stderr } = await execa('git', ['clone', '--depth', '1', url, dest], {
        timeout: 120_000,
        stdio: this.verbose ? 'inherit' : 'pipe',
      });
      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      // 读取 package.json
      let pkg = null;
      try {
        const pkgRaw = readFileSync(join(dest, 'package.json'), 'utf-8');
        pkg = JSON.parse(pkgRaw);
      } catch {}

      const pluginId = info.id || pkg?.name || repoName;
      const version = pkg?.version || 'main';

      this.registry.registerLocalPlugin({
        id: pluginId,
        name: info.name || pkg?.name || repoName,
        version,
        source: `git:${url}`,
        profile,
        type: 'git',
        installedAt: new Date().toISOString(),
        description: info.description || pkg?.description || '',
        repoUrl: url,
      });

      return { success: true, id: pluginId, name: pluginId, version, path: dest };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `Git 安装失败: ${error.message}（请确认已安装 git 且地址可访问）`
      );
    }
  }

  /**
   * @private
   * 从本地目录安装插件（复制到插件缓存并注册）
   * @param {string} dir - 本地插件目录
   * @param {string} profile
   */
  async _installFromFile(dir, profile) {
    this._log(`从本地目录安装: ${dir}`);

    if (!dir || !existsSync(dir)) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `本地目录不存在: ${dir}`);
    }

    // 校验 package.json
    const pkgPath = join(dir, 'package.json');
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `目录中未找到有效的 package.json: ${dir}`
      );
    }

    const pluginName = pkg.name || basename(dir);
    const cacheRoot = DSH_PATHS.pluginCache;
    const dest = join(cacheRoot, pluginName);

    try {
      if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(dir, dest, { recursive: true });

      const pluginId = pluginName;
      this.registry.registerLocalPlugin({
        id: pluginId,
        name: pkg.name || pluginName,
        version: pkg.version || 'local',
        source: `file:${dir}`,
        profile,
        type: 'file',
        installedAt: new Date().toISOString(),
        description: pkg.description || '',
      });

      return { success: true, id: pluginId, name: pluginName, version: pkg.version || 'local', path: dest };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `本地目录安装失败: ${error.message}`
      );
    }
  }

  /**
   * @private
   */
  _log(message, level = 'info') {
    this.logs.push({ level, message, timestamp: new Date().toISOString() });
    if (this.onProgress) {
      this.onProgress({ level, message });
    }
  }

  getLogs() {
    return [...this.logs];
  }
}