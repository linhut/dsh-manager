/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

const { contextBridge, ipcRenderer } = require('electron');

const { unwrap } = require('./contract/envelope.cjs');

/**
 * 统一解包 IPC 结果：
 *   信封通道（app:* 等灰度域）→ 成功返回 data，失败抛出带 code 的 Error；
 *   其余通道原样返回，行为与改造前完全一致。
 */
async function invokeIpc(channel, ...args) {
  return unwrap(await ipcRenderer.invoke(channel, ...args));
}

/**
 * 暴露给渲染进程的 API
 */
contextBridge.exposeInMainWorld('dshManager', {
  // ====== 窗口控制 ======
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => invokeIpc('window-is-maximized'),
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window-maximize-change', (_, isMaximized) => callback(isMaximized));
  },

  // ====== DSH 管理 ======
  getDSHInfo: () => invokeIpc('dsh:get-info'),
  getDSHDetectionDetail: () => invokeIpc('dsh:get-detection-detail'),
  installDSH: (version, registry, tool) => invokeIpc('dsh:install', version, registry, tool),
  uninstallDSH: () => invokeIpc('dsh:uninstall'),
  checkDSHUpdate: () => invokeIpc('dsh:check-update'),
  getDSHVersions: () => invokeIpc('dsh:get-versions'),
  switchDSHVersion: (version) => invokeIpc('dsh:switch-version', version),
  doctorCheck: () => invokeIpc('dsh:doctor'),
  startDSH: () => invokeIpc('dsh:start'),
  /// 重启 DSH Web：先停后启（安装新 bundle 后需重启生效）
  restartDSH: () => invokeIpc('dsh:restart'),
  onDSHStartError: (callback) => {
    ipcRenderer.on('dsh:start-error', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:start-error');
  },
  onDSHWebUrlCaptured: (callback) => {
    ipcRenderer.on('dsh:web-url-captured', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:web-url-captured');
  },
  stopDSH: () => invokeIpc('dsh:stop'),
  diagnoseDSH: (port) => invokeIpc('dsh:diagnose', port),
  checkDSHPort: (port) => invokeIpc('dsh:check-port', port),
  getDSHActualPort: () => invokeIpc('dsh:get-actual-port'),
  getDSHWebUrl: () => invokeIpc('dsh:get-web-url'),
  listDSHInstances: () => invokeIpc('dsh:list-instances'),
  stopDSHInstance: (port) => invokeIpc('dsh:stop-instance', port),
  fixAndRestartDSH: (moduleIds) => invokeIpc('dsh:fix-and-restart', moduleIds),
  searchGitHubSkills: (query, page) => invokeIpc('skills:search-github', query, page),

  // ====== 数据管理 ======
  getDSHStorageInfo: () => invokeIpc('dsh:storage-info'),
  cleanDSHData: (opts) => invokeIpc('dsh:clean-data', opts),

  // ====== 进程管理 ======
  getDSHProcessInfo: () => invokeIpc('dsh:process-info'),

  // ====== Profile 管理 ======
  listProfiles: () => invokeIpc('dsh:list-profiles'),
  createProfile: (name) => invokeIpc('dsh:create-profile', name),
  backupProfile: (name) => invokeIpc('dsh:backup-profile', name),

  // ====== 插件市场 ======
  searchPlugins: (query, page) => invokeIpc('marketplace:search', query, page),
  getPluginDetails: (fullName) => invokeIpc('marketplace:plugin-details', fullName),
  installPlugin: (source) => invokeIpc('marketplace:install-plugin', source),
  uninstallPlugin: (pluginId) => invokeIpc('marketplace:uninstall-plugin', pluginId),
  getLocalPlugins: (forceRefresh = false) => invokeIpc('marketplace:local-plugins', forceRefresh),
  getComposedPlugins: (profile = 'web', forceRefresh = false) => invokeIpc('marketplace:composed-plugins', profile, forceRefresh),
  diagnoseInvalidPlugins: (profile = 'web') => invokeIpc('marketplace:diagnose-plugins', profile),
  fixInvalidPlugins: (profile = 'web') => invokeIpc('marketplace:fix-plugins', profile),
  checkPluginUpdates: () => invokeIpc('marketplace:check-updates'),
  updatePlugin: (pluginId, options) => invokeIpc('marketplace:update-plugin', pluginId, options || {}),
  cleanupGhostPlugins: () => invokeIpc('marketplace:cleanup-ghosts'),
  enablePlugin: (pluginId) => invokeIpc('marketplace:enable-plugin', pluginId),
  disablePlugin: (pluginId) => invokeIpc('marketplace:disable-plugin', pluginId),
  batchInstallPlugins: (sources) => invokeIpc('marketplace:batch-install', sources),
  pickPluginDir: () => invokeIpc('marketplace:pick-plugin-dir'),
  selectSkillDirectory: () => invokeIpc('skills:pick-dir'),

  // ====== 插件崩溃自动隔离（quarantine） ======
  quarantineOverview: () => invokeIpc('quarantine:overview'),
  quarantineClearHistory: () => invokeIpc('quarantine:clear-history'),
  quarantineRecoverPlugin: (pluginId) => invokeIpc('quarantine:recover-plugin', pluginId),
  onPluginQuarantineEvent: (callback) => {
    ipcRenderer.on('dsh:plugin-quarantine-event', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dsh:plugin-quarantine-event');
  },

  // ====== 配置管理 ======
  getConfig: (key) => invokeIpc('config:get', key),
  setConfig: (key, value) => invokeIpc('config:set', key, value),
  deleteConfig: (key) => invokeIpc('config:delete', key),
  getAllConfig: () => invokeIpc('config:get-all'),
  writeConfig: (config) => invokeIpc('config:write', config),
  getLLMProviders: () => invokeIpc('config:llm-providers'),
  setReplyLanguage: (lang) => invokeIpc('dsh:set-reply-language', lang),
  getReplyLanguage: () => invokeIpc('dsh:get-reply-language'),
  getAgentPresets: () => invokeIpc('config:agent-presets'),
  listAgentPresetDirs: () => invokeIpc('agent-presets:list-dirs'),
  getAgentPresetDetail: (id) => invokeIpc('agent-presets:get-detail', id),
  setDefaultAgentPreset: (id) => invokeIpc('agent-presets:set-default', id),
  getBundledContentStatus: () => invokeIpc('bundled-content:status'),
  syncBundledSkills: () => invokeIpc('bundled-content:sync-skills'),
  installBundledPlugins: (profile) => invokeIpc('bundled-content:install-plugins', profile),
  updateLLMProvider: (name, providerConfig, adapter) => invokeIpc('config:update-llm-provider', name, providerConfig, adapter),
  deleteLLMProvider: (name) => invokeIpc('config:delete-llm-provider', name),
  fetchLLMModels: (provider, baseUrl, apiKey, credRef) => invokeIpc('llm:fetch-models', provider, baseUrl, apiKey, credRef || ''),

  // ====== LLM 能力路由（按能力自动切换模型） ======
  getLLMRouting: () => invokeIpc('llm-routing:get'),
  saveLLMRouting: (routing) => invokeIpc('llm-routing:save', routing),
  listCapabilityModels: () => invokeIpc('llm-routing:models'),
  applyDefaultModel: (capability) => invokeIpc('llm-routing:apply-default', capability),
  resolveCapability: (capability) => invokeIpc('llm-routing:resolve', capability),
  getCapabilityRouterStatus: (profile) => invokeIpc('llm-routing:plugin-status', profile),
  installCapabilityRouter: (profile) => invokeIpc('llm-routing:plugin-install', profile),
  uninstallCapabilityRouter: (profile) => invokeIpc('llm-routing:plugin-uninstall', profile),
  readCapabilityRouterLog: () => invokeIpc('llm-routing:read-log'),

  // ====== 电脑控制（Computer Use，DSH 官方 experimental 能力） ======
  computerUseGetState: (profile = 'web') => invokeIpc('computer-use:get-state', profile),
  computerUseInstall: (profile = 'web') => invokeIpc('computer-use:install', profile),
  computerUseSetEnabled: (profile = 'web', enabled) => invokeIpc('computer-use:set-enabled', profile, !!enabled),
  computerUseUninstall: (profile = 'web') => invokeIpc('computer-use:uninstall', profile),
  onComputerUseProgress: (callback) => {
    ipcRenderer.on('computer-use:progress', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('computer-use:progress');
  },

  // ====== AI 生图（直接调 OpenAI 兼容 /images/generations，保存到本地） ======
  imagegenGenerate: (opts) => invokeIpc('imagegen:generate', opts),
  imagegenGetDir: () => invokeIpc('imagegen:image-dir'),
  imagegenOpenFolder: () => invokeIpc('imagegen:open-folder'),
  imagegenReadImage: (filePath) => invokeIpc('imagegen:read-image', filePath),

  // ====== 配置备份/还原 ======
  createConfigBackup: (reason) => invokeIpc('config:create-backup', reason),
  listConfigBackups: () => invokeIpc('config:list-backups'),
  restoreConfigBackup: (nameOrIndex) => invokeIpc('config:restore-backup', nameOrIndex),
  validateConfig: () => invokeIpc('config:validate'),

  // ====== MCP 服务端管理 ======
  mcpList: (profile) => invokeIpc('mcp:list', profile),
  mcpGet: (serverName, profile) => invokeIpc('mcp:get', serverName, profile),
  mcpAdd: (config) => invokeIpc('mcp:add', config),
  mcpRemove: (serverName, profile) => invokeIpc('mcp:remove', serverName, profile),
  // ====== MCP 增强 ======
  mcpImportJson: (jsonText, profile) => invokeIpc('mcp:import-json', jsonText, profile),
  mcpApplyImport: (servers, options) => invokeIpc('mcp:apply-import', servers, options),
  mcpExportJson: (profile) => invokeIpc('mcp:export-json', profile),
  mcpBackup: (profile) => invokeIpc('mcp:backup', profile),
  mcpListBackups: (profile) => invokeIpc('mcp:list-backups', profile),
  mcpSearchMarket: (query, category) => invokeIpc('mcp:search-market', query, category),

  // ====== 技能管理 ======
  skillsList: (filter) => invokeIpc('skills:list', filter),
  skillsGet: (name) => invokeIpc('skills:get', name),
  skillsCreate: (input) => invokeIpc('skills:create', input),
  skillsUpdate: (name, patch) => invokeIpc('skills:update', name, patch),
  skillsDelete: (name) => invokeIpc('skills:delete', name),
  skillsToggle: (name, kind, value) => invokeIpc('skills:toggle', name, kind, value),
  skillsImportGitHub: (url, options) => invokeIpc('skills:import-github', url, options),
  skillsImportDir: (srcPath, options) => invokeIpc('skills:import-dir', srcPath, options),
  skillsListPluginSkills: () => invokeIpc('skills:list-plugin-skills'),
  skillsPluginSyncStatus: () => invokeIpc('skills:plugin-sync-status'),
  skillsImportPluginSkill: (plugin, options) => invokeIpc('skills:import-plugin-skill', plugin, options),
  skillsStats: () => invokeIpc('skills:stats'),

  // ====== 总提示词管理 ======
  promptList: (filter) => invokeIpc('prompts:list', filter),
  promptGet: (id) => invokeIpc('prompts:get', id),
  promptCreate: (input) => invokeIpc('prompts:create', input),
  promptUpdate: (id, patch) => invokeIpc('prompts:update', id, patch),
  promptDelete: (id) => invokeIpc('prompts:delete', id),
  promptToggle: (id, enabled) => invokeIpc('prompts:toggle', id, enabled),
  promptRender: (options) => invokeIpc('prompts:render', options),
  promptStats: () => invokeIpc('prompts:stats'),


  // ====== 系统 ======
  openExternal: (url) => invokeIpc('shell:open-external', url),
  getAppVersion: () => invokeIpc('app:get-version'),
  checkPnpm: () => invokeIpc('app:check-pnpm'),
  installPnpm: () => invokeIpc('app:install-pnpm'),
  checkEnvironment: () => invokeIpc('app:check-env'),
  installNodejs: () => invokeIpc('app:install-nodejs'),
  installNodejsPortable: (opts) => invokeIpc('app:install-nodejs-portable', opts),
  uninstallNodejsPortable: () => invokeIpc('app:uninstall-nodejs-portable'),
  getPortableNode: () => invokeIpc('app:get-portable-node'),
  installGit: () => invokeIpc('app:install-git'),

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
  checkAppUpdate: () => invokeIpc('app:check-app-update'),

  // ====== 调试日志 ======
  getDebugLog: () => invokeIpc('debug:get-log'),
  clearDebugLog: () => invokeIpc('debug:clear-log'),
  getDebugLogPath: () => invokeIpc('debug:get-log-path'),
  isDebugEnabled: () => invokeIpc('debug:is-enabled'),
  writeDebugLog: (level, message) => invokeIpc('debug:write-log', level, message),

  // ====== 依赖完整性检查与修复 ======
  checkDepsIntegrity: (profile, options) => invokeIpc('deps:check-integrity', profile, options),
  repairDeps: (profile, options) => invokeIpc('deps:repair', profile, options),
  repairAllDeps: (options) => invokeIpc('deps:repair-all', options),
  getDepsHealth: (profile) => invokeIpc('deps:health', profile),
  classifyPackage: (name) => invokeIpc('deps:classify', name),
  
  // ====== 模型配置中心（Model Config Center，类似 cc-switch） ======
  listModelProfiles: () => invokeIpc('mcc:list-profiles'),
  getModelProfile: (id) => invokeIpc('mcc:get-profile', id),
  saveModelProfile: (input) => invokeIpc('mcc:save-profile', input),
  testModelConnection: (input) => invokeIpc('mcc:test-connection', input),
  deleteModelProfile: (id) => invokeIpc('mcc:delete-profile', id),
  listModelConfigTools: () => invokeIpc('mcc:list-tools'),
  applyModelProfile: (profileId, toolIds) => invokeIpc('mcc:apply', profileId, toolIds),
  revertModelConfigTool: (toolId) => invokeIpc('mcc:revert', toolId),
  listModelConfigBackups: (toolId) => invokeIpc('mcc:list-backups', toolId),
  exportModelProfiles: () => invokeIpc('mcc:export'),
  importModelProfiles: (jsonText) => invokeIpc('mcc:import', jsonText),

  // ====== 剪贴板 ======
  copyToClipboard: (text) => invokeIpc('app:copy-to-clipboard', text),
});