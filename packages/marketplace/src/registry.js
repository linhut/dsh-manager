/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { resolveDSHCommand, isSystemComponent, isExternalPlugin, classifyPackage } from '../../core/src/index.js';
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

/**
 * 从 Node 报错的模块路径中提取包名
 * 输入: 'C:\Users\...\.dsh\profiles\web\node_modules\shiki\dist\core.mjs'
 *       '...node_modules\@deepseek-ai\dsh-client-ui-primitives\lib\index.js'
 * 输出: 'shiki' / '@deepseek-ai/dsh-client-ui-primitives'
 * @param {string} p - Cannot find module 后的路径
 * @returns {string|null}
 */
function extractPkgNameFromPath(p) {
  if (!p || typeof p !== 'string') return null;
  // 取 node_modules 之后的部分
  const idx = p.indexOf('node_modules');
  const rest = idx >= 0 ? p.slice(idx + 'node_modules'.length) : p;
  const parts = rest.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return null;
  // scoped 包（@scope/name）占两段
  if (parts[0].startsWith('@') && parts.length >= 2) {
    return parts[0] + '/' + parts[1];
  }
  return parts[0];
}

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
   * 搜索技能市场（GitHub）
   * 搜索标记了 dsh-skill / agent-skills 等技能相关标签的仓库
   * @param {object} [options]
   * @param {string} [options.query] - 搜索关键词
   * @param {number} [options.page=1]
   * @param {number} [options.perPage=30]
   * @returns {Promise<Array<object>>}
   */
  async searchSkillMarket(options = {}) {
    const { query, page = 1, perPage = 30 } = options;

    let results = [];

    // 构建 GitHub 搜索查询：技能相关标签 + 可选关键词
    const queries = [
      `topic:dsh-skill OR topic:agent-skills OR topic:skill ${query || ''} sort:stars-desc`,
      `${query ? query + ' ' : ''}in:name,description,readme sort:stars-desc`,
    ];
    for (const q of queries) {
      try {
        const hits = await this.github.searchRepositories(q, { page, perPage });
        for (const h of hits) {
          // 标记为技能来源
          h._source = 'skill-market';
          results.push(h);
        }
      } catch (e) {
        console.warn('GitHub 技能搜索失败:', e.message);
      }
    }

    // 去重（按 fullName）
    const seen = new Set();
    results = results.filter(r => {
      const key = r.fullName || r.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

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

    // 分类：系统组件 / 外部插件 / 用户插件
    const category = classifyPackage(name);

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
      category,
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
          if (isSystemComponent(bundle)) continue;
          const depSpec = deps[bundle] || '';
          result.push(this._buildProfilePluginEntry(profile, bundle, depSpec));
        }

        // 收集所有 dependencies（去重）
        for (const [name, depSpec] of Object.entries(deps)) {
          // 排除系统组件（DSH 核心框架）
          if (isSystemComponent(name)) continue;
          // 排除已在 bundles 中的
          if (bundles.includes(name)) continue;
          result.push(this._buildProfilePluginEntry(profile, name, depSpec));
        }

        // ④ cordis.patch.yml 中的 include/insert 条目（profile 级 + 机器级）
        // 这是 @linxin666 全家桶等插件常见的注册方式，不在 dependencies 中
        const patchFiles = [
          join(profilesDir, profile, 'cordis.patch.yml'),
          join(DSH_HOME(), 'cordis.patch.yml'),
        ];
        const seenIds = new Set(result.map(p => p.id));
        for (const patchFile of patchFiles) {
          if (!existsSync(patchFile)) continue;
          try {
            const patchLines = readFileSync(patchFile, 'utf-8').split(/\r?\n/);
            let inBlock = false;
            for (const rawLine of patchLines) {
              const line = rawLine.trim();
              if (!line) continue;
              if (/^-\s*(include|insert)\s*:\s*$/.test(line)) { inBlock = true; continue; }
              if (/^-\s*(?:include|insert)\s*:\s*(\S+)\s*$/.test(line)) {
                const id = line.replace(/^-\s*(?:include|insert)\s*:\s*/, '').replace(/['"]/g, '').trim();
                if (id && !isSystemComponent(id) && !seenIds.has(id)) {
                  seenIds.add(id);
                  result.push(this._buildProfilePluginEntry(profile, id, ''));
                }
                inBlock = false;
                continue;
              }
              if (inBlock && /^-\s*(\S+)\s*$/.test(line)) {
                const id = line.replace(/^-\s*/, '').replace(/['"]/g, '').trim();
                if (id && !isSystemComponent(id) && !seenIds.has(id)) {
                  seenIds.add(id);
                  result.push(this._buildProfilePluginEntry(profile, id, ''));
                }
                continue;
              }
              const nameMatch = /^name:\s*['"]?([^'"\n]+)['"]?\s*$/.exec(line);
              if (nameMatch) {
                const id = nameMatch[1].trim();
                if (id && !isSystemComponent(id) && !seenIds.has(id)) {
                  seenIds.add(id);
                  result.push(this._buildProfilePluginEntry(profile, id, ''));
                }
              }
              if (!/^\s/.test(rawLine) && !line.startsWith('-')) inBlock = false;
            }
          } catch {}
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
   * @param {string} [stderr] - DSH 启动失败时的 stderr（从中提取运行时报错的插件 ID）
   * @returns {{total: number, invalid: Array<{id: string, reason: string}>}}
   */
  diagnoseInvalidPlugins(profile = 'web', stderr) {
    const profilesDir = join(DSH_HOME(), 'profiles');
    const pkgFile = join(profilesDir, profile, 'package.json');
    if (!existsSync(pkgFile)) {
      return { total: 0, invalid: [] };
    }

    const invalid = [];
    const seen = new Set();
    const addIssue = (id, reason, kind = 'plugin') => {
      if (seen.has(id)) return;
      seen.add(id);
      invalid.push({ id, reason, kind });
    };

    // 从 stderr 提取运行时加载失败的插件（最可靠信号：DSH 自己报错说哪个插件无效）
    if (stderr) {
      // ① 插件加载失败：failed to apply/import loader entry <机制名> (<插件ID>)
      //    注意：括号内可能是 undefined（如损坏 include 条目 "ui-skin-stock (undefined)"），
      //    此时回退使用 loader entry 名（ui-skin-stock）；cordis:include 等机制名需过滤
      const re = /failed to (?:apply|import) loader entry\s+([^\s(]+)(?:\s*\(([^)]*)\))?/g;
      let m;
      while ((m = re.exec(stderr)) !== null) {
        let id = (m[2] || '').trim();
        // 括号内是 cordis 机制名（如 include (cordis:include)）→ loader entry 为机制本身，跳过
        if (id && /^cordis:/i.test(id)) {
          continue;
        }
        // 括号值无效（undefined / 空）→ 使用 loader entry 名（如 ui-skin-stock）
        if (!id || id === 'undefined') {
          id = (m[1] || '').trim();
        }
        if (id && !isSystemComponent(id) && !/^cordis:/i.test(id)) {
          addIssue(id, '启动时加载失败（stderr 指示）');
        }
      }
      // ② 模块缺失：Cannot find module 'C:\...\node_modules\shiki\dist\core.mjs'
      //    （Node 报错为单引号路径，需从路径中提取包名，标记为 module 类型以便自动补齐）
      const re2 = /Cannot find module ['"]([^'"]+)['"]/g;
      while ((m = re2.exec(stderr)) !== null) {
        const pkg = extractPkgNameFromPath(m[1]);
        if (pkg && !isSystemComponent(pkg)) {
          addIssue(pkg, '模块缺失（stderr 指示）', 'module');
        }
      }
    }

    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
      const bundles = pkg.dsh?.profile?.bundles || [];
      const deps = pkg.dependencies || {};
      const candidates = new Map();

      // ① bundles 列表（用户插件）
      for (const b of bundles) {
        if (isSystemComponent(b)) continue;
        candidates.set(b, 'bundles');
      }
      // ② dependencies 中的非核心依赖
      for (const [name, spec] of Object.entries(deps)) {
        if (isSystemComponent(name)) continue;
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
              if (id && !isSystemComponent(id) && !candidates.has(id)) candidates.set(id, 'patch include/insert');
              inIncludeBlock = false;
              continue;
            }
            // 块内的子列表项（多行 include 列表）与 name: 标记
            if (inIncludeBlock && /^-\s*(\S+)\s*$/.test(line)) {
              const id = line.replace(/^-\s*/, '').replace(/['"]/g, '').trim();
              if (id && !isSystemComponent(id) && !candidates.has(id)) candidates.set(id, 'patch include 列表');
              continue;
            }
            const nameMatch = /^name:\s*['"]?([^'"\n]+)['"]?\s*$/.exec(line);
            if (nameMatch) {
              const id = nameMatch[1].trim();
              if (id && !isSystemComponent(id) && !candidates.has(id)) candidates.set(id, 'patch insert name');
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
          // 关键：仅对 bundles 列表中的条目强制要求。普通 dependencies（如 shiki/katex）
          // 是 DSH 的纯库依赖，官方规范明确"plain library is fine"，若此处误判为无效插件，
          // fixInvalidPlugins 会执行 `dsh plugin remove <id>` 把真实依赖卸载，导致
          // "Cannot find package 'shiki'" 之类启动失败。
          if (source === 'bundles' && !nmPkg.dsh?.bundle) {
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
      // 关键保护：kind === 'module' 的条目是"缺失模块"（如 shiki 传递依赖），
      // 只能通过复制/安装补齐，绝不能执行 dsh plugin remove / 从 dependencies 删除，
      // 否则会把 DSH 真实依赖卸载掉，导致 "Cannot find package 'shiki'" 启动失败。
      if (item.kind === 'module') {
        failed.push({ id: item.id, error: '缺失模块（需补齐安装，不应移除）' });
        continue;
      }

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

      // ③ 清理 cordis.patch.yml 中的条目（使用共享方法）
      try {
        this.cleanupPatchEntries(profile, item.id);
      } catch {}

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

  /**
   * 从 cordis.patch.yml 中移除指定插件 ID 的条目（profile 级 + 机器级）
   * 兼容 include/insert 单行、嵌套列表、多行块等格式，同时清理兄弟项与空块头。
   * @param {string} profile
   * @param {string|string[]} pluginIds - 要移除的插件 ID 或 ID 数组
   */
  cleanupPatchEntries(profile, pluginIds) {
    const ids = Array.isArray(pluginIds) ? pluginIds : [pluginIds];
    const profilesDir = join(DSH_HOME(), 'profiles');
    const patchFiles = [
      join(profilesDir, profile, 'cordis.patch.yml'),
      join(DSH_HOME(), 'cordis.patch.yml'),
    ];
    for (const patchFile of patchFiles) {
      if (!existsSync(patchFile)) continue;
      try {
        const original = readFileSync(patchFile, 'utf-8');
        const lines = original.split(/\r?\n/);
        const isTarget = (text) => ids.some(id => text.includes(id));

        let result = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          const trimmed = line.trim();

          // 单行 include/insert: <id>
          if (/^-\s*(?:include|insert)\s*:\s*['"]?\S+['"]?\s*$/.test(trimmed)) {
            if (isTarget(trimmed)) { i++; continue; }
            result.push(line); i++; continue;
          }

          // 裸列表项 - <id>（顶层或嵌套）
          if (/^-\s+\S+/.test(trimmed) && !/^-\s*(include|insert)\s*:\s*$/.test(trimmed)) {
            if (isTarget(trimmed)) { i++; continue; }
            result.push(line); i++; continue;
          }

          // 块头 - include:/insert:（单独一行，冒号后无值）
          if (/^-\s*(include|insert)\s*:\s*$/.test(trimmed)) {
            let j = i + 1;
            const blockLines = [line];
            let anyRemoved = false;
            while (j < lines.length && /^\s+/.test(lines[j])) {
              const childTrimmed = lines[j].trim();
              if (isTarget(childTrimmed)) {
                j++;
                while (j < lines.length && /^\s+/.test(lines[j]) && !/^-\s+/.test(lines[j].trim())) {
                  j++;
                }
                anyRemoved = true;
              } else {
                blockLines.push(lines[j]);
                j++;
              }
            }
            if (blockLines.length > 1) {
              result.push(...blockLines);
            }
            i = j;
            continue;
          }

          result.push(line);
          i++;
        }
        // 关键：cordis.patch.yml 必须始终是"顶层 YAML 数组"。
        // 若清理后没有任何有效条目（只剩注释/空行，如机器级补丁文件仅存
        // 一条损坏 insert 被移除的场景），必须写回顶层空数组 []，
        // 否则 DSH 启动时报 "must be a top-level YAML array of loader patch entries"。
        // 注意：文件可能已自带 []（如 profile 级默认模板），且历史上可能被
        // 重复追加成 []\n[]（YAML 重复文档报错）——无条目时一律重建为
        // 「注释行 + 单个 []」，既保证数组不变量又去除重复。
        const hasEntries = result.some(l => l.trim().startsWith('-'));
        let finalContent = result.join('\n').trimEnd();
        if (!hasEntries) {
          const comments = result
            .filter(l => l.trim().startsWith('#'))
            .join('\n')
            .trimEnd();
          finalContent = (comments ? comments + '\n' : '') + '[]';
        }
        if (finalContent !== original.trimEnd()) {
          writeFileSync(patchFile, finalContent + '\n', 'utf-8');
        }
      } catch (e) {
        console.warn('清理 patch 文件失败:', patchFile, e.message);
      }
    }
  }

  /**
   * 在 cordis.patch.yml 中设置插件的 disabled 标记（禁用/启用插件）
   * 兼容 include/insert 单行与多行块格式
   * @param {string} profile
   * @param {string} pluginId
   * @param {boolean} disabled
   * @returns {{success: boolean, message?: string}}
   */
  setPluginDisabled(profile, pluginId, disabled) {
    const profilesDir = join(DSH_HOME(), 'profiles');
    const patchFiles = [
      join(profilesDir, profile, 'cordis.patch.yml'),
      join(DSH_HOME(), 'cordis.patch.yml'),
    ];
    let touched = false;
    for (const patchFile of patchFiles) {
      if (!existsSync(patchFile)) continue;
      try {
        const original = readFileSync(patchFile, 'utf-8');
        const lines = original.split(/\r?\n/);
        const out = [];
        let inBlock = null; // 'include' | 'insert' | null
        let blockIndent = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // 单行 include/insert: <id>
          const singleMatch = /^-\s*(include|insert):\s*['"]?([^'"\s]+)['"]?\s*$/.exec(trimmed);
          if (singleMatch && !inBlock) {
            const [, type, id] = singleMatch;
            if (id === pluginId) {
              if (disabled) {
                // 改为两行：- include: <id>\n  disabled: true
                out.push(line);
                const indent = (line.match(/^\s*/) || [''])[0] + '  ';
                out.push(indent + 'disabled: true');
              } else {
                // 移除紧随的 disabled: true 行（若存在）
                out.push(line);
                const nextLine = lines[i + 1] || '';
                if (nextLine.trim().startsWith('disabled:')) {
                  i++; // 跳过下一行
                }
              }
              touched = touched || true;
            } else {
              out.push(line);
            }
            continue;
          }

          // 块头：- include:/insert:（冒号后无值）
          const blockMatch = /^-\s*(include|insert):\s*$/.exec(trimmed);
          if (blockMatch && !inBlock) {
            inBlock = blockMatch[1];
            blockIndent = (line.match(/^\s*/) || [''])[0].length;
            out.push(line);
            continue;
          }

          // 块内行
          if (inBlock) {
            const indentLen = (line.match(/^\s*/) || [''])[0].length;
            if (/^\s+/.test(line)) {
              // 子项行：- <id> / - id: <id> / name: <id> / disabled: <bool>
              const childMatch = /^\s*-(?:\s*(?:id|name)\s*:\s*)?['"]?([^'"\s]+)['"]?/.exec(trimmed);
              if (childMatch && childMatch[1] === pluginId) {
                // 找到目标条目：在条目末尾添加/移除 disabled
                out.push(line);
                // 查找并处理该条目的后续兄弟行（name:, disabled: 等）
                let j = i + 1;
                let itemLines = [line];
                while (j < lines.length && /^\s+/.test(lines[j]) && indentLen === (lines[j].match(/^\s*/) || [''])[0].length) {
                  // 同层级缩进的键值行属于当前条目
                  break;
                }
                if (disabled && !/disabled\s*:/.test(itemLines.join('\n'))) {
                  out.push(' '.repeat(blockIndent + 2) + 'disabled: true');
                }
                touched = true;
                continue;
              }
              if (/^\s*disabled\s*:/.test(trimmed) && !disabled) {
                // 删除前面的 disabled 行（已在 if 中通过 itemLines 处理）
                continue; // 直接跳过
              }
              out.push(line);
              continue;
            }
            // 块结束
            inBlock = null;
            out.push(line);
            continue;
          }

          // 普通行
          out.push(line);
        }
        const newContent = out.join('\n');
        if (newContent !== original) {
          writeFileSync(patchFile, newContent, 'utf-8');
          touched = true;
        }
      } catch (e) {
        console.warn('设置插件 disabled 失败:', patchFile, e.message);
      }
    }
    return { success: touched, message: touched ? (disabled ? '已禁用' : '已启用') : '未找到对应条目' };
  }
}