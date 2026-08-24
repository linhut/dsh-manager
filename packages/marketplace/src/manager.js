/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { DSHError, DSHErrorCodes } from '../../core/src/index.js';
import { PluginRegistry } from './registry.js';
import { PluginInstaller } from './installer.js';

export class PluginManager {
  /**
   * @param {object} options
   * @param {PluginRegistry} [options.registry]
   * @param {PluginInstaller} [options.installer]
   * @param {string} [options.profile='web']
   */
  constructor(options = {}) {
    this.registry = options.registry || new PluginRegistry(options);
    this.installer = options.installer || new PluginInstaller({ ...options, registry: this.registry });
    this.profile = options.profile || 'web';
  }

  /**
   * 获取所有插件列表（含状态信息）
   * @returns {Promise<{local: Array<object>, updates: Array<object>}>}
   */
  async listAll() {
    const local = this.registry.getLocalPlugins();
    
    // 检查更新
    let updates = [];
    try {
      updates = await this.registry.checkAllUpdates();
    } catch {
      // 更新检查失败不影响主列表
    }

    // 合并状态
    const localWithStatus = local.map(plugin => {
      const updateInfo = updates.find(u => u.id === plugin.id);
      return {
        ...plugin,
        hasUpdate: updateInfo?.hasUpdate || false,
        latestVersion: updateInfo?.latestVersion || plugin.version,
      };
    });

    return { local: localWithStatus, updates };
  }

  /**
   * 获取插件详情
   * @param {string} pluginId - 插件 ID
   * @returns {Promise<object|null>}
   */
  async getPlugin(pluginId) {
    const local = this.registry.getLocalPlugins();
    const plugin = local.find(p => p.id === pluginId);
    
    if (!plugin) return null;

    // 检查更新
    let updateInfo = { hasUpdate: false, latestVersion: plugin.version };
    try {
      updateInfo = await this.registry.checkPluginUpdate(pluginId);
    } catch {}

    return {
      ...plugin,
      ...updateInfo,
    };
  }

  /**
   * 启用插件
   * @param {string} pluginId
   * @returns {Promise<{success: boolean}>}
   */
  async enable(pluginId) {
    const plugin = this.registry.getLocalPlugins().find(p => p.id === pluginId);
    if (!plugin) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `插件未找到: ${pluginId}`);
    }

    // 更新本地注册表
    this.registry.updatePluginStatus(pluginId, { enabled: true, enabledAt: new Date().toISOString() });
    // 实际修改 cordis.patch.yml 移除 disabled 标记
    this.registry.setPluginDisabled(this.profile, pluginId, false);
    return { success: true };
  }

  /**
   * 禁用插件
   * @param {string} pluginId
   * @returns {Promise<{success: boolean}>}
   */
  async disable(pluginId) {
    const plugin = this.registry.getLocalPlugins().find(p => p.id === pluginId);
    if (!plugin) {
      throw new DSHError(DSHErrorCodes.PLUGIN_NOT_FOUND, `插件未找到: ${pluginId}`);
    }

    // 更新本地注册表
    this.registry.updatePluginStatus(pluginId, { enabled: false, disabledAt: new Date().toISOString() });
    // 实际修改 cordis.patch.yml 添加 disabled: true 标记
    this.registry.setPluginDisabled(this.profile, pluginId, true);
    return { success: true };
  }

  /**
   * 从市场搜索并安装插件
   * @param {string} query - 搜索关键词或仓库名
   * @returns {Promise<object>}
   */
  async installFromMarketplace(query) {
    // 先搜索
    const results = await this.registry.search({ query, perPage: 5 });
    
    if (results.length === 0) {
      throw new DSHError(
        DSHErrorCodes.PLUGIN_NOT_FOUND,
        `未找到匹配的插件: ${query}`
      );
    }

    // 取第一个结果安装
    const plugin = results[0];
    const source = `github:${plugin.fullName}`;
    
    return await this.installer.install(source, { fromMarketplace: true });
  }

  /**
   * 批量安装插件
   * @param {string[]} sources - 插件来源列表
   * @returns {Promise<Array<{source: string, success: boolean, error?: string}>>}
   */
  async batchInstall(sources) {
    const results = [];
    
    for (const source of sources) {
      try {
        const result = await this.installer.install(source);
        results.push({ source, success: true, ...result });
      } catch (error) {
        results.push({ source, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * 获取插件统计数据
   * @returns {Promise<object>}
   */
  async getStats() {
    const local = this.registry.getLocalPlugins();
    
    // 检查更新
    let updates = [];
    try {
      updates = await this.registry.checkAllUpdates();
    } catch (e) {
      // 更新检查失败不影响统计
      console.warn('[dsh-manager] 获取插件更新状态失败:', e?.message);
    }
    
    return {
      total: local.length,
      enabled: local.filter(p => p.enabled !== false).length,
      disabled: local.filter(p => p.enabled === false).length,
      fromGitHub: local.filter(p => p.type === 'github').length,
      fromNpm: local.filter(p => p.type === 'npm').length,
      needsUpdate: updates.filter(u => u.hasUpdate).length,
    };
  }
}
