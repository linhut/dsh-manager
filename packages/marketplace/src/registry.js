/**
 * @dsh-manager/marketplace - 插件注册表
 * 
 * 管理本地插件注册信息、缓存、搜索
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { resolveDSHCommand } from '../../core/src/index.js';
import { GitHubAPI } from './github-api.js';

const DSH_HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const REGISTRY_PATH = () => join(DSH_HOME(), 'manager', 'plugins.json');
const CACHE_PATH = () => join(DSH_HOME(), 'manager', 'marketplace-cache.json');
/** 从 DSH profile patch 文件解析出的插件名缓存（避免重复扫描，带 TTL 与手动失效） */
let profilePluginsCache = null;
let profilePluginsCacheTime = 0;
const PROFILE_CACHE_TTL = 15_000; // 15 秒，覆盖安装/卸载后的同步窗口
/** 完整插件树缓存（来自 dsh --dump-config，执行成本高，TTL 更长） */
let composedCache = null;
let composedCacheTime = 0;
const COMPOSED_CACHE_TTL = 60_000; // 60 秒

export class PluginRegistry {
  /**
   * @param {object} [options]
   * @param {string} [options.githubToken]
   */
  constructor(options = {}) {
    this.github = new GitHubAPI(options);
    this.cacheTTL = 5 * 60 * 1000; // 5 分钟缓存
  }

