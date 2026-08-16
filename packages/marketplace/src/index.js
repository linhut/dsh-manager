/**
 * @dsh-manager/marketplace - 插件市场入口
 * 
 * 插件发现、安装、管理一站式解决方案
 */

export { PluginRegistry } from './registry.js';
export { PluginInstaller } from './installer.js';
export { PluginManager } from './manager.js';
export { GitHubAPI } from './github-api.js';

/**
 * 创建插件市场实例
 * @param {object} [options]
 * @param {string} [options.githubToken] - GitHub API Token
 * @returns {{ registry: PluginRegistry, installer: PluginInstaller, manager: PluginManager }}
 */
export function createMarketplace(options = {}) {
  const registry = new PluginRegistry(options);
  const installer = new PluginInstaller({ ...options, registry });
  const manager = new PluginManager({ ...options, registry, installer });
  return { registry, installer, manager };
}