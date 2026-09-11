/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { DSHError, DSHErrorCodes, requirePnpm, DSH_PATHS, resolveDSHCommand, compareDSHVersions } from '../../core/src/index.js';
import { PluginRegistry } from './registry.js';
import { githubProxyUrls } from './github-api.js';

/**
 * 组装 `dsh plugin` 转发给 pnpm 的 add 参数（纯函数，便于单测）。
 *
 * `dsh plugin --profile <p> <args...>` 是 pnpm 的「薄转发器」：参数原样交给
 * profile 目录下的 pnpm add，因此这里拼出的参数即最终生效的安装参数。
 *
 * - 更新场景固定目标版本：pnpm 对「已满足 semver 区间」的依赖会直接跳过安装
 *   （回报 Already up to date / downloaded 0, added 0），导致更新空转却不报错。
 * - force=true 时追加 --force：pnpm 不再走「已满足即跳过」的短路，同版本也会
 *   重建该依赖（用于「显示成功但模块未落盘」的兜底重装）。
 *
 * @param {string} profile - 目标 profile
 * @param {string} packageName - npm 包名（含 scope）
 * @param {object} [options]
 * @param {string} [options.targetVersion] - 固定安装的目标版本
 * @param {boolean} [options.force] - 强制重装
 * @returns {string[]} 传给 dsh/pnpm 的完整参数数组
 */