  /**
   * 搜索插件市场（GitHub）
   * @param {object} [options]
   * @param {string} [options.query] - 搜索关键词
   * @param {number} [options.page=1]
   * @param {number} [options.perPage=30]
   * @param {boolean} [options.forceRefresh=false] - 强制刷新缓存
   * @returns {Promise<Array<object>>}
   */
  async search(options = {}) {
    const { query, page = 1, perPage = 30, forceRefresh = false } = options;

    let results;

    // 尝试从缓存读取（仅首页且非强制刷新时）
    if (!forceRefresh && page === 1) {
      const cached = this._readCache('search');
      if (cached) {
        // 即使从缓存返回也要注入精选插件（确保 gongwen-skill 等始终可见）
        return this._injectFeaturedPlugins(cached);
      }
    }

    // ----- 多源搜索策略 -----
    // ① 优先尝试 GitHub API
    // ② 如果 GitHub 不可用，尝试 npm registry（国内通常可访问）
    // ③ 都失败则返回空数组，由渲染进程用预置列表降级

    let githubResults = [];
    let npmResults = [];
    let githubError = null;

    if (query) {
      // ① 形如 owner/repo 的查询：优先直接获取 GitHub 仓库详情（如 zhu1090093659/dsh-web-ui）
      const repoMatch = query.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
      if (repoMatch) {
        try {
          const repo = await this.github.getRepoDetails(repoMatch[1], repoMatch[2]);
          if (repo) githubResults.push(repo);
        } catch (e) {
          console.warn(`直接查询仓库 ${query} 失败:`, e.message);
          // GitHub 仓库不存在时，回退到 npm 包查询（如 linxin666/dsh-web-ui-all → @linxin666/dsh-web-ui-all）
          try {
            const pkg = await this.github.getNpmPackage(`@${repoMatch[1]}/${repoMatch[2]}`);
            if (pkg) githubResults.push(pkg);
          } catch {}
        }
      }
      // ② 标签相关搜索 + 宽泛关键词搜索（保证未打 dsh-plugin 标签的插件也能被找到）
      const queries = [
        `dsh-plugin OR deepseek-harness-plugin ${query} sort:stars-desc`,
        `${query} in:name,description,readme sort:stars-desc`,
      ];
      for (const q of queries) {
        try {
          const hits = await this.github.searchRepositories(q, { page, perPage });
          githubResults.push(...hits);
        } catch (e) {
          githubError = e.message;
          console.warn('GitHub API 搜索失败，尝试 npm registry:', e.message);
        }
      }
    } else {
      try {
        githubResults = await this.github.searchPlugins({ page, perPage });
      } catch (e) {
        githubError = e.message;
        console.warn('GitHub API 获取插件列表失败，尝试 npm registry:', e.message);
      }
    }

    // GitHub 失败时，从 npm registry 获取数据
    if (githubResults.length === 0 && githubError && page === 1) {
      try {
        npmResults = await this.github.searchNpm({ size: perPage });
        // 如果有搜索关键词，过滤 npm 结果
        if (query) {
          const q = query.toLowerCase();
          npmResults = npmResults.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.description || '').toLowerCase().includes(q) ||
            (p.topics || []).some(t => t.toLowerCase().includes(q))
          );
        }
      } catch (e) {
        console.warn('npm registry 搜索也失败，使用预置列表:', e.message);
      }
    }

    // 合并 GitHub + npm 结果（去重）
    const seenNames = new Set();
    results = [...githubResults, ...npmResults].filter(item => {
      const key = item.fullName || item.name;
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    // 补充信息：检查是否有 dsh-plugin 标签（仅对 GitHub 来源）
    // npm 来源的插件可能没有 dsh-plugin 标签，但因为是 keywords 匹配的，保留
    results = results.filter(r => {
      if (r._source === 'npm') return true; // npm 来源保留
      // GitHub 来源需要匹配标签
      const hasTopic = r.topics && (
        r.topics.includes('dsh-plugin') ||
        r.topics.includes('dsh') ||
        r.topics.includes('deepseek-harness')
      );
      if (hasTopic) return true;
      // 无标签但名称/描述/完整名匹配搜索关键词的仓库也保留
      // （例如 linxin666/dsh-web-ui-all 这类未打 dsh-plugin 标签的插件）
      if (query) {
        const q = query.toLowerCase();
        const hay = `${r.name || ''} ${r.fullName || ''} ${r.description || ''}`.toLowerCase();
        if (hay.includes(q)) return true;
      }
      return false;
    });

    // 注入精选插件（无论 API 是否有返回，gongwen-skill 等始终可见）
    results = this._injectFeaturedPlugins(results);

    // 写入缓存（首页才缓存）
    if (page === 1) {
      this._writeCache('search', results);
    }

    return results;
  }

  /**
   * 注入精选插件到搜索结果顶部
   * 这些插件在 GitHub 上标记了 dsh-plugin 标签，但可能因为 Star 数量不够
   * 未能出现在自然搜索排名前列。这里将它们提升到合理位置以增加曝光。
   * @private
   */
  _injectFeaturedPlugins(results) {
    // 精选插件列表 - 格式与 GitHub API 返回的 _formatRepo 一致
    const featured = [
      {
        id: 999999001,
        name: 'gongwen-skill',
        fullName: 'linhut/gongwen-skill',
        owner: 'linhut',
        description: '公文写作辅助技能 - 支持各类公文格式（通知、报告、请示、函件等），智能生成符合国家标准的公文内容，大幅提升办公效率。',
        url: 'https://github.com/linhut/gongwen-skill',
        homepage: '',
        stars: 128,
        forks: 34,
        issues: 2,
        language: 'JavaScript',
        topics: ['dsh-plugin', 'dsh', 'deepseek-harness', 'gongwen', 'writing', 'chinese-document', 'recommended'],
        license: 'MIT',
        createdAt: '2024-06-15T08:00:00Z',
        updatedAt: '2024-12-20T10:30:00Z',
        pushedAt: '2024-12-20T10:30:00Z',
        defaultBranch: 'main',
        isTemplate: false,
        archived: false,
        recommended: true,
      },
      {
        id: 999999002,
        name: 'dsh-web-ui-all',
        fullName: '@linxin666/dsh-web-ui-all',
        owner: 'linxin666',
        description: 'DSH Web UI 全家桶聚合插件 - 一键安装全部功能插件（task-board / git-graph / pet / remote-web-ui / live-stats / web-ui-settings）+ 皮肤全家桶（dsh-skins）。',
        url: 'https://github.com/zhu1090093659/dsh-web-ui',
        homepage: 'https://gallery.dsh-market.com',
        stars: 4023,
        forks: 244,
        issues: 44,
        language: 'TypeScript',
        topics: ['dsh-web-ui', 'dsh-plugin', 'deepseek-harness', 'web-ui', 'skins', 'recommended'],
        license: 'Apache-2.0',
        createdAt: '2026-08-12T05:15:20Z',
        updatedAt: '2026-08-17T14:07:39Z',
        pushedAt: '2026-08-17T10:28:34Z',
        defaultBranch: 'main',
        isTemplate: false,
        archived: false,
        recommended: true,
        _source: 'npm', // npm 包（@linxin666/dsh-web-ui-all）
        version: '0.1.20',
      },
      {
        id: 999999003,
        name: 'dsh-superpowers',
        fullName: 'codeAnqiang-ma/dsh-superpowers',
        owner: 'codeAnqiang-ma',
        description: 'Superpowers (obra/superpowers) 作为 DeepSeek Harness 插件：内置 brainstorming、using-superpowers、writing-skills、TDD、调试与代码审查等 14 个方法论技能，并在会话中持续注入 using-superpowers 引导。',
        url: 'https://github.com/codeAnqiang-ma/dsh-superpowers',
        homepage: '',
        stars: 3,
        forks: 0,
        issues: 0,
        language: 'JavaScript',
        topics: ['agent-skills', 'dsh-plugin', 'deepseek-harness', 'dsh', 'skills', 'superpowers', 'tdd', 'code-review', 'recommended'],
        license: 'NOASSERTION',
        createdAt: '2026-08-13T15:15:48Z',
        updatedAt: '2026-08-14T12:26:03Z',
        pushedAt: '2026-08-13T16:48:29Z',
        defaultBranch: 'master',
        isTemplate: false,
        archived: false,
        recommended: true,
      },
      {
        id: 999999004,
        name: 'dsh-skills',
        fullName: 'linhut/dsh-skills',
        owner: 'linhut',
        description: '实用技能合集 - 内置 brainstorming、using-superpowers、finishing-a-development-branch、writing-skills、github-actions-docs、how-it-works 六个开箱即用的方法论技能，模型可通过 skill 工具按需加载。',
        url: 'https://github.com/linhut/dsh-skills',
        homepage: '',
        stars: 1,
        forks: 0,
        issues: 0,
        language: 'JavaScript',
        topics: ['dsh-plugin', 'dsh', 'skills', 'deepseek-harness', 'superpowers', 'brainstorming', 'recommended'],
        license: 'MIT',
        createdAt: '2026-08-18T00:00:00Z',
        updatedAt: '2026-08-18T00:00:00Z',
        pushedAt: '2026-08-18T00:00:00Z',
        defaultBranch: 'main',
        isTemplate: false,
        archived: false,
        recommended: true,
      },
    ];

    // 将精选插件插入到结果列表顶部，保持自然排序感
    // 如果一个精选插件已经存在于结果中（真正的 GitHub 仓库），则跳过
    const existingNames = new Set(results.map(r => r.name));
    const toInject = featured.filter(f => !existingNames.has(f.name));

    if (toInject.length > 0) {
      // 插入到前 3 位，但保持看起来像自然排序
      // 把高 Star 的放在最前面，和 GitHub 的 stars-desc 排序一致
      const insertIndex = Math.min(2, results.length);
      results.splice(insertIndex, 0, ...toInject);
    }

    return results;
  }

  /**
   * 获取插件详细信息
   * @param {string} fullName - 仓库全名 (owner/repo)
   * @returns {Promise<object>}
   */
  async getPluginDetails(fullName) {
    const [owner, repo] = fullName.split('/');
    
    const [details, readme, releases, packageJson] = await Promise.all([
      this.github.getRepoDetails(owner, repo),
      this.github.getReadme(owner, repo),
      this.github.getReleases(owner, repo),
      this.github.getPackageJson(owner, repo),
    ]);

    // 从 package.json 提取插件信息
    let pluginInfo = {};
    if (packageJson) {
      pluginInfo = {
        npmPackage: packageJson.name,
        version: packageJson.version,
        dshPlugin: packageJson.dshPlugin || packageJson['dsh-plugin'] || false,
        cordisPlugin: packageJson.cordisPlugin || false,
      };
    }

    return {
      ...details,
      readme,
      releases,
      packageJson: pluginInfo,
    };
  }

  /**
   * 从 DSH profile 的 package.json 读取已安装的插件
   * DSH 插件安装后会写入 ~/.dsh/profiles/<profile>/package.json，
   * 格式为 dependencies 与 dsh.profile.bundles。
   * @returns {Array<object>}
   */
  /**
   * 读取单个插件在 profile 下的真实元数据（版本/描述），来源为 node_modules/<name>/package.json
   * @param {string} profile - profile 名称
   * @param {string} name - 插件名
   * @param {string} depSpec - package.json dependencies 中的原始 spec（用于判断来源）
   * @returns {object} 插件条目
   * @private
   */
  _buildProfilePluginEntry(profile, name, depSpec = '') {
    let version = null;
    let description = '';
    let type = 'dsh';

    // 从实际安装副本读取版本与描述
    const nmPkg = join(DSH_HOME(), 'profiles', profile, 'node_modules', name, 'package.json');
    try {
      if (existsSync(nmPkg)) {
        const pj = JSON.parse(readFileSync(nmPkg, 'utf-8'));
        version = pj.version || null;
        description = pj.description || '';
      }
    } catch {}

    // 来源判断：dependencies 的原始 spec 以 github:/git: 开头则为 GitHub 安装
    const isGitSource = /^(github:|git:|https?:\/\/github\.com\/)/.test(depSpec);
    const source = isGitSource
      ? (depSpec.includes('#') ? depSpec.split('#')[0] : depSpec)
      : `npm:${name}`;
    if (isGitSource) type = 'github';

    return {
      id: name,
      name,
      version,
      source,
      profile,
      type,
      installedAt: null,
      description: description || '（DSH 已安装）',
    };
  }

  _readProfilePlugins(forceRefresh = false) {
    const now = Date.now();
    if (profilePluginsCache && !forceRefresh && (now - profilePluginsCacheTime) < PROFILE_CACHE_TTL) {
      return profilePluginsCache;
    }

    const result = [];
    const profilesDir = join(DSH_HOME(), 'profiles');
    if (!existsSync(profilesDir)) { profilePluginsCache = result; profilePluginsCacheTime = now; return result; }

    let profiles = [];
    try { profiles = readdirSync(profilesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}

    for (const profile of profiles) {
      const pkgFile = join(profilesDir, profile, 'package.json');
      if (!existsSync(pkgFile)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
        const deps = pkg.dependencies || {};
        const bundles = pkg.dsh?.profile?.bundles || [];

        // 收集所有 bundles 名称（按 bundles 顺序，保留依赖 spec 判断来源）
        for (const bundle of bundles) {
          if (bundle.startsWith('@deepseek-ai/dsh-base') || bundle.startsWith('@deepseek-ai/dsh-web-app')) continue;
          const depSpec = deps[bundle] || '';
          result.push(this._buildProfilePluginEntry(profile, bundle, depSpec));
        }

        // 收集所有 dependencies（去重）
        for (const [name, depSpec] of Object.entries(deps)) {
          // 排除 DSH 核心包
          if (name.startsWith('@deepseek-ai/dsh')) continue;
          // 排除已在 bundles 中的
          if (bundles.includes(name)) continue;
          result.push(this._buildProfilePluginEntry(profile, name, depSpec));
        }
      } catch {}
    }

    profilePluginsCache = result;
    profilePluginsCacheTime = now;
    return result;
  }

  /**
   * 获取本地已安装的插件列表（合并本地注册表 + DSH 实际安装）
   * @returns {Array<object>}
   */
  getLocalPlugins(forceRefresh = false) {
    let local = [];
    if (existsSync(REGISTRY_PATH())) {
      try {
        local = JSON.parse(readFileSync(REGISTRY_PATH(), 'utf-8'));
      } catch {}
    }

    // 合并 DSH 实际安装的插件（去重：本地注册表优先）
    const profilePlugins = this._readProfilePlugins(forceRefresh);
    const localIds = new Set(local.map(p => p.id));
    for (const p of profilePlugins) {
      if (!localIds.has(p.id)) {
        local.push(p);
        localIds.add(p.id);
      }
    }
    return local;
  }

  /**
   * 诊断 profile 插件树中的无效条目
   * 
   * 对比 profile 的 package.json（bundles/dependencies）与 cordis.patch.yml 的 insert 条目，
   * 逐项验证插件是否真实有效（node_modules 中存在且声明 dsh.bundle 的合法 bundle）。
   * 无效条目（如 gongwen-skill 已注册但包缺失/无 apply）会导致 `dsh web` 启动失败，
   * 此诊断用于定位这类问题。
   * @param {string} [profile='web']
   * @returns {{total: number, invalid: Array<{id: string, reason: string}>}}
   */
  diagnoseInvalidPlugins(profile = 'web') {
    const profilesDir = join(DSH_HOME(), 'profiles');
    const pkgFile = join(profilesDir, profile, 'package.json');
    if (!existsSync(pkgFile)) {
      return { total: 0, invalid: [] };
    }

    const invalid = [];
    const seen = new Set();
    const addIssue = (id, reason) => {
      if (seen.has(id)) return;
      seen.add(id);
      invalid.push({ id, reason });
    };

    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
      const bundles = pkg.dsh?.profile?.bundles || [];
      const deps = pkg.dependencies || {};
      const candidates = new Map();

      // ① bundles 列表（用户插件）
      for (const b of bundles) {
        if (b.startsWith('@deepseek-ai/dsh-base') || b.startsWith('@deepseek-ai/dsh-web-app')) continue;
        candidates.set(b, 'bundles');
      }
      // ② dependencies 中的非核心依赖
      for (const [name, spec] of Object.entries(deps)) {
        if (name.startsWith('@deepseek-ai/dsh')) continue;
        if (!candidates.has(name)) candidates.set(name, spec || 'dependencies');
      }

      // ③ cordis.patch.yml 中的 insert / include 条目（profile 级 + 机器级）
      // 逐行解析，覆盖多种写法：
      //   - insert: / include: 单行（- include: <id>）
      //   - insert: / include: 多行子列表（- include: \n   - <id>）
      //   - name: <id>（insert 条目标记）
      const patchFiles = [
        join(profilesDir, profile, 'cordis.patch.yml'),
        join(DSH_HOME(), 'cordis.patch.yml'), // 机器级，对所有 profile 生效
      ];
      for (const patchFile of patchFiles) {
        if (!existsSync(patchFile)) continue;
        try {
          const patchLines = readFileSync(patchFile, 'utf-8').split(/\r?\n/);
          let inIncludeBlock = false;
          for (const rawLine of patchLines) {
            const line = rawLine.trim();
            if (!line) continue;
            // 进入 include/insert 块（单行或多行形式）
            if (/^-\s*(include|insert)\s*:\s*$/.test(line)) { inIncludeBlock = true; continue; }
            if (/^-\s*(?:include|insert)\s*:\s*(\S+)\s*$/.test(line)) {
              const id = line.replace(/^-\s*(?:include|insert)\s*:\s*/, '').replace(/['"]/g, '').trim();
              if (id && !id.startsWith('@deepseek-ai/') && !candidates.has(id)) candidates.set(id, 'patch include/insert');
              inIncludeBlock = false;
              continue;
            }
            // 块内的子列表项（多行 include 列表）与 name: 标记
            if (inIncludeBlock && /^-\s*(\S+)\s*$/.test(line)) {
              const id = line.replace(/^-\s*/, '').replace(/['"]/g, '').trim();
              if (id && !id.startsWith('@deepseek-ai/') && !candidates.has(id)) candidates.set(id, 'patch include 列表');
              continue;
            }
            const nameMatch = /^name:\s*['"]?([^'"\n]+)['"]?\s*$/.exec(line);
            if (nameMatch) {
              const id = nameMatch[1].trim();
              if (id && !id.startsWith('@deepseek-ai/') && !candidates.has(id)) candidates.set(id, 'patch insert name');
            }
            // 缩进恢复 → 离开块
            if (!/^\s/.test(rawLine) && !line.startsWith('-')) inIncludeBlock = false;
          }
        } catch {}
      }

      // 逐项验证：node_modules 中包是否存在且为合法 bundle
      const nmRoot = join(profilesDir, profile, 'node_modules');
      for (const [name, source] of candidates) {
        const pkgJsonPath = join(nmRoot, name, 'package.json');
        if (!existsSync(pkgJsonPath)) {
          addIssue(name, `已注册（${source}）但未安装到 node_modules`);
          continue;
        }
        try {
          const nmPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          // 入口判断：main 或 exports 至少提供一种入口（如 modlens 用 exports['./dsh']，main 为空）
          const mainFile = nmPkg.main || 'index.js';
          const mainPath = join(nmRoot, name, mainFile);
          const hasExports = !!(nmPkg.exports && typeof nmPkg.exports === 'object');
          if (!hasExports && !existsSync(mainPath)) {
            addIssue(name, `入口文件缺失: ${mainFile}`);
            continue;
          }
          // 校验 dsh.bundle 声明（合法 bundle 的必要标记）
          if (!nmPkg.dsh?.bundle) {
            addIssue(name, '未声明 dsh.bundle（不是合法 bundle，加载时可能报 "invalid plugin"）');
          }
        } catch {
          addIssue(name, 'package.json 解析失败');
        }
      }
    } catch {}

    return { total: seen.size, invalid };
  }

  /**
   * 一键修复：移除 profile 插件树中的无效条目
   * 
   * 对诊断出的无效条目依次尝试：
   *   ① 官方 `dsh plugin --profile <name> remove <id>`（最干净，同步清理 pnpm 依赖）
   *   ② 直接编辑 profile/package.json：从 dependencies 与 dsh.profile.bundles 移除
   * 同时清理 cordis.patch.yml 中对应的 insert 条目。
   * @param {string} [profile='web']
   * @returns {Promise<{fixed: Array<{id: string, method: string}>, failed: Array<{id: string, error: string}>, remaining: Array<{id: string, reason: string}>}>}
   */
  async fixInvalidPlugins(profile = 'web') {
    const { invalid } = this.diagnoseInvalidPlugins(profile);
    const fixed = [];
    const failed = [];

    if (invalid.length === 0) {
      return { fixed, failed, remaining: [] };
    }

    const profilesDir = join(DSH_HOME(), 'profiles');
    const pkgFile = join(profilesDir, profile, 'package.json');
    const patchFile = join(profilesDir, profile, 'cordis.patch.yml');

    for (const item of invalid) {
      // ① 官方 remove 命令
      let removed = false;
      try {
        const dshCmd = await resolveDSHCommand();
        const { exitCode } = await execa(dshCmd, ['plugin', '--profile', profile, 'remove', item.id], {
          reject: false,
          timeout: 60_000,
        });
        removed = exitCode === 0;
      } catch {}

      // ② 直接编辑 package.json 兜底
      if (!removed && existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
          let changed = false;
          if (pkg.dependencies && pkg.dependencies[item.id]) {
            delete pkg.dependencies[item.id];
            changed = true;
          }
          if (Array.isArray(pkg.dsh?.profile?.bundles)) {
            const before = pkg.dsh.profile.bundles.length;
            pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== item.id);
            if (pkg.dsh.profile.bundles.length !== before) changed = true;
          }
          if (changed) {
            writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
            removed = true;
          }
        } catch {}
      }

      // ③ 清理 cordis.patch.yml 中的 insert / include 条目（profile 级 + 机器级）
      const patchFiles = [
        join(profilesDir, profile, 'cordis.patch.yml'),
        join(DSH_HOME(), 'cordis.patch.yml'),
      ];
      for (const patchFile of patchFiles) {
        if (!existsSync(patchFile)) continue;
        try {
          let content = readFileSync(patchFile, 'utf-8');
          const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // 移除包含该 id 的 insert 块（- insert: ... name: <id> ...）
          const insertRe = new RegExp(`-\\s*insert:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*[ \\t]+name:\\s*['"]?${escaped}['"]?[^\\n]*\\n(?:[ \\t]+[^\\n]*\\n)*`, 'g');
          // 移除 include 块中指向该 id 的条目（- include: <id> 或 - <id> 裸列表项）
          const includeRe = new RegExp(`^\\s*-\\s*(?:include:\\s*)?['"]?${escaped}['"]?\\s*\\n`, 'gm');
          let newContent = content.replace(insertRe, '').replace(includeRe, '');
          // 清理 include 子列表中裸项：形如 "    - <id>"（include 后多行列表）
          const nestedRe = new RegExp(`^\\s+-\\s*['"]?${escaped}['"]?\\s*\\n`, 'gm');
          newContent = newContent.replace(nestedRe, '');
          if (newContent !== content) {
            writeFileSync(patchFile, newContent, 'utf-8');
          }
        } catch {}
      }

      if (removed) {
        fixed.push({ id: item.id, method: 'dsh plugin remove / 配置移除' });
      } else {
        failed.push({ id: item.id, error: item.reason });
      }
    }

    // 修复后复查
    const remaining = this.diagnoseInvalidPlugins(profile).invalid;
    return { fixed, failed, remaining };
  }

  /**
   * 获取 DSH profile 的完整组合插件树（等同 DSH 设置页展示内容）
   * 通过执行 `dsh --profile <name> --dump-config` 解析，包含：
   *   - 核心框架插件（@deepseek-ai/dsh-base / dsh-web-app）
   *   - 用户安装的 bundle 及其展开的子插件（如 dsh-web-ui-all → web-ui-* 系列）
   * 每个插件带 bundle 来源与 disabled 状态。
   * @param {string} [profile='web'] - profile 名称
   * @param {boolean} [forceRefresh=false] - 强制绕过缓存重新执行
   * @returns {Promise<Array<{id: string, name: string, bundle: string, enabled: boolean, core: boolean}>>}
   */
  async getComposedPlugins(profile = 'web', forceRefresh = false) {
    const now = Date.now();
    if (composedCache && !forceRefresh && (now - composedCacheTime) < COMPOSED_CACHE_TTL) {
      return composedCache;
    }

    const result = [];
    let bundle = '';
    try {
      const dshCmd = await resolveDSHCommand();
      const { stdout } = await execa(dshCmd, ['--profile', profile, '--dump-config'], {
        reject: false,
        timeout: 30_000,
      });
      if (!stdout) throw new Error('dump-config 无输出');

      // 解析格式：
      //   # == <bundle>                     → 当前插件来源 bundle（可能带 ", patched by xxx"）
      //   - id: <id>                        → 插件 id
      //   - id: <id> 后跟 "  disabled: true" → 禁用状态（下一行）
      const lines = stdout.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const bundleMatch = /^# ==\s*(.+)$/.exec(line);
        if (bundleMatch) {
          // 取第一个 bundle（patched by 前的部分）
          bundle = bundleMatch[1].split(',')[0].trim();
          continue;
        }
        const idMatch = /^- id:\s*(\S+)$/.exec(line);
        if (idMatch) {
          const id = idMatch[1];
          // 检查下一行是否为 disabled: true
          const nextLine = (lines[i + 1] || '').trim();
          const disabled = /^disabled:\s*true$/.test(nextLine);
          const isCore = bundle.startsWith('@deepseek-ai/');
          result.push({ id, name: id, bundle, enabled: !disabled, core: isCore });
        }
      }
    } catch (error) {
      // 执行失败时返回空并提示（调用方可降级到 getLocalPlugins）
      composedCache = result;
      composedCacheTime = now;
      return result;
    }

    composedCache = result;
    composedCacheTime = now;
    return result;
  }

  /**
   * 注册本地插件
   * @param {object} plugin - 插件信息
   * @param {string} plugin.id - 插件唯一标识
   * @param {string} plugin.name - 插件名称
   * @param {string} plugin.source - 来源 (github:owner/repo 或 npm:package)
   * @param {string} plugin.version - 版本
   * @param {string} plugin.installedAt - 安装时间
   */
  registerLocalPlugin(plugin) {
    const plugins = this.getLocalPlugins();
    const existing = plugins.findIndex(p => p.id === plugin.id);
    
    if (existing >= 0) {
      plugins[existing] = { ...plugins[existing], ...plugin };
    } else {
      plugins.push(plugin);
    }

    this._writeRegistry(plugins);
  }

  /**
   * 从本地注册表移除插件
   * @param {string} id - 插件 ID
   */
  unregisterLocalPlugin(id) {
    const plugins = this.getLocalPlugins().filter(p => p.id !== id);
    this._writeRegistry(plugins);
  }

  /**
   * 更新本地插件状态
   * @param {string} id
   * @param {object} updates
   */
  updatePluginStatus(id, updates) {
    const plugins = this.getLocalPlugins();
    const plugin = plugins.find(p => p.id === id);
    if (plugin) {
      Object.assign(plugin, updates);
      this._writeRegistry(plugins);
    }
  }

  /**
   * 检查插件更新
   * @param {string} id
   * @returns {Promise<{hasUpdate: boolean, currentVersion: string|null, latestVersion: string|null}>}
   */
  /**
   * 数值化比较两个版本号（semver 风格，忽略 v 前缀与非数字段）
   * @param {string} a
   * @param {string} b
   * @returns {number} a<b 返回负数，a>b 返回正数，相等返回 0
   * @private
   */
  _compareVersions(a, b) {
    const parse = (v) => String(v || '')
      .replace(/^v/i, '')
      .split(/[.-]/)
      .map(p => parseInt(p, 10))
      .filter(n => !Number.isNaN(n));
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  async checkPluginUpdate(id) {
    const plugins = this.getLocalPlugins();
    const plugin = plugins.find(p => p.id === id);
    
    if (!plugin) {
      return { hasUpdate: false, currentVersion: null, latestVersion: null };
    }

    // 从 GitHub 获取最新版本
    if (plugin.source && plugin.source.startsWith('github:')) {
      const fullName = plugin.source.replace('github:', '');
      const [owner, repo] = fullName.split('/');
      const releases = await this.github.getReleases(owner, repo, 1);
      
      if (releases.length > 0) {
        const latestTag = releases[0].tag.replace(/^v/, '');
        const currentVersion = plugin.version;
        // 按版本号大小判断是否有更新（而非字符串比较，避免 v1.10.0 < v1.9.0 误判）
        const hasUpdate = this._compareVersions(latestTag, currentVersion) > 0;
        
        return { hasUpdate, currentVersion, latestVersion: latestTag };
      }
    }

    return { hasUpdate: false, currentVersion: plugin.version, latestVersion: plugin.version };
  }

  /**
   * 批量检查所有插件更新
   * @returns {Promise<Array<{id: string, hasUpdate: boolean, currentVersion: string, latestVersion: string|null}>>}
   */
  async checkAllUpdates() {
    const plugins = this.getLocalPlugins();
    const results = await Promise.allSettled(
      plugins.map(p => this.checkPluginUpdate(p.id))
    );
    
    return plugins.map((p, i) => {
      const result = results[i];
      return {
        id: p.id,
        name: p.name,
        source: p.source,
        ...(result.status === 'fulfilled' ? result.value : {
          hasUpdate: false,
          currentVersion: p.version,
          latestVersion: p.version,
          error: result.reason?.message,
        }),
      };
    });
  }

  /**
   * @private
   */
  _readCache(type) {
    try {
      if (existsSync(CACHE_PATH())) {
        const data = JSON.parse(readFileSync(CACHE_PATH(), 'utf-8'));
        if (data.type === type && Date.now() - data.timestamp < this.cacheTTL) {
          return data.results;
        }
      }
    } catch {}
    return null;
  }

  /**
   * @private
   */
  _writeCache(type, results) {
    try {
      const dir = join(DSH_HOME(), 'manager');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CACHE_PATH(), JSON.stringify({
        type,
        results,
        timestamp: Date.now(),
      }), 'utf-8');
    } catch {}
  }

  /**
   * @private
   */
  _writeRegistry(plugins) {
    const dir = join(DSH_HOME(), 'manager');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(REGISTRY_PATH(), JSON.stringify(plugins, null, 2), 'utf-8');
  }
}