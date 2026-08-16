/**
 * @dsh-manager/marketplace - GitHub API 封装
 * 
 * 搜索 dsh-plugin 主题仓库、获取仓库详情、README 等
 */

import { DSHError, DSHErrorCodes } from '../../core/src/index.js';

const GITHUB_API = 'https://api.github.com';

export class GitHubAPI {
  /**
   * @param {object} [options]
   * @param {string} [options.token] - GitHub Personal Access Token
   */
  constructor(options = {}) {
    this.token = options.token || process.env.GITHUB_TOKEN || null;
    this.headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'dsh-manager/0.2.0',
      ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
    };
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
      const response = await fetch(url, { headers: this.headers });
      
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
      const response = await fetch(url, { headers: this.headers });
      
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