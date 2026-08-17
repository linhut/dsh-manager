/**
 * @dsh-manager/marketplace - GitHub API 封装
 * 
 * 搜索 dsh-plugin 主题仓库、获取仓库详情、README 等
 */

import { DSHError, DSHErrorCodes } from '../../core/src/index.js';

const GITHUB_API = 'https://api.github.com';
const NPM_REGISTRY = 'https://registry.npmjs.org';
/** 每次请求超时（毫秒） */
const FETCH_TIMEOUT = 15_000;
/** 最大重试次数 */
const MAX_RETRIES = 2;
/** 重试间隔（毫秒） */
const RETRY_DELAY = 2_000;

export class GitHubAPI {
  /**
   * @param {object} [options]
   * @param {string} [options.token] - GitHub Personal Access Token
   */
  constructor(options = {}) {
    this.token = options.token || process.env.GITHUB_TOKEN || null;
    this.headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'dsh-manager/0.3.0',
      ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
    };
  }

  /**
   * 带超时和重试的 fetch 封装
   * @param {string} url - 请求 URL
   * @param {object} [options] - fetch 选项
   * @param {number} [attempt=1] - 当前重试次数
   * @returns {Promise<Response>}
   * @private
   */
  async _fetchWithRetry(url, options = {}, attempt = 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { ...this.headers, ...options.headers },
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      // 超时或网络错误时重试
      if (error.name === 'AbortError' || error.type === 'system' || error.code === 'ERR_NETWORK') {
        if (attempt <= MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY * attempt));
          return this._fetchWithRetry(url, options, attempt + 1);
        }
        throw new DSHError(
          DSHErrorCodes.NETWORK_ERROR,
          `网络请求超时，已重试 ${MAX_RETRIES} 次，请检查网络连接`
        );
      }
      throw error;
    }
  }

  /**
   * 搜索带有 dsh-plugin 主题的仓库
   * @param {object} [options]
   * @param {number} [options.page=1]
   * @param {number} [options.perPage=30]
   * @returns {Promise<Array<object>>}
   */
  async searchPlugins(options = {}) {
    const { page = 1, perPage = 30 } = options;
    
    const query = 'topic:dsh-plugin sort:stars-desc';
    const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&page=${page}&per_page=${Math.min(perPage, 100)}`;

    try {
      const response = await this._fetchWithRetry(url);
      
      if (!response.ok) {
        throw new DSHError(
          DSHErrorCodes.GITHUB_API_ERROR,
          `GitHub API 错误: ${response.status} ${response.statusText}`,
          { status: response.status }
        );
      }

      const data = await response.json();
      
      return data.items.map(item => this._formatRepo(item));
    } catch (error) {
      if (error instanceof DSHError) throw error;
      throw new DSHError(
        DSHErrorCodes.NETWORK_ERROR,
        `网络请求失败: ${error.message}`
      );
    }
  }

  /**
   * 从 npm registry 搜索 dsh-plugin 相关包（作为 GitHub API 的备用源）
   * npm 在国内通常可访问，且 DSH 插件都是 npm 包
   * @param {object} [options]
   * @param {number} [options.size=30]
   * @returns {Promise<Array<object>>}
   */
  async searchNpm(options = {}) {
    const { size = 30 } = options;
    // 搜索 keywords 包含 dsh-plugin 的 npm 包
    const url = `${NPM_REGISTRY}/-/v1/search?text=keywords:dsh-plugin&size=${Math.min(size, 100)}`;

    try {
      const response = await this._fetchWithRetry(url, {
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new DSHError(
          DSHErrorCodes.NETWORK_ERROR,
          `npm registry 错误: ${response.status}`
        );
      }

      const data = await response.json();
      const objects = data.objects || [];

      return objects.map((item, idx) => {
        const pkg = item.package || {};
        const score = item.score || {};
        // 从 repository URL 提取仓库信息
        const repoUrl = pkg.links?.repository || pkg.links?.homepage || '';
        const repoMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.#?]+)/);
        const owner = repoMatch ? repoMatch[1] : 'npm';
        const repo = repoMatch ? repoMatch[2] : pkg.name.replace(/^@/, '').replace(/\//, '-');

        return {
          id: `npm-${pkg.name}-${idx}`,
          name: repo,
          fullName: repoMatch ? `${owner}/${repo}` : pkg.name,
          owner,
          description: pkg.description || '暂无描述',
          url: pkg.links?.homepage || repoUrl || `https://www.npmjs.com/package/${pkg.name}`,
          homepage: pkg.links?.homepage || '',
          stars: Math.round((score.final || 0) * 100), // 用评分作为 Star 数的近似值
          forks: 0,
          issues: 0,
          language: 'JavaScript',
          topics: (pkg.keywords || []).filter(k => typeof k === 'string'),
          license: null,
          createdAt: pkg.date || new Date().toISOString(),
          updatedAt: pkg.date || new Date().toISOString(),
          pushedAt: pkg.date || new Date().toISOString(),
          defaultBranch: 'main',
          isTemplate: false,
          archived: false,
          _source: 'npm', // 标记来源为 npm
        };
      });
    } catch (error) {
      if (error instanceof DSHError) throw error;
      throw new DSHError(
        DSHErrorCodes.NETWORK_ERROR,
        `npm 搜索失败: ${error.message}`
      );
    }
  }

  /**
   * 按包名直接查询 npm 包信息
   * 
   * 用于处理 owner/repo 形式的查询在 GitHub 上不存在时回退到 npm 包
   * （例如 linxin666/dsh-web-ui-all → npm 包 @linxin666/dsh-web-ui-all）
   * @param {string} packageName - npm 包名，如 @linxin666/dsh-web-ui-all
   * @returns {Promise<object|null>} 与 _formatRepo 兼容的结构
   */
  async getNpmPackage(packageName) {
    // 仅编码斜杠，保留 @，如 @linxin666%2Fdsh-web-ui-all
    const encoded = packageName.replace(/\//g, '%2F');
    const url = `${NPM_REGISTRY}/${encoded}`;

    try {
      const response = await this._fetchWithRetry(url, {
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) return null;

      const data = await response.json();
      const latest = data['dist-tags']?.latest;
      const meta = latest ? data.versions?.[latest] : data;

      // 从 repository 字段提取 GitHub 信息
      let owner = '';
      let repo = packageName.replace(/^@[^/]+\//, '');
      const repoUrl = typeof meta?.repository === 'string'
        ? meta.repository
        : meta?.repository?.url || '';
      const repoMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.#?]+)/);
      if (repoMatch) {
        owner = repoMatch[1];
        repo = repoMatch[2];
      } else if (packageName.startsWith('@')) {
        owner = packageName.slice(1).split('/')[0];
      }

      const license = typeof meta?.license === 'string'
        ? meta.license
        : meta?.license?.spdx_id || null;

      return {
        id: `npm-${packageName}`,
        name: repo,
        fullName: packageName,
        owner,
        description: meta?.description || data.description || '暂无描述',
        url: repoUrl || `https://www.npmjs.com/package/${packageName}`,
        homepage: meta?.homepage || '',
        stars: 0,
        forks: 0,
        issues: 0,
        language: meta?.language || 'JavaScript',
        topics: Array.isArray(meta?.keywords) ? meta.keywords : [],
        license,
        createdAt: data.time?.created || new Date().toISOString(),
        updatedAt: data.time?.modified || new Date().toISOString(),
        pushedAt: data.time?.modified || new Date().toISOString(),
        defaultBranch: 'main',
        isTemplate: false,
        archived: false,
        version: latest || meta?.version || null,
        _source: 'npm', // 标记来源为 npm
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 获取仓库详细信息
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @returns {Promise<object>}
   */
  async getRepoDetails(owner, repo) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}`;

    try {
      const response = await fetch(url, { headers: this.headers });
      
      if (!response.ok) {
        throw new DSHError(
          DSHErrorCodes.GITHUB_API_ERROR,
          `获取仓库详情失败: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      return this._formatRepo(data);
    } catch (error) {
      if (error instanceof DSHError) throw error;
      throw new DSHError(
        DSHErrorCodes.NETWORK_ERROR,
        `网络请求失败: ${error.message}`
      );
    }
  }

  /**
   * 获取仓库 README
   * @param {string} owner
   * @param {string} repo
   * @returns {Promise<string|null>}
   */
  async getReadme(owner, repo) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/readme`;

    try {
      const response = await fetch(url, { headers: this.headers });
      
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new DSHError(
          DSHErrorCodes.GITHUB_API_ERROR,
          `获取 README 失败: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      // README 内容是 base64 编码的
      if (data.content) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch (error) {
      if (error instanceof DSHError) throw error;
      return null;
    }
  }

  /**
   * 获取仓库的发布版本
   * @param {string} owner
   * @param {string} repo
   * @param {number} [limit=5]
   * @returns {Promise<Array<{tag: string, name: string, publishedAt: string, url: string}>>}
   */
  async getReleases(owner, repo, limit = 5) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=${limit}`;

    try {
      const response = await fetch(url, { headers: this.headers });
      
      if (!response.ok) return [];

      const data = await response.json();
      return data.map(release => ({
        tag: release.tag_name,
        name: release.name || release.tag_name,
        publishedAt: release.published_at,
        url: release.html_url,
        isPrerelease: release.prerelease,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取仓库的 package.json（如果存在）
   * @param {string} owner
   * @param {string} repo
   * @param {string} [branch='main']
   * @returns {Promise<object|null>}
   */
  async getPackageJson(owner, repo, branch = 'main') {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/package.json?ref=${branch}`;

    try {
      const response = await fetch(url, { headers: this.headers });
      
      if (!response.ok) return null;

      const data = await response.json();
      if (data.content) {
        return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 搜索特定关键词的仓库（扩展搜索）
   * @param {string} query - 搜索关键词
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async searchRepositories(query, options = {}) {
    const { page = 1, perPage = 30 } = options;
    const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&page=${page}&per_page=${Math.min(perPage, 100)}&sort=stars&order=desc`;

    try {
      const response = await this._fetchWithRetry(url);
      
      if (!response.ok) {
        throw new DSHError(
          DSHErrorCodes.GITHUB_API_ERROR,
          `搜索失败: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      return data.items.map(item => this._formatRepo(item));
    } catch (error) {
      if (error instanceof DSHError) throw error;
      throw new DSHError(
        DSHErrorCodes.NETWORK_ERROR,
        `网络请求失败: ${error.message}`
      );
    }
  }

  /**
   * @private
   */
  _formatRepo(item) {
    return {
      id: item.id,
      name: item.name,
      fullName: item.full_name,
      owner: item.owner?.login || item.owner?.name,
      description: item.description || '暂无描述',
      url: item.html_url,
      homepage: item.homepage,
      stars: item.stargazers_count || 0,
      forks: item.forks_count || 0,
      issues: item.open_issues_count || 0,
      language: item.language,
      topics: item.topics || [],
      license: item.license?.spdx_id || null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      pushedAt: item.pushed_at,
      defaultBranch: item.default_branch || 'main',
      isTemplate: item.is_template || false,
      archived: item.archived || false,
    };
  }
}