/**
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * DSH Manager - Constants Module
 * 集中管理魔法字符串：页面 ID、存储键、状态类名、快捷键映射等
 */
'use strict';

/** 页面 ID（与 index.html 中 page-{id} 对应） */
const PAGE_IDS = {
  DASHBOARD: 'dashboard',
  INSTALL: 'install',
  PLUGINS: 'plugins',
  SKILLS: 'skills',
  VERSIONS: 'versions',
  SETTINGS: 'settings',
  PROMPTS: 'prompts',
  ABOUT: 'about',
};

/** 导航顺序（Ctrl+1~8 快捷键与侧边栏顺序一致） */
const PAGE_ORDER = [
  PAGE_IDS.DASHBOARD,
  PAGE_IDS.INSTALL,
  PAGE_IDS.PLUGINS,
  PAGE_IDS.SKILLS,
  PAGE_IDS.VERSIONS,
  PAGE_IDS.SETTINGS,
  PAGE_IDS.PROMPTS,
  PAGE_IDS.ABOUT,
];

/** localStorage 存储键 */
const STORAGE_KEYS = {
  THEME: 'dshm-theme',
  SIDEBAR_COLLAPSED: 'dshm-sidebar-collapsed',
  UPDATE_REMIND: 'dsh-update-remind',
};

/** 主题选项 */
const THEME_OPTIONS = ['system', 'light', 'dark'];

/** 状态指示类名（sidebar 状态点） */
const STATUS_CLASSES = {
  OK: 'status-ok',
  ERROR: 'status-error',
  ONLINE: 'status-online',
  DETECTING: 'status-detecting',
  UNKNOWN: 'status-unknown',
};

/** 设置页签 ID */
const SETTINGS_TABS = {
  MANAGER: 'manager',
  LLM: 'llm',
  YAML: 'yaml',
  PRESETS: 'presets',
  SYSTEM: 'system',
};

/** 市场分类 */
const MARKET_CATEGORIES = {
  ALL: 'all',
  RECOMMENDED: 'recommended',
  UI: 'ui',
  TOOL: 'tool',
  WRITING: 'writing',
  SKILL: 'skill',
};

/** 市场命名空间 */
const MARKET_SCOPES = {
  ALL: 'all',
  DSH_OFFICIAL: '@deepseek-ai/',
  COMMUNITY: '@linxin666/',
  OTHER: 'other',
};

/** IPC 事件名（主进程 → 渲染进程推送） */
const IPC_EVENTS = {
  DSH_START_ERROR: 'dsh:start-error',
  ENV_INSTALL_PROGRESS: 'dsh:env-install-progress',
  PLUGIN_INSTALL_PROGRESS: 'dsh:plugin-install-progress',
  SWITCH_VERSION_PROGRESS: 'dsh:switch-version-progress',
  MAXIMIZE_CHANGE: 'window-maximize-change',
};

/** 默认 DSH Web 地址 */
const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';

// 暴露到 window（与其它模块保持一致的模式）
window.PAGE_IDS = PAGE_IDS;
window.PAGE_ORDER = PAGE_ORDER;
window.STORAGE_KEYS = STORAGE_KEYS;
window.THEME_OPTIONS = THEME_OPTIONS;
window.STATUS_CLASSES = STATUS_CLASSES;
window.SETTINGS_TABS = SETTINGS_TABS;
window.MARKET_CATEGORIES = MARKET_CATEGORIES;
window.MARKET_SCOPES = MARKET_SCOPES;
window.IPC_EVENTS = IPC_EVENTS;
window.DEFAULT_DSH_URL = DEFAULT_DSH_URL;
