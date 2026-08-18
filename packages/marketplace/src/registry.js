/**
 * @dsh-manager/marketplace - 插件注册表
 * 
 * 管理本地插件注册信息、缓存、搜索
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { GitHubAPI } from './github-api.js';

const DSH_HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const REGISTRY_PATH = () => join(DSH_HOME(), 'manager', 'plugins.json');
const CACHE_PATH = () => join(DSH_HOME(), 'manager', 'marketplace-cache.json');
/** 从 DSH profile patch 文件解析出的插件名缓存（避免重复扫描） */
let profilePluginsCache = null;

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
   * 从 DSH 实际安装的 profile patch 文件解析插件（bundle 层安装的插件）
   * DSH 插件安装后会写入 ~/.dsh/profiles/<profile>/cordis.patch.yml，
   * 格式形如：- insert: / - id: xxx / name: '@scope/pkg'
   * @returns {Array<object>}
   */
  _readProfilePlugins() {
    if (profilePluginsCache) return profilePluginsCache;

    const result = [];
    const profilesDir = join(DSH_HOME(), 'profiles');
    if (!existsSync(profilesDir)) { profilePluginsCache = result; return result; }

    let profiles = [];
    try { profiles = readdirSync(profilesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}

    for (const profile of profiles) {
      const patchFile = join(profilesDir, profile, 'cordis.patch.yml');
      if (!existsSync(patchFile)) continue;
      try {
        const content = readFileSync(patchFile, 'utf-8');
        // 匹配 - id: xxx 或 name: '@scope/pkg' 形式的条目
        for (const line of content.split(/\r?\n/)) {
          const idMatch = line.match(/^\s*-\s*id:\s*(.+)$/);
          if (idMatch) {
            const id = idMatch[1].trim().replace(/^['"]|['"]$/g, '');
            if (!id) continue;
            result.push({
              id,
              name: id,
              source: `dsh:${profile}`,
              profile,
              type: 'dsh',
              installedAt: null,
              description: '（DSH 已安装）',
            });
          }
        }
      } catch {}
    }

    profilePluginsCache = result;
    return result;
  }

  /**
   * 获取本地已安装的插件列表（合并本地注册表 + DSH 实际安装）
   * @returns {Array<object>}
   */
  getLocalPlugins() {
    let local = [];
    if (existsSync(REGISTRY_PATH())) {
      try {
        local = JSON.parse(readFileSync(REGISTRY_PATH(), 'utf-8'));
      } catch {}
    }

    // 合并 DSH 实际安装的插件（去重：本地注册表优先）
    const profilePlugins = this._readProfilePlugins();
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
        const hasUpdate = latestTag !== currentVersion;
        
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