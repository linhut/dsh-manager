/**
 * DSH Manager - Electron 主进程
 * 
 * 核心流程：安装 DSH → 打开 DSH Web 页面
 * 功能：版本管理、插件管理、配置管理
 */

import { app, BrowserWindow, ipcMain, shell, Menu, dialog, session, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { registerIpcHandlers } from './ipc-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

let mainWindow = null;
let dshWebView = null;

/**
 * 获取当前主题对应的窗口背景色
 */
function getWindowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#0B0D17' : '#F8FAFC';
}

/**
 * 创建主窗口
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'DSH Manager',
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,  // 允许使用 webview 加载 DSH 页面
    },
    frame: false,
    backgroundColor: getWindowBackground(),
    show: false,
  });

  // 系统主题变化时同步窗口背景色（避免白/黑闪烁）
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(getWindowBackground());
    }
  });

  // 加载管理界面
  mainWindow.loadFile(join(__dirname, '../src/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 外部链接用浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    dshWebView = null;
  });

  // 监听窗口最大化变化
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-maximize-change', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximize-change', false));
}

/**
 * 创建应用菜单
 */
function createAppMenu() {
  const template = [
    {
      label: 'DSH Manager',
      submenu: [
        { label: '关于 DSH Manager', role: 'about' },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'GitHub 仓库', click: () => shell.openExternal('https://github.com/linhut/dsh-manager') },
        { label: '报告问题', click: () => shell.openExternal('https://github.com/linhut/dsh-manager/issues') },
        { type: 'separator' },
        { label: 'DeepSeek Harness 文档', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ====== 应用生命周期 ======

app.whenReady().then(async () => {
  createAppMenu();
  registerIpcHandlers(ipcMain, () => mainWindow);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export function getMainWindow() { return mainWindow; }