export function buildPluginAddArgs(profile, packageName, options = {}) {
  const targetVersion = String(options.targetVersion || '').trim();
  const addSpec = targetVersion && targetVersion !== 'latest'
    ? `${packageName}@${targetVersion}`
    : packageName;

  const args = ['plugin', '--profile', profile, 'add', addSpec];
  if (options.force === true) args.push('--force');
  return args;
}

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
    this._dshCmdCache = null;
  }

  /**
   * 获取 dsh 可执行命令（缓存）
   * 用户可能通过自定义 npm prefix（如 E:\npm-global）安装 dsh，该目录未必在 PATH 中，
   * 直接 execa('dsh') 会失败导致安装卡住/报错。通过 resolveDSHCommand 解析真实命令。
   * @returns {Promise<string>}
   * @private
   */
  async _dshCmd() {
    if (!this._dshCmdCache) {
      this._dshCmdCache = await resolveDSHCommand();
      this._log(`dsh 命令解析为: ${this._dshCmdCache}`);
    }
    return this._dshCmdCache;
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

    // 拦截 CLI flag 误当包名的输入（如 "--mcp"），防止产生幽灵注册条目
    if (parsed.type === 'npm' && !this._isValidNpmPackageName(parsed.packageName)) {
      throw new DSHError(DSHErrorCodes.PLUGIN_INSTALL_FAILED, `非法的 npm 包名: ${parsed.packageName}（不允许以 - 开头的参数或非法名称）`);
    }
    if (parsed.type === 'github' && (!parsed.owner || !parsed.repo || /^-/.test(parsed.repo))) {
      throw new DSHError(DSHErrorCodes.PLUGIN_INSTALL_FAILED, `非法的 GitHub 仓库: ${parsed.owner || ''}/${parsed.repo || ''}`);
    }
    
    // 获取插件信息
    let pluginInfo = {};
    if (parsed.type === 'github') {
      this._log(`获取 GitHub 仓库信息: ${parsed.owner}/${parsed.repo}`);
      pluginInfo = await this._getGitHubPluginInfo(parsed.owner, parsed.repo);
    }

    // 执行安装
    if (parsed.type === 'npm') {
      return await this._installFromNpm(parsed.packageName, profile, pluginInfo, options);
    } else if (parsed.type === 'github') {
      return await this._installFromGitHub(parsed.owner, parsed.repo, profile, pluginInfo, parsed.ref, options);
    } else if (parsed.type === 'git') {
      return await this._installFromGit(parsed.url, profile, pluginInfo, options);
    } else if (parsed.type === 'link') {
      return await this._installFromLink(parsed.path, profile);
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

      // ① 官方命令：dsh plugin --profile <name> remove <id>（真实卸载 + 同步 profile bundles）
      let dshRemoved = false;
      let dshError = null;
      try {
        const result = await execa(await this._dshCmd(), [
          'plugin', '--profile', profile, 'remove', pluginId,
        ], { reject: false, timeout: 60_000, windowsHide: true });
        if (result.stdout) this._log(result.stdout);
        if (result.stderr) this._log(result.stderr, 'warn');
        dshRemoved = result.exitCode === 0;
        if (!dshRemoved) dshError = `dsh plugin remove 退出码 ${result.exitCode}`;
      } catch (e) {
        dshError = e.message;
        this._log('dsh plugin remove 失败: ' + e.message, 'warn');
      }

      // ② 兜底：清理 patch 文件中的条目（兼容非标准插件如 gongwen-skill 等）
      try {
        this.registry.cleanupPatchEntries(profile, pluginId);
      } catch (e) {
        this._log('清理 patch 文件失败: ' + e.message, 'warn');
      }

      // ③ 仅当官方卸载成功（或经 patch 清理确认）后才移除本地注册条目，
      //    避免"本地列表已删但实际仍安装"的不一致状态。
      if (dshRemoved) {
        this.registry.unregisterLocalPlugin(pluginId);
        return { success: true, needsRestart: true, method: 'official'};
      }
      // 官方命令失败但已清理 patch → 保守保留本地条目，提示用户
      this._log(`dsh plugin remove 未确认成功（${dshError || '未知原因'}），本地条目保留以便重试`, 'warn');
      return { success: false, error: dshError || 'dsh plugin remove 未确认成功', keepLocal: true };
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `插件卸载失败: ${error.message}`
      );
    }
  }

  /**
   * 更新插件
   * 流程：
   *   ① 前置版本校验（registry.checkPluginUpdate：GitHub release / npm view 与磁盘版本比对）
   *   ② 未检测到新版本 → 明确回报「已是最新」，不再空转重装并谎报成功
   *   ③ 有更新 → 按目标版本精确重装（npm 源固定到具体版本号，避免 pnpm 因 semver
   *      区间已满足而回报 "Already up to date / downloaded 0 added 0"）
   *   ④ 重装后回读磁盘 node_modules/<pkg>/package.json，做真值断言：
   *      版本未真正落盘则抛错，绝不把「空更新」当成功
   * @param {string} pluginId
   * @param {object} [options]
   * @param {boolean} [options.force] - 跳过「已是最新」短路，强制重装并回读校验
   * @returns {Promise<{success: boolean, updated: boolean, alreadyLatest: boolean, reinstalled?: boolean, unverified?: boolean, oldVersion: string, newVersion: string, targetVersion: string, needsRestart: boolean, verified: boolean}>}
   *   - `unverified: true` 表示命令已执行但磁盘无法确认版本（不谎报成功，由 UI 提示人工核对）
   */
  async update(pluginId, options = {}) {
    this._log(`更新插件: ${pluginId}`);

    // 强制刷新本地插件列表，避免 15s 缓存拿到陈旧版本号
    const plugins = this.registry.getLocalPlugins(true);
    const plugin = plugins.find(p => p.id === pluginId);

    if (!plugin) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `插件未找到: ${pluginId}`);
    }

    const profile = plugin.profile || options.profile || this.profile;
    const oldVersion = plugin.version || '';
    const force = options.force === true;

    // ① 前置版本校验（source 感知：github 走 release tag，npm 走 npm view）
    let check = null;
    try {
      check = await this.registry.checkPluginUpdate(pluginId);
    } catch (e) {
      this._log(`前置版本校验失败，降级为「重装 + 回读磁盘校验」: ${e.message}`, 'warn');
    }
    const hasUpdate = !!(check && check.hasUpdate);
    const targetVersion = (check && check.latestVersion) || '';

    // ② 版本未变 → 明确回报「已是最新」（不再误报成功，也不触发无意义重启）
    if (check && !hasUpdate && !force) {
      this._log(`${pluginId} 已是最新（${oldVersion}），跳过重装`, 'warn');
      return {
        success: true,
        id: pluginId,
        updated: false,
        alreadyLatest: true,
        oldVersion,
        newVersion: oldVersion,
        targetVersion,
        needsRestart: false,
        verified: true,
      };
    }

    // ③ 精确重装（npm 源固定目标版本；git/link 源沿用原有安装逻辑）
    const result = await this.install(plugin.source, {
      ...options,
      profile,
      targetVersion: hasUpdate ? targetVersion : '',
    });

    // ④ 回读磁盘真值（不信任 dsh plugin / pnpm 的退出码与 stdout）
    // git/link 源登记的 id 可能与 node_modules 目录名不同 → 依次探测候选包名
    const { version: diskVersion, from: diskFrom } = this._probeInstalledVersion(profile, [
      pluginId,
      result && result.id,
      pluginId.split('/').pop(),
    ]);

    // 磁盘完全无法确认（node_modules 下找不到 package.json）→ 不得凭退出码宣称成功
    if (!diskVersion && (hasUpdate || check === null || force)) {
      this._log(`${pluginId} 更新后未能在磁盘确认版本，回报「无法确认」而非成功`, 'warn');
      return {
        success: true,
        id: pluginId,
        updated: false,
        alreadyLatest: false,
        reinstalled: false,
        unverified: true,
        oldVersion,
        newVersion: oldVersion,
        targetVersion,
        needsRestart: false,
        verified: false,
        warning: `已执行更新命令，但未能在 profile "${profile}" 的 node_modules 中读取到 ${pluginId} 的 package.json，`
          + `无法核实是否真正生效；请重启 DSH 后在插件列表核对版本，必要时使用「强制重装」`,
      };
    }

    const changed = !!diskVersion && (!oldVersion || compareDSHVersions(diskVersion, oldVersion) > 0);

    if (hasUpdate && targetVersion && diskVersion && compareDSHVersions(targetVersion, diskVersion) > 0) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `插件更新未生效：目标版本 ${targetVersion}，磁盘 node_modules 实际版本 ${diskVersion}`
          + `（profile "${profile}" 下未落盘新版本；请检查网络/registry 权限，或稍后重试）`
      );
    }

    return {
      success: true,
      id: pluginId,
      updated: changed,
      alreadyLatest: !changed,
      // 强制重装且版本未变：不是「有新版未生效」，而是同版本重新落盘，仍需重启加载
      reinstalled: force && !changed,
      oldVersion,
      newVersion: diskVersion,
      targetVersion: hasUpdate ? targetVersion : diskVersion,
      needsRestart: changed || force,
      verified: !!diskVersion,
      verifiedFrom: diskFrom,
    };
  }

  /**
   * 依次探测候选包名对应的 node_modules 真实版本（更新是否生效的真值来源）。
   * git/link 源在注册表中登记的 id 可能与 node_modules 目录名不一致，
   * 因此按候选顺序探测，取首个命中；全部未命中即表示磁盘上无法确认。
   * @param {string} profile
   * @param {string[]} candidates - 候选包名（插件 id / 安装结果 id / 去 scope 短名）
   * @returns {{version: string|null, from: string|null}}
   * @private
   */
  _probeInstalledVersion(profile, candidates) {
    const seen = new Set();
    for (const name of candidates || []) {
      const key = String(name || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const version = this._readInstalledVersion(profile, key);
      if (version) return { version, from: key };
    }
    return { version: null, from: null };
  }

  /**
   * 从 profile 的 node_modules 回读插件真实版本（更新是否生效的唯一真值来源）
   * @param {string} profile
   * @param {string} pluginId - 完整包名（含 scope）
   * @returns {string|null}
   * @private
   */
  _readInstalledVersion(profile, pluginId) {
    if (!profile || !pluginId) return null;
    const pkgJson = join(DSH_PATHS.profiles, profile, 'node_modules', pluginId, 'package.json');
    try {
      if (!existsSync(pkgJson)) return null;
      const pj = JSON.parse(readFileSync(pkgJson, 'utf-8'));
      return pj && pj.version ? String(pj.version) : null;
    } catch (e) {
      this._log(`回读磁盘版本失败 (${pluginId}): ${e.message}`, 'warn');
      return null;
    }
  }

  /**
   * @private
   * @param {string} packageName
   * @param {string} profile
   * @param {object} info
   * @param {object} [options]
   * @param {string} [options.targetVersion] - 固定安装的目标版本（更新场景）
   */
  async _installFromNpm(packageName, profile, info, options = {}) {
    this._log(`通过 npm 安装: ${packageName}`);

    try {
      // 检查 pnpm 是否已安装（dsh plugin 命令依赖 pnpm）
      await requirePnpm('安装插件');

      // 更新场景固定到目标版本 + 必要时 --force（参数拼装见 buildPluginAddArgs）
      const targetVersion = String(options.targetVersion || '').trim();
      const addArgs = buildPluginAddArgs(profile, packageName, {
        targetVersion,
        force: options.force === true,
      });

      const res = await execa(await this._dshCmd(), addArgs, { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe', reject: false, windowsHide: true });
      if (res.failed) {
        throw new DSHError(
          DSHErrorCodes.PLUGIN_INSTALL_FAILED,
          'npm 安装失败: ' + ((res.stderr || res.stdout || '').trim() || ('dsh plugin add 命令失败（退出码 ' + res.exitCode + '）'))
        );
      }

      this._log(res.stdout || '');

      // 获取 npm 包信息
      const npmInfo = await this._getNpmPackageInfo(packageName);
      // 官方规范：插件身份 = 完整包名（dsh.profile.bundles 中即完整包名，如 @linxin666/gongwen-skill）。
      // 不能用 split('/').pop() 取末段，否则 scope 丢失，本地注册表与 profile 扫描对不上产生幽灵条目。
      const resolvedName = npmInfo.name || packageName;
      const pluginId = (info && info.npmPackage) ? info.npmPackage : resolvedName;

      // 注册版本以「磁盘实际落盘版本」为准，而不是 npm 远端版本
      // （否则远端已发布新版本但本地未更新时，注册表会显示错误版本）
      const diskVersion = this._readInstalledVersion(profile, resolvedName)
        || this._readInstalledVersion(profile, pluginId)
        || null;
      const version = diskVersion || npmInfo.version || 'latest';

      // 注册到本地列表
      this.registry.registerLocalPlugin({
        id: pluginId,
        name: info.name || npmInfo.name || packageName,
        version,
        source: `npm:${packageName}`,
        profile,
        type: 'npm',
        installedAt: new Date().toISOString(),
        description: info.description || npmInfo.description || '',
      });

      return {
        success: true,
        needsRestart: true,
        id: pluginId,
        name: info.name || packageName,
        version,
        targetVersion: targetVersion || '',
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
  async _installFromGitHub(owner, repo, profile, info, ref = '', options = {}) {
    this._log(`从 GitHub 安装: ${owner}/${repo}${ref ? '#' + ref : ''}`);

    // 有 npm 包名则优先走 npm（更快）；npm 失败自动降级为 git 安装
    if (info.npmPackage) {
      this._log(`发现 npm 包: ${info.npmPackage}，优先通过 npm 安装`);
      try {
        return await this._installFromNpm(info.npmPackage, profile, info, options);
      } catch (npmError) {
        this._log(`npm 安装失败（${npmError.message}），降级为 GitHub 安装`, 'warn');
        // 继续走官方 github:owner/repo#ref 形式安装
      }
    }

    // 先尝试官方 dsh plugin add 命令
    const gitSource = `github:${owner}/${repo}${ref ? '#' + ref : ''}`;
    
    try {
      const { stdout, stderr } = await execa(await this._dshCmd(), [
        'plugin', '--profile', profile, 'add', gitSource,
      ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });

      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      // 官方规范：插件身份 = 完整包名（dsh.profile.bundles 中即完整包名）。
      // GitHub 安装优先使用 npmPackage，其次 pkg.name/repo，避免与 profile 扫描不一致。
      const pluginId = info.npmPackage || info.id || repo;

      // 版本以磁盘实际落盘为准（GitHub release tag 可能领先于实际安装内容，
      // 直接采用远端 tag 会造成「远端版本号 ≠ 本地实际版本」的假更新）
      const diskVersion = this._readInstalledVersion(profile, pluginId);
      const version = diskVersion || info.latestRelease || info.version || 'main';

      this.registry.registerLocalPlugin({
        id: pluginId,
        name: info.name || repo,
        version,
        source: `github:${owner}/${repo}`,
        profile,
        type: 'github',
        installedAt: new Date().toISOString(),
        description: info.description || '',
        repoUrl: `https://github.com/${owner}/${repo}`,
      });

      return {
        success: true,
        needsRestart: true,
        id: pluginId,
        name: info.name || repo,
        version,
        path: '',
      };
    } catch (error) {
      this._log(`dsh plugin add 失败: ${error.message}，降级为 git clone 方式安装`, 'warn');
    }

    // 降级方案：通过 git clone + 代理手动安装
    this._log(`通过代理 git clone 安装: ${owner}/${repo}`, 'info');
    try {
      // 构建代理 URL
      const gitUrl = `https://github.com/${owner}/${repo}.git`;
      const cacheRoot = DSH_PATHS.pluginCache;
      const dest = join(cacheRoot, repo);

      if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

      let cloned = false;
      let lastError = null;
      for (const candidate of githubProxyUrls(gitUrl)) {
        try {
          this._log(`执行: git clone --depth 1 ${candidate} (branch: ${ref || info.defaultBranch || 'main'})`);
          const { stdout, stderr } = await execa('git', [
            'clone', '--depth', '1', '--branch', ref || info.defaultBranch || 'main', candidate, dest
          ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });
          this._log(stdout || '');
          if (stderr) this._log(stderr, 'warn');
          cloned = true;
          break;
        } catch (e) {
          lastError = e;
          this._log(`代理 ${candidate} 克隆失败: ${e.message}`, 'warn');
        }
      }
      if (!cloned) throw lastError || new Error('git clone 全部失败');

      // 用 dsh plugin add link: 注册
      this._log(`通过 dsh plugin add link:${dest} 注册到 profile ${profile}`);
      const { stdout, stderr } = await execa(await this._dshCmd(), [
        'plugin', '--profile', profile, 'add', `link:${dest}`
      ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });
      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      // 官方规范：插件身份 = 完整包名。读取克隆产物 package.json 的真实包名，
      // 与 dsh plugin add 实际注册进 profile bundles 的名字保持一致。
      let realName = info.npmPackage || info.id || repo;
      try {
        const clonedPkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf-8'));
        if (clonedPkg && clonedPkg.name) realName = clonedPkg.name;
      } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }

      const pluginId = realName;
      this.registry.registerLocalPlugin({
        id: pluginId,
        name: info.name || repo,
        version: info.latestRelease || info.version || 'main',
        source: `github:${owner}/${repo}`,
        profile,
        type: 'github',
        installedAt: new Date().toISOString(),
        description: info.description || '',
        repoUrl: `https://github.com/${owner}/${repo}`,
      });

      return { success: true, needsRestart: true, id: pluginId, name: info.name || repo, version: info.latestRelease || info.version || 'main', path: dest};
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
      const defaultBranch = details.defaultBranch || 'main';
      const packageJson = await this.registry.github.getPackageJson(owner, repo, defaultBranch);
      const releases = await this.registry.github.getReleases(owner, repo, 1);
      
      return {
        id: repo,
        name: details.name,
        description: details.description,
        npmPackage: packageJson?.name || null,
        version: packageJson?.version || null,
        latestRelease: releases[0]?.tag?.replace(/^v/, '') || null,
        defaultBranch,
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
      ], { timeout: 30_000, reject: false, windowsHide: true });
      
      if (stdout) {
        return JSON.parse(stdout);
      }
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
    return { name: packageName, version: 'latest', description: '' };
  }

  /**
   * @private
   */
  _parseSource(source) {
    // 校验 owner/repo 合法性：仅允许字母数字、下划线、连字符、点号，防止路径穿越
    const validateGitId = (id) => {
      return typeof id === 'string' && /^[a-zA-Z0-9_.-]+$/.test(id);
    };

    if (source.startsWith('github:')) {
      // github:owner/repo#ref（#ref 可选，固定分支/标签/commit）
      const full = source.replace('github:', '');
      const [owner, repoFull, ...rest] = full.split('/');
      const refPart = rest.length > 0 ? rest.join('/') : '';
      const [repo, ref] = this._splitRef(repoFull, refPart);
      if (!validateGitId(owner) || !validateGitId(repo)) {
        return { type: 'error', error: '非法的 GitHub 仓库标识: ' + owner + '/' + repo };
      }
      return { type: 'github', owner, repo, ref, fullName: `${owner}/${repo}${ref ? '#' + ref : ''}` };
    }
    
    if (source.startsWith('npm:')) {
      return { type: 'npm', packageName: source.replace('npm:', '') };
    }

    // 本地目录/tarball 安装：file:<路径>
    if (source.startsWith('file:')) {
      return { type: 'file', path: source.replace(/^file:/, '') };
    }

    // 本地 link 源：link:./packages/xxx（DSH 官方支持）
    if (source.startsWith('link:')) {
      return { type: 'link', path: source.replace(/^link:/, '') };
    }

    // Git URL 直装：git:<url> / git+https:// / git+ssh:// / git@
    if (source.startsWith('git:') || source.startsWith('git+https://') || source.startsWith('git+ssh://') || source.startsWith('git@')) {
      const url = source.startsWith('git:') ? source.replace(/^git:/, '') : source;
      return { type: 'git', url };
    }
    
    if (source.includes('/') && source.includes('github.com')) {
      const match = source.match(/github\.com\/([^/]+)\/([^/.]+)/);
      if (match) {
        // https://github.com/owner/repo#ref 形式
        const [owner, repoFull, ...rest] = `${match[1]}/${match[2]}`.split('/');
        const [repo, ref] = this._splitRef(repoFull, '');
        // 从原 source 提取 #ref（可能在 repo 后）
        const hashMatch = source.match(/#([^/]+)$/);
        return { type: 'github', owner, repo, ref: hashMatch ? hashMatch[1] : '', fullName: `${owner}/${repo}${hashMatch ? '#' + hashMatch[1] : ''}` };
      }
    }
    
    // 默认视为 npm 包
    if (source.includes('/') || source.startsWith('@')) {
      // 裸 owner/repo 形式：解析 #ref
      if (!source.startsWith('@') && source.includes('/')) {
        const [owner, repoFull, ...rest] = source.split('/');
        if (rest.length === 0) {
          const [repo, ref] = this._splitRef(repoFull, '');
          if (repo && !repo.startsWith('.')) {
            return { type: 'github', owner, repo, ref, fullName: `${owner}/${repo}${ref ? '#' + ref : ''}` };
          }
        }
      }
      return { type: 'npm', packageName: source };
    }
    
    // 默认 npm
    return { type: 'npm', packageName: source };
  }

  /**
   * 校验 npm 包名是否合法（拒绝 "--mcp" 这类 CLI flag 误当包名的输入，
   * 防止 dsh plugin add --mcp 把参数解析成选项、产生幽灵注册条目）
   * @param {string} packageName
   * @returns {boolean}
   */
  _isValidNpmPackageName(packageName) {
    const name = String(packageName || '').trim();
    if (!name) return false;
    // 以 - 开头（CLI flag 形态）直接拒绝
    if (name.startsWith('-')) return false;
    // 含空白直接拒绝
    if (/\s/.test(name)) return false;
    // 路径穿越/绝对路径拒绝
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
    // npm 包名正则（宽松）：@scope/name 或 name
    const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    return NAME_RE.test(name);
  }

  /**
   * 将 "repo#ref" 拆分为 repo 与 ref
   * @private
   */
  _splitRef(repoPart, rest) {
    const hashIdx = repoPart.indexOf('#');
    if (hashIdx >= 0) {
      return [repoPart.slice(0, hashIdx), repoPart.slice(hashIdx + 1)];
    }
    return [repoPart, rest || ''];
  }

  /**
   * 并行克隆 GitHub 仓库：同时尝试直连与各代理，最快成功者胜出
   * @param {string} gitUrl - 原始 git URL（https://github.com/xxx/yyy.git）
   * @param {string} dest - 最终目标目录
   * @param {string} [branch] - 分支名
   * @returns {Promise<boolean>} 是否克隆成功
   * @private
   */
  async _parallelGitClone(gitUrl, dest, branch = '') {
    const candidates = githubProxyUrls(gitUrl);
    const tmpSuffix = Date.now();
    const results = [];

    // 并行启动所有候选克隆（每个克隆到独立临时目录，避免冲突）
    const promises = candidates.map(async (candidate, idx) => {
      const tmpDest = dest + `.tmp-${tmpSuffix}-${idx}`;
      if (existsSync(tmpDest)) rmSync(tmpDest, { recursive: true, force: true });
      const start = Date.now();
      try {
        this._log(`[并行克隆] 尝试 ${candidate} ...`, 'info');
        const cloneArgs = ['clone', '--depth', '1'];
        if (branch) cloneArgs.push('--branch', branch);
        cloneArgs.push(candidate, tmpDest);

        const { stdout, stderr } = await execa('git', cloneArgs, {
          timeout: 60_000, // 单候选 60s 超时（比之前 120s 快一倍）
          stdio: this.verbose ? 'inherit' : 'pipe',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true,
        });
        const elapsed = Date.now() - start;
        this._log(`[并行克隆] ${candidate} 成功（${elapsed}ms）`, 'info');
        if (stderr) this._log(stderr, 'warn');
        return { ok: true, tmpDest, candidate, elapsed };
      } catch (error) {
        const elapsed = Date.now() - start;
        // 清理临时目录
        try { rmSync(tmpDest, { recursive: true, force: true }); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
        this._log(`[并行克隆] ${candidate} 失败（${elapsed}ms）: ${error.message}`, 'warn');
        return { ok: false, candidate, elapsed, error };
      }
    });

    const settled = await Promise.allSettled(promises);
    const okResults = settled
      .filter(r => r.status === 'fulfilled' && r.value.ok)
      .map(r => r.value)
      .sort((a, b) => a.elapsed - b.elapsed);

    if (okResults.length === 0) {
      // 全部失败，返回最后一个错误信息
      const errors = settled
        .filter(r => r.status === 'fulfilled' && !r.value.ok)
        .map(r => r.value.error?.message);
      throw new Error('git clone 全部失败: ' + (errors.join('; ') || '未知错误'));
    }

    // 使用最快的成功结果
    const winner = okResults[0];
    this._log(`[并行克隆] 选中最快源: ${winner.candidate}（${winner.elapsed}ms）`, 'info');

    // 将胜出目录移动到最终位置
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    await new Promise(resolve => setTimeout(resolve, 0)); // 让文件系统释放
    try {
      renameSync(winner.tmpDest, dest);
    } catch (err) {
      // 跨设备可能失败，用 cpSync 兜底
      cpSync(winner.tmpDest, dest, { recursive: true });
      rmSync(winner.tmpDest, { recursive: true, force: true });
    }

    // 清理其余临时目录
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.ok && r.value.tmpDest !== winner.tmpDest) {
        try { rmSync(r.value.tmpDest, { recursive: true, force: true }); } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }
      }
    }
    return true;
  }

  /**  /**
   * @private
   * 从 Git URL 安装插件（git clone 到插件缓存并注册）
   * @param {string} url - git 仓库地址
   * @param {string} profile
   * @param {object} [info]
   */
  async _installFromGit(url, profile, info = {}, options = {}) {
    this._log(`从 Git 安装: ${url}`);

    // 从 URL 提取仓库名
    const repoMatch = url.match(/([^/]+?)(?:\.git)?$/);
    let repoName = repoMatch ? repoMatch[1] : basename(url) || 'plugin';
    // 安全校验：仓库名必须是合法目录名（禁止 .. / 绝对路径 / 盘符），防止 join + rmSync 路径逃逸
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoName) || repoName === '.' || repoName === '..') {
      throw new DSHError(DSHErrorCodes.PLUGIN_INSTALL_FAILED, '非法的 Git 仓库名: ' + repoName);
    }

    // 目标缓存目录
    const cacheRoot = DSH_PATHS.pluginCache;
    const dest = join(cacheRoot, repoName);

    try {
      if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
      // 清空旧缓存避免冲突
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

      // 直连 clone，失败自动切换 GitHub 代理（gh-proxy.com / github.akams.cn）
      let cloned = false;
      let lastError = null;
      for (const candidate of githubProxyUrls(url)) {
        try {
          this._log(`执行: git clone --depth 1 ${candidate}`);
          const { stdout, stderr } = await execa('git', ['clone', '--depth', '1', candidate, dest], {
            timeout: 120_000,
            stdio: this.verbose ? 'inherit' : 'pipe',
            windowsHide: true,
          });
          this._log(stdout || '');
          if (stderr) this._log(stderr, 'warn');
          cloned = true;
          break;
        } catch (error) {
          lastError = error;
          this._log(`git clone 失败（${candidate}）: ${error.message}`, 'warn');
        }
      }
      if (!cloned) throw lastError || new Error('git clone 失败');

      // 读取 package.json
      let pkg = null;
      try {
        const pkgRaw = readFileSync(join(dest, 'package.json'), 'utf-8');
        pkg = JSON.parse(pkgRaw);
      } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }

      // 官方规范：插件身份 = 完整包名，优先使用 package.json 的真实包名
      const pluginId = pkg?.name || info.npmPackage || info.id || repoName;
      const version = pkg?.version || 'main';

      // 官方规范：仅复制/克隆到缓存并不算安装——必须通过
      // `dsh plugin --profile <name> add <source>` 注册进 profile 的
      // package.json dependencies + dsh.profile.bundles，DSH 才会真正加载。
      // 这里用官方 link: 源指向克隆产物（与 GitHub 降级路径一致）。
      try {
        const { stdout, stderr } = await execa(await this._dshCmd(), [
          'plugin', '--profile', profile, 'add', `link:${dest}`,
        ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });
        this._log(stdout || '');
        if (stderr) this._log(stderr, 'warn');
        this._log(`已通过 dsh plugin 注册到 profile ${profile}`);
      } catch (regError) {
        this._log(`dsh plugin add 注册失败: ${regError.message}`, 'warn');
      }

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

      return { success: true, needsRestart: true, id: pluginId, name: pluginId, version, path: dest};
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `Git 安装失败: ${error.message}（请确认已安装 git 且地址可访问）`
      );
    }
  }

  /**
   * @private
   * 从本地 link 源安装插件（DSH 官方 link: 形式）
   * 命令: dsh plugin --profile <profile> add link:<path>
   * @param {string} path - 本地路径（如 ./packages/xxx）
   * @param {string} profile
   */
  async _installFromLink(path, profile) {
    this._log(`从本地 link 安装: ${path}`);

    if (!path) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `link 路径不能为空`);
    }

    // 读取 package.json 获取插件信息（路径可能相对工作目录）
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'));
    } catch (e) { console.warn('[dsh-manager] ignored error:', e?.message || e); }

    // 使用官方 link: 源形式安装（DSH 会做 pnpm 链接）
    const linkSource = `link:${path}`;
    const { stdout, stderr } = await execa(await this._dshCmd(), [
      'plugin', '--profile', profile, 'add', linkSource,
    ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });
    this._log(stdout || '');
    if (stderr) this._log(stderr, 'warn');

    const pluginId = pkg?.name || basename(path);
    this.registry.registerLocalPlugin({
      id: pluginId,
      name: pkg?.name || basename(path),
      version: pkg?.version || 'local',
      source: `link:${path}`,
      profile,
      type: 'link',
      installedAt: new Date().toISOString(),
      description: pkg?.description || '',
    });

    return { success: true, needsRestart: true, id: pluginId, name: pluginId, version: pkg?.version || 'local', path};
  }

  /**
   * @private
   * 从本地目录安装插件（复制到插件缓存并注册）
   * @param {string} dir - 本地插件目录
   * @param {string} profile
   */
  async _installFromFile(dir, profile) {
    this._log(`从本地文件安装: ${dir}`);

    if (!dir || !existsSync(dir)) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `本地路径不存在: ${dir}`);
    }

    // 支持 .tgz / .tar.gz tarball（DSH 官方 file: 源形式：file:/path/to/pkg.tgz）
    if (/\.(tgz|tar\.gz)$/i.test(dir)) {
      return await this._installFromTarball(dir, profile);
    }

    // 目录安装：校验 package.json
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
    // 安全校验：插件名必须是合法 npm 包名（禁止 .. / 绝对路径），防止 join + rmSync/cpSync 路径逃逸
    const PKG_NAME_RE = /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$|^[a-z0-9-~][a-z0-9-._~]*$/;
    if (!PKG_NAME_RE.test(pluginName)) {
      throw new DSHError(DSHErrorCodes.PLUGIN_INSTALL_FAILED, '非法的插件名: ' + pluginName);
    }
    const cacheRoot = DSH_PATHS.pluginCache;
    const dest = join(cacheRoot, pluginName);

    try {
      if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(dir, dest, { recursive: true });

      // 官方规范：仅复制到缓存并不算安装——必须通过
      // `dsh plugin --profile <name> add file:<path>` 注册进 profile，
      // DSH 才会真正加载该插件（file: 是 DSH 官方支持的本地源形式）。
      const pluginId = pluginName;
      try {
        const { stdout, stderr } = await execa(await this._dshCmd(), [
          'plugin', '--profile', profile, 'add', `file:${dest}`,
        ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });
        this._log(stdout || '');
        if (stderr) this._log(stderr, 'warn');
        this._log(`已通过 dsh plugin 注册到 profile ${profile}`);
      } catch (regError) {
        this._log(`dsh plugin add 注册失败: ${regError.message}`, 'warn');
      }

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

      return { success: true, needsRestart: true, id: pluginId, name: pluginName, version: pkg.version || 'local', path: dest};
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `本地目录安装失败: ${error.message}`
      );
    }
  }

  /**
   * @private
   * 从 .tgz / .tar.gz tarball 安装插件（DSH 官方 file: 源形式）
   * 解压到插件缓存并注册
   * @param {string} tarball - tarball 路径
   * @param {string} profile
   */
  async _installFromTarball(tarball, profile) {
    this._log(`从 tarball 安装: ${tarball}`);
    const cacheRoot = DSH_PATHS.pluginCache;
    if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });

    // 临时解压目录
    const tempDir = join(cacheRoot, `tmp-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      // 防 zip-slip：解压前先列出归档条目，拒绝 .. / 绝对路径 / 盘符 / NUL 条目（对齐 skill-manager safeZipRelPath）
      const listRes = await execa('tar', ['-tzf', tarball], {
        timeout: 120_000,
        stdio: 'pipe',
        windowsHide: true,
      });
      const entries = (listRes.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
      for (const entry of entries) {
        const norm = entry.replace(/\\/g, '/');
        if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..') || norm.includes('\0')) {
          throw new Error('tarball 包含非法路径条目，已拒绝解压: ' + entry);
        }
      }
      await execa('tar', ['-xzf', tarball, '-C', tempDir], {
        timeout: 120_000,
        stdio: this.verbose ? 'inherit' : 'pipe',
        windowsHide: true,
      });

      // 定位解压后的 package.json（tarball 可能含 package/ 前缀目录）
      let pkgDir = tempDir;
      if (!existsSync(join(pkgDir, 'package.json'))) {
        const entries = readdirSync(tempDir, { withFileTypes: true }).filter(e => e.isDirectory());
        const sub = entries.find(e => existsSync(join(tempDir, e.name, 'package.json')));
        if (sub) pkgDir = join(tempDir, sub.name);
      }
      // 防御：pkgDir 必须仍在 tempDir 内（杜绝残留越界条目被 cpSync 复制）
      const resolvedPkgDir = resolve(pkgDir);
      const resolvedTemp = resolve(tempDir);
      if (resolvedPkgDir !== resolvedTemp && !resolvedPkgDir.startsWith(resolvedTemp + sep)) {
        throw new Error('解压目录越界，已中止安装');
      }
      const pkgPath = join(pkgDir, 'package.json');
      if (!existsSync(pkgPath)) {
        throw new Error('tarball 中未找到 package.json');
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      const pluginName = pkg.name || basename(tarball).replace(/\.(tgz|tar\.gz)$/i, '');
      // 安全校验：插件名必须是合法 npm 包名（禁止 .. / 绝对路径），防止 join + rmSync/cpSync 路径逃逸
      const PKG_NAME_RE = /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$|^[a-z0-9-~][a-z0-9-._~]*$/;
      if (!PKG_NAME_RE.test(pluginName)) {
        throw new DSHError(DSHErrorCodes.PLUGIN_INSTALL_FAILED, '非法的插件名: ' + pluginName);
      }
      const dest = join(cacheRoot, pluginName);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(pkgDir, dest, { recursive: true });

      // 官方规范：仅解压到缓存并不算安装——必须通过
      // `dsh plugin --profile <name> add file:<path>` 注册进 profile，
      // DSH 才会真正加载该插件（tarball 走官方 file: 源形式）。
      try {
        const { stdout, stderr } = await execa(await this._dshCmd(), [
          'plugin', '--profile', profile, 'add', `file:${dest}`,
        ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe', windowsHide: true });
        this._log(stdout || '');
        if (stderr) this._log(stderr, 'warn');
        this._log(`已通过 dsh plugin 注册到 profile ${profile}`);
      } catch (regError) {
        this._log(`dsh plugin add 注册失败: ${regError.message}`, 'warn');
      }

      this.registry.registerLocalPlugin({
        id: pluginName,
        name: pkg.name || pluginName,
        version: pkg.version || 'local',
        source: `file:${tarball}`,
        profile,
        type: 'file',
        installedAt: new Date().toISOString(),
        description: pkg.description || '',
      });

      return { success: true, needsRestart: true, id: pluginName, name: pluginName, version: pkg.version || 'local', path: dest};
    } catch (error) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_INSTALL_FAILED,
        `tarball 安装失败: ${error.message}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * @private
   */
  _log(message, level = 'info') {
    this.logs.push({ level, message, timestamp: new Date().toISOString() });
    // 通过 console.log 输出（主进程会拦截并写入调试日志文件）
    if (level === 'error') {
      console.error('[插件安装器] ' + message);
    } else if (level === 'warn') {
      console.warn('[插件安装器] ' + message);
    } else {
      console.log('[插件安装器] ' + message);
    }
    if (this.onProgress) {
      this.onProgress({ level, message });
    }
  }

  getLogs() {
    return [...this.logs];
  }
}