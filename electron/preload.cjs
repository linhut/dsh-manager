/**
 * DSH Manager - 预加载脚本
 * 
 * 使用 CommonJS 格式（.js 文件但使用 require），确保在 Electron 打包后
 * 的 asar 环境中可靠加载。package.json 的 "type": "module" 不影响此文件。
 * 
 * 通过 contextBridge 安全地暴露 API 给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 暴露给渲染进程的 API
 */
contextBridge.exposeInMainWorld('dshManager', {
  // ====== 窗口控制 ======
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window-maximize-change', (_, isMaximized) => callback(isMaximized));
  },

  // ====== DSH 管理 ======
  getDSHInfo: () => ipcRenderer.invoke('dsh:get-info'),
  installDSH: (version, registry) => ipcRenderer.invoke('dsh:install', version, registry),
  uninstallDSH: () => ipcRenderer.invoke('dsh:uninstall'),
  upgradeDSH: () => ipcRenderer.invoke('dsh:upgrade'),
  checkDSHUpdate: () => ipcRenderer.invoke('dsh:check-update'),
  getDSHVersions: () => ipcRenderer.invoke('dsh:get-versions'),
  doctorCheck: () => ipcRenderer.invoke('dsh:doctor'),
  startDSH: () => ipcRenderer.invoke('dsh:start'),
  stopDSH: () => ipcRenderer.invoke('dsh:stop'),

  // ====== 插件市场 ======
  searchPlugins: (query, page) => ipcRenderer.invoke('marketplace:search', query, page),
  getPluginDetails: (fullName) => ipcRenderer.invoke('marketplace:plugin-details', fullName),
  installPlugin: (source) => ipcRenderer.invoke('marketplace:install-plugin', source),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke('marketplace:uninstall-plugin', pluginId),
  getLocalPlugins: () => ipcRenderer.invoke('marketplace:local-plugins'),
  checkPluginUpdates: () => ipcRenderer.invoke('marketplace:check-updates'),

  // ====== 配置管理 ======
  getConfig: (key) => ipcRenderer.invoke('config:get', key),
  setConfig: (key, value) => ipcRenderer.invoke('config:set', key, value),
  getAllConfig: () => ipcRenderer.invoke('config:get-all'),
  getLLMProviders: () => ipcRenderer.invoke('config:llm-providers'),

  // ====== MCP 服务端管理 ======
  mcpList: (profile) => ipcRenderer.invoke('mcp:list', profile),
  mcpGet: (serverName, profile) => ipcRenderer.invoke('mcp:get', serverName, profile),
  mcpAdd: (config) => ipcRenderer.invoke('mcp:add', config),
  mcpRemove: (serverName, profile) => ipcRenderer.invoke('mcp:remove', serverName, profile),

  // ====== 导航 ======
  onNavigate: (callback) => {
    ipcRenderer.on('navigate', (_, page) => callback(page));
  },

  // ====== 系统 ======
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getPlatform: () => process.platform,
  checkPnpm: () => ipcRenderer.invoke('app:check-pnpm'),

  // ====== 事件监听 ======
  onInstallProgress: (callback) => {
    ipcRenderer.on('dsh:install-progress', (_, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});