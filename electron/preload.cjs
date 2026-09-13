/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
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
  getDSHDetectionDetail: () => ipcRenderer.invoke('dsh:get-detection-detail'),
  installDSH: (version, registry, tool) => ipcRenderer.invoke('dsh:install', version, registry, tool),
  uninstallDSH: () => ipcRenderer.invoke('dsh:uninstall'),
  checkDSHUpdate: () => ipcRenderer.invoke('dsh:check-update'),
  getDSHVersions: () => ipcRenderer.invoke('dsh:get-versions'),
  switchDSHVersion: (version) => ipcRenderer.invoke('dsh:switch-version', version),
  doctorCheck: () => ipcRenderer.invoke('dsh:doctor'),
  startDSH: () => ipcRenderer.invoke('dsh:start'),
  /// 重启 DSH Web：先停后启（安装新 bundle 后需重启生效）
  restartDSH: () => ipcRenderer.invoke('dsh:restart'),
  onDSHStartError: (callback) => {
    ipcRenderer.on('dsh:start-error', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:start-error');
  },
  onDSHWebUrlCaptured: (callback) => {
    ipcRenderer.on('dsh:web-url-captured', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:web-url-captured');
  },
  stopDSH: () => ipcRenderer.invoke('dsh:stop'),
  diagnoseDSH: (port) => ipcRenderer.invoke('dsh:diagnose', port),
  checkDSHPort: (port) => ipcRenderer.invoke('dsh:check-port', port),
  getDSHActualPort: () => ipcRenderer.invoke('dsh:get-actual-port'),
  getDSHWebUrl: () => ipcRenderer.invoke('dsh:get-web-url'),
  listDSHInstances: () => ipcRenderer.invoke('dsh:list-instances'),
  stopDSHInstance: (port) => ipcRenderer.invoke('dsh:stop-instance', port),
  fixAndRestartDSH: (moduleIds) => ipcRenderer.invoke('dsh:fix-and-restart', moduleIds),
  searchGitHubSkills: (query, page) => ipcRenderer.invoke('skills:search-github', query, page),

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
  updatePlugin: (pluginId, options) => ipcRenderer.invoke('marketplace:update-plugin', pluginId, options || {}),
  cleanupGhostPlugins: () => ipcRenderer.invoke('marketplace:cleanup-ghosts'),
  enablePlugin: (pluginId) => ipcRenderer.invoke('marketplace:enable-plugin', pluginId),
  disablePlugin: (pluginId) => ipcRenderer.invoke('marketplace:disable-plugin', pluginId),
  batchInstallPlugins: (sources) => ipcRenderer.invoke('marketplace:batch-install', sources),
  pickPluginDir: () => ipcRenderer.invoke('marketplace:pick-plugin-dir'),
  selectSkillDirectory: () => ipcRenderer.invoke('skills:pick-dir'),

  // ====== 插件崩溃自动隔离（quarantine） ======
  quarantineOverview: () => ipcRenderer.invoke('quarantine:overview'),
  quarantineClearHistory: () => ipcRenderer.invoke('quarantine:clear-history'),
  quarantineRecoverPlugin: (pluginId) => ipcRenderer.invoke('quarantine:recover-plugin', pluginId),
  onPluginQuarantineEvent: (callback) => {
    ipcRenderer.on('dsh:plugin-quarantine-event', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:plugin-quarantine-event');
  },

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
  listAgentPresetDirs: () => ipcRenderer.invoke('agent-presets:list-dirs'),
  getAgentPresetDetail: (id) => ipcRenderer.invoke('agent-presets:get-detail', id),
  setDefaultAgentPreset: (id) => ipcRenderer.invoke('agent-presets:set-default', id),
  getBundledContentStatus: () => ipcRenderer.invoke('bundled-content:status'),
  syncBundledSkills: () => ipcRenderer.invoke('bundled-content:sync-skills'),
  installBundledPlugins: (profile) => ipcRenderer.invoke('bundled-content:install-plugins', profile),
  updateLLMProvider: (name, providerConfig, adapter) => ipcRenderer.invoke('config:update-llm-provider', name, providerConfig, adapter),
  deleteLLMProvider: (name) => ipcRenderer.invoke('config:delete-llm-provider', name),
  fetchLLMModels: (provider, baseUrl, apiKey, credRef) => ipcRenderer.invoke('llm:fetch-models', provider, baseUrl, apiKey, credRef || ''),

  // ====== LLM 能力路由（按能力自动切换模型） ======
  getLLMRouting: () => ipcRenderer.invoke('llm-routing:get'),
  saveLLMRouting: (routing) => ipcRenderer.invoke('llm-routing:save', routing),
  listCapabilityModels: () => ipcRenderer.invoke('llm-routing:models'),
  applyDefaultModel: (capability) => ipcRenderer.invoke('llm-routing:apply-default', capability),
  resolveCapability: (capability) => ipcRenderer.invoke('llm-routing:resolve', capability),
  getCapabilityRouterStatus: (profile) => ipcRenderer.invoke('llm-routing:plugin-status', profile),
  installCapabilityRouter: (profile) => ipcRenderer.invoke('llm-routing:plugin-install', profile),
  uninstallCapabilityRouter: (profile) => ipcRenderer.invoke('llm-routing:plugin-uninstall', profile),
  readCapabilityRouterLog: () => ipcRenderer.invoke('llm-routing:read-log'),

  // ====== AI 生图（直接调 OpenAI 兼容 /images/generations，保存到本地） ======
  imagegenGenerate: (opts) => ipcRenderer.invoke('imagegen:generate', opts),
  imagegenGetDir: () => ipcRenderer.invoke('imagegen:image-dir'),
  imagegenOpenFolder: () => ipcRenderer.invoke('imagegen:open-folder'),
  imagegenReadImage: (filePath) => ipcRenderer.invoke('imagegen:read-image', filePath),

  // ====== 配置备份/还原 ======
  createConfigBackup: (reason) => ipcRenderer.invoke('config:create-backup', reason),
  listConfigBackups: () => ipcRenderer.invoke('config:list-backups'),
  restoreConfigBackup: (nameOrIndex) => ipcRenderer.invoke('config:restore-backup', nameOrIndex),
  validateConfig: () => ipcRenderer.invoke('config:validate'),

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
  mcpSearchMarket: (query, category) => ipcRenderer.invoke('mcp:search-market', query, category),

  // ====== 技能管理 ======
  skillsList: (filter) => ipcRenderer.invoke('skills:list', filter),
  skillsGet: (name) => ipcRenderer.invoke('skills:get', name),
  skillsCreate: (input) => ipcRenderer.invoke('skills:create', input),
  skillsUpdate: (name, patch) => ipcRenderer.invoke('skills:update', name, patch),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsToggle: (name, kind, value) => ipcRenderer.invoke('skills:toggle', name, kind, value),
  skillsImportGitHub: (url, options) => ipcRenderer.invoke('skills:import-github', url, options),
  skillsImportDir: (srcPath, options) => ipcRenderer.invoke('skills:import-dir', srcPath, options),
  skillsListPluginSkills: () => ipcRenderer.invoke('skills:list-plugin-skills'),
  skillsPluginSyncStatus: () => ipcRenderer.invoke('skills:plugin-sync-status'),
  skillsImportPluginSkill: (plugin, options) => ipcRenderer.invoke('skills:import-plugin-skill', plugin, options),
  skillsStats: () => ipcRenderer.invoke('skills:stats'),

  // ====== 总提示词管理 ======
  promptList: (filter) => ipcRenderer.invoke('prompts:list', filter),
  promptGet: (id) => ipcRenderer.invoke('prompts:get', id),
  promptCreate: (input) => ipcRenderer.invoke('prompts:create', input),
  promptUpdate: (id, patch) => ipcRenderer.invoke('prompts:update', id, patch),
  promptDelete: (id) => ipcRenderer.invoke('prompts:delete', id),
  promptToggle: (id, enabled) => ipcRenderer.invoke('prompts:toggle', id, enabled),
  promptRender: (options) => ipcRenderer.invoke('prompts:render', options),
  promptStats: () => ipcRenderer.invoke('prompts:stats'),


  // ====== 系统 ======
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  checkPnpm: () => ipcRenderer.invoke('app:check-pnpm'),
  installPnpm: () => ipcRenderer.invoke('app:install-pnpm'),
  checkEnvironment: () => ipcRenderer.invoke('app:check-env'),
  installNodejs: () => ipcRenderer.invoke('app:install-nodejs'),
  installNodejsPortable: (opts) => ipcRenderer.invoke('app:install-nodejs-portable', opts),
  uninstallNodejsPortable: () => ipcRenderer.invoke('app:uninstall-nodejs-portable'),
  getPortableNode: () => ipcRenderer.invoke('app:get-portable-node'),
  installGit: () => ipcRenderer.invoke('app:install-git'),

  // ====== 事件监听 ======
  onInstallProgress: (callback) => {
    ipcRenderer.on('dsh:install-progress', (_, data) => callback(data));
  },
  onSwitchVersionProgress: (callback) => {
    ipcRenderer.on('dsh:switch-version-progress', (_, data) => callback(data));
  },
  onPluginInstallProgress: (callback) => {
    ipcRenderer.on('dsh:plugin-install-progress', (_, data) => callback(data));
  },
  onEnvInstallProgress: (callback) => {
    ipcRenderer.on('dsh:env-install-progress', (_, data) => callback(data));
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

  // ====== 依赖完整性检查与修复 ======
  checkDepsIntegrity: (profile, options) => ipcRenderer.invoke('deps:check-integrity', profile, options),
  repairDeps: (profile, options) => ipcRenderer.invoke('deps:repair', profile, options),
  repairAllDeps: (options) => ipcRenderer.invoke('deps:repair-all', options),
  getDepsHealth: (profile) => ipcRenderer.invoke('deps:health', profile),
  classifyPackage: (name) => ipcRenderer.invoke('deps:classify', name),
  
  // ====== 模型配置中心（Model Config Center，类似 cc-switch） ======
  listModelProfiles: () => ipcRenderer.invoke('mcc:list-profiles'),
  getModelProfile: (id) => ipcRenderer.invoke('mcc:get-profile', id),
  saveModelProfile: (input) => ipcRenderer.invoke('mcc:save-profile', input),
  testModelConnection: (input) => ipcRenderer.invoke('mcc:test-connection', input),
  deleteModelProfile: (id) => ipcRenderer.invoke('mcc:delete-profile', id),
  listModelConfigTools: () => ipcRenderer.invoke('mcc:list-tools'),
  applyModelProfile: (profileId, toolIds) => ipcRenderer.invoke('mcc:apply', profileId, toolIds),
  revertModelConfigTool: (toolId) => ipcRenderer.invoke('mcc:revert', toolId),
  listModelConfigBackups: (toolId) => ipcRenderer.invoke('mcc:list-backups', toolId),
  exportModelProfiles: () => ipcRenderer.invoke('mcc:export'),
  importModelProfiles: (jsonText) => ipcRenderer.invoke('mcc:import', jsonText),

  // ====== 剪贴板 ======
  copyToClipboard: (text) => ipcRenderer.invoke('app:copy-to-clipboard', text),
});