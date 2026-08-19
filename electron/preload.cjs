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
  installDSH: (version, registry, tool) => ipcRenderer.invoke('dsh:install', version, registry, tool),
  uninstallDSH: () => ipcRenderer.invoke('dsh:uninstall'),
  checkDSHUpdate: () => ipcRenderer.invoke('dsh:check-update'),
  getDSHVersions: () => ipcRenderer.invoke('dsh:get-versions'),
  switchDSHVersion: (version) => ipcRenderer.invoke('dsh:switch-version', version),
  doctorCheck: () => ipcRenderer.invoke('dsh:doctor'),
  startDSH: () => ipcRenderer.invoke('dsh:start'),
  onDSHStartError: (callback) => {
    ipcRenderer.on('dsh:start-error', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:start-error');
  },
  stopDSH: () => ipcRenderer.invoke('dsh:stop'),

  // ====== 数据管理 ======
  getDSHStorageInfo: () => ipcRenderer.invoke('dsh:storage-info'),
  cleanDSHData: (opts) => ipcRenderer.invoke('dsh:clean-data', opts),

  // ====== 进程管理 ======
  getDSHProcessInfo: () => ipcRenderer.invoke('dsh:process-info'),

  // ====== Profile 管理 ======
  listProfiles: () => ipcRenderer.invoke('dsh:list-profiles'),
  createProfile: (name) => ipcRenderer.invoke('dsh:create-profile', name),
  backupProfile: (name) => ipcRenderer.invoke('dsh:backup-profile', name),

  // ====== 插件市场 ======
  searchPlugins: (query, page) => ipcRenderer.invoke('marketplace:search', query, page),
  getPluginDetails: (fullName) => ipcRenderer.invoke('marketplace:plugin-details', fullName),
  installPlugin: (source) => ipcRenderer.invoke('marketplace:install-plugin', source),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke('marketplace:uninstall-plugin', pluginId),
  getLocalPlugins: (forceRefresh = false) => ipcRenderer.invoke('marketplace:local-plugins', forceRefresh),
  getComposedPlugins: (profile = 'web', forceRefresh = false) => ipcRenderer.invoke('marketplace:composed-plugins', profile, forceRefresh),
  diagnoseInvalidPlugins: (profile = 'web') => ipcRenderer.invoke('marketplace:diagnose-plugins', profile),
  fixInvalidPlugins: (profile = 'web') => ipcRenderer.invoke('marketplace:fix-plugins', profile),
  checkPluginUpdates: () => ipcRenderer.invoke('marketplace:check-updates'),
  enablePlugin: (pluginId) => ipcRenderer.invoke('marketplace:enable-plugin', pluginId),
  disablePlugin: (pluginId) => ipcRenderer.invoke('marketplace:disable-plugin', pluginId),
  batchInstallPlugins: (sources) => ipcRenderer.invoke('marketplace:batch-install', sources),
  pickPluginDir: () => ipcRenderer.invoke('marketplace:pick-plugin-dir'),
  selectSkillDirectory: () => ipcRenderer.invoke('skills:pick-dir'),

  // ====== 配置管理 ======
  getConfig: (key) => ipcRenderer.invoke('config:get', key),
  setConfig: (key, value) => ipcRenderer.invoke('config:set', key, value),
  deleteConfig: (key) => ipcRenderer.invoke('config:delete', key),
  getAllConfig: () => ipcRenderer.invoke('config:get-all'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  getLLMProviders: () => ipcRenderer.invoke('config:llm-providers'),
  setReplyLanguage: (lang) => ipcRenderer.invoke('dsh:set-reply-language', lang),
  getReplyLanguage: () => ipcRenderer.invoke('dsh:get-reply-language'),
  getAgentPresets: () => ipcRenderer.invoke('config:agent-presets'),
  updateLLMProvider: (name, providerConfig) => ipcRenderer.invoke('config:update-llm-provider', name, providerConfig),
  deleteLLMProvider: (name) => ipcRenderer.invoke('config:delete-llm-provider', name),
  fetchLLMModels: (provider, baseUrl, apiKey) => ipcRenderer.invoke('llm:fetch-models', provider, baseUrl, apiKey),

  // ====== MCP 服务端管理 ======
  mcpList: (profile) => ipcRenderer.invoke('mcp:list', profile),
  mcpGet: (serverName, profile) => ipcRenderer.invoke('mcp:get', serverName, profile),
  mcpAdd: (config) => ipcRenderer.invoke('mcp:add', config),
  mcpRemove: (serverName, profile) => ipcRenderer.invoke('mcp:remove', serverName, profile),
  // ====== MCP 增强 ======
  mcpImportJson: (jsonText, profile) => ipcRenderer.invoke('mcp:import-json', jsonText, profile),
  mcpApplyImport: (servers, options) => ipcRenderer.invoke('mcp:apply-import', servers, options),
  mcpExportJson: (profile) => ipcRenderer.invoke('mcp:export-json', profile),
  mcpBackup: (profile) => ipcRenderer.invoke('mcp:backup', profile),
  mcpListBackups: (profile) => ipcRenderer.invoke('mcp:list-backups', profile),

  // ====== 技能管理 ======
  skillsList: (filter) => ipcRenderer.invoke('skills:list', filter),
  skillsGet: (name) => ipcRenderer.invoke('skills:get', name),
  skillsCreate: (input) => ipcRenderer.invoke('skills:create', input),
  skillsUpdate: (name, patch) => ipcRenderer.invoke('skills:update', name, patch),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsToggle: (name, kind, value) => ipcRenderer.invoke('skills:toggle', name, kind, value),
  skillsImportGitHub: (url, options) => ipcRenderer.invoke('skills:import-github', url, options),
  skillsImportDir: (srcPath, options) => ipcRenderer.invoke('skills:import-dir', srcPath, options),
  skillsStats: () => ipcRenderer.invoke('skills:stats'),


  // ====== 系统 ======
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  checkPnpm: () => ipcRenderer.invoke('app:check-pnpm'),
  installPnpm: () => ipcRenderer.invoke('app:install-pnpm'),
  checkEnvironment: () => ipcRenderer.invoke('app:check-env'),
  installNodejs: () => ipcRenderer.invoke('app:install-nodejs'),
  installGit: () => ipcRenderer.invoke('app:install-git'),

  // ====== 事件监听 ======
  onInstallProgress: (callback) => {
    ipcRenderer.on('dsh:install-progress', (_, data) => callback(data));
  },
  onPluginInstallProgress: (callback) => {
    ipcRenderer.on('plugin-install-progress', (_, data) => callback(data));
  },
  onEnvInstallProgress: (callback) => {
    ipcRenderer.on('env-install-progress', (_, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // ====== 应用更新 ======
  checkAppUpdate: () => ipcRenderer.invoke('app:check-app-update'),

  // ====== 调试日志 ======
  getDebugLog: () => ipcRenderer.invoke('debug:get-log'),
  clearDebugLog: () => ipcRenderer.invoke('debug:clear-log'),
  getDebugLogPath: () => ipcRenderer.invoke('debug:get-log-path'),
  isDebugEnabled: () => ipcRenderer.invoke('debug:is-enabled'),
  writeDebugLog: (level, message) => ipcRenderer.invoke('debug:write-log', level, message),
});