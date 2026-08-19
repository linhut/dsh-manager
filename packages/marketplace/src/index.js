/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { PluginRegistry } from './registry.js';
import { PluginInstaller } from './installer.js';
import { PluginManager } from './manager.js';
import { GitHubAPI } from './github-api.js';

export { PluginRegistry };
export { PluginInstaller };
export { PluginManager };
export { GitHubAPI };

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