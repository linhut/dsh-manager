/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DSHError, DSHErrorCodes, requirePnpm, DSH_PATHS, resolveDSHCommand } from '../../core/src/index.js';
import { PluginRegistry } from './registry.js';
import { githubProxyUrls } from './github-api.js';

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
    
    // 获取插件信息
    let pluginInfo = {};
    if (parsed.type === 'github') {
      this._log(`获取 GitHub 仓库信息: ${parsed.owner}/${parsed.repo}`);
      pluginInfo = await this._getGitHubPluginInfo(parsed.owner, parsed.repo);
    }

    // 执行安装
    if (parsed.type === 'npm') {
      return await this._installFromNpm(parsed.packageName, profile, pluginInfo);
    } else if (parsed.type === 'github') {
      return await this._installFromGitHub(parsed.owner, parsed.repo, profile, pluginInfo, parsed.ref);
    } else if (parsed.type === 'git') {
      return await this._installFromGit(parsed.url, profile, pluginInfo);
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
        ], { reject: false, timeout: 60_000 });
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
        return { success: true, method: 'official' };
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

      const { stdout, stderr } = await execa(await this._dshCmd(), [
        'plugin', '--profile', profile, 'add', packageName,
      ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe' });

      this._log(stdout || '');

      // 获取 npm 包信息
      const npmInfo = await this._getNpmPackageInfo(packageName);
      // 官方规范：插件身份 = 完整包名（dsh.profile.bundles 中即完整包名，如 @linxin666/gongwen-skill）。
      // 不能用 split('/').pop() 取末段，否则 scope 丢失，本地注册表与 profile 扫描对不上产生幽灵条目。
      const resolvedName = npmInfo.name || packageName;
      const pluginId = (info && info.npmPackage) ? info.npmPackage : resolvedName;

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
  async _installFromGitHub(owner, repo, profile, info, ref = '') {
    this._log(`从 GitHub 安装: ${owner}/${repo}${ref ? '#' + ref : ''}`);

    // 有 npm 包名则优先走 npm（更快）；npm 失败自动降级为 git 安装
    if (info.npmPackage) {
      this._log(`发现 npm 包: ${info.npmPackage}，优先通过 npm 安装`);
      try {
        return await this._installFromNpm(info.npmPackage, profile, info);
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
      ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe' });

      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      // 官方规范：插件身份 = 完整包名（dsh.profile.bundles 中即完整包名）。
      // GitHub 安装优先使用 npmPackage，其次 pkg.name/repo，避免与 profile 扫描不一致。
      const pluginId = info.npmPackage || info.id || repo;

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
          this._log(`执行: git clone --depth 1 ${candidate} (branch: ${ref || 'main'})`);
          const { stdout, stderr } = await execa('git', [
            'clone', '--depth', '1', '--branch', ref || 'main', candidate, dest
          ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe' });
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
      ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe' });
      this._log(stdout || '');
      if (stderr) this._log(stderr, 'warn');

      // 官方规范：插件身份 = 完整包名。读取克隆产物 package.json 的真实包名，
      // 与 dsh plugin add 实际注册进 profile bundles 的名字保持一致。
      let realName = info.npmPackage || info.id || repo;
      try {
        const clonedPkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf-8'));
        if (clonedPkg && clonedPkg.name) realName = clonedPkg.name;
      } catch {}

      const pluginId = realName;
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

      return { success: true, id: pluginId, name: info.name || repo, version: info.latestRelease || 'main', path: dest };
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
      // github:owner/repo#ref（#ref 可选，固定分支/标签/commit）
      const full = source.replace('github:', '');
      const [owner, repoFull, ...rest] = full.split('/');
      const refPart = rest.length > 0 ? rest.join('/') : '';
      const [repo, ref] = this._splitRef(repoFull, refPart);
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
        });
        const elapsed = Date.now() - start;
        this._log(`[并行克隆] ${candidate} 成功（${elapsed}ms）`, 'info');
        if (stderr) this._log(stderr, 'warn');
        return { ok: true, tmpDest, candidate, elapsed };
      } catch (error) {
        const elapsed = Date.now() - start;
        // 清理临时目录
        try { rmSync(tmpDest, { recursive: true, force: true }); } catch {}
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
    const { renameSync } = await import('node:fs');
    try {
      renameSync(winner.tmpDest, dest);
    } catch (err) {
      // 跨设备可能失败，用 cpSync 兜底
      const { cpSync } = await import('node:fs');
      cpSync(winner.tmpDest, dest, { recursive: true });
      rmSync(winner.tmpDest, { recursive: true, force: true });
    }

    // 清理其余临时目录
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.ok && r.value.tmpDest !== winner.tmpDest) {
        try { rmSync(r.value.tmpDest, { recursive: true, force: true }); } catch {}
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

      // 直连 clone，失败自动切换 GitHub 代理（gh-proxy.com / github.akams.cn）
      let cloned = false;
      let lastError = null;
      for (const candidate of githubProxyUrls(url)) {
        try {
          this._log(`执行: git clone --depth 1 ${candidate}`);
          const { stdout, stderr } = await execa('git', ['clone', '--depth', '1', candidate, dest], {
            timeout: 120_000,
            stdio: this.verbose ? 'inherit' : 'pipe',
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
      } catch {}

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
        ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe' });
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
    } catch {}

    // 使用官方 link: 源形式安装（DSH 会做 pnpm 链接）
    const linkSource = `link:${path}`;
    const { stdout, stderr } = await execa(await this._dshCmd(), [
      'plugin', '--profile', profile, 'add', linkSource,
    ], { timeout: 120_000, stdio: this.verbose ? 'inherit' : 'pipe' });
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

    return { success: true, id: pluginId, name: pluginId, version: pkg?.version || 'local', path };
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
        ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe' });
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
      await execa('tar', ['-xzf', tarball, '-C', tempDir], {
        timeout: 120_000,
        stdio: this.verbose ? 'inherit' : 'pipe',
      });

      // 定位解压后的 package.json（tarball 可能含 package/ 前缀目录）
      let pkgDir = tempDir;
      if (!existsSync(join(pkgDir, 'package.json'))) {
        const entries = readdirSync(tempDir, { withFileTypes: true }).filter(e => e.isDirectory());
        const sub = entries.find(e => existsSync(join(tempDir, e.name, 'package.json')));
        if (sub) pkgDir = join(tempDir, sub.name);
      }
      const pkgPath = join(pkgDir, 'package.json');
      if (!existsSync(pkgPath)) {
        throw new Error('tarball 中未找到 package.json');
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      const pluginName = pkg.name || basename(tarball).replace(/\.(tgz|tar\.gz)$/i, '');
      const dest = join(cacheRoot, pluginName);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(pkgDir, dest, { recursive: true });

      // 官方规范：仅解压到缓存并不算安装——必须通过
      // `dsh plugin --profile <name> add file:<path>` 注册进 profile，
      // DSH 才会真正加载该插件（tarball 走官方 file: 源形式）。
      try {
        const { stdout, stderr } = await execa(await this._dshCmd(), [
          'plugin', '--profile', profile, 'add', `file:${dest}`,
        ], { timeout: 60_000, stdio: this.verbose ? 'inherit' : 'pipe' });
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

      return { success: true, id: pluginName, name: pluginName, version: pkg.version || 'local', path: dest };
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