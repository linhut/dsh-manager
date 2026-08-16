/**
 * @dsh-manager/cli - CLI 入口
 * 
 * 导出所有命令处理函数供其他模块使用
 */

export { launchTUI } from './tui.js';
export { handleInstall, handleUninstall } from './commands/install.js';
export { handleStatus } from './commands/status.js';
export { handleDoctor } from './commands/doctor.js';
export {
  handlePluginList,
  handlePluginInstall,
  handlePluginSearch,
  handlePluginInfo,
  handlePluginRemove,
  handlePluginUpdate,
  handleCheckUpdates,
} from './commands/plugin.js';
export { handleMarketplace } from './commands/marketplace.js';
export { handleConfigShow, handleConfigSet, handleListProviders } from './commands/config.js';
export { handleSelfUpgrade } from './commands/self-upgrade.js';
export { handleVersions } from './commands/versions.js';