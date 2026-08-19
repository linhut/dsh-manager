/**
 * DSH Manager
 * Copyright (c) 2026 linhut (https://github.com/linhut)
 * MIT License
 */

/**
 * DSH Manager - Electron 主进程
 * 
 * 核心流程：安装 DSH → 打开 DSH Web 页面
 * 功能：版本管理、插件管理、配置管理
 */

import { app, BrowserWindow, ipcMain, shell, Menu, dialog, session, nativeTheme, globalShortcut } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { registerIpcHandlers } from './ipc-handlers.js';
import { initDebugLog, writeLog, isDebugEnabled } from './debug-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// 开发调试模式：环境变量 DSH_DEBUG=true 或 --debug 参数
const isDebug = isDev || process.env.DSH_DEBUG === 'true' || process.argv.includes('--debug');
initDebugLog(isDebug);

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
    // 调试模式自动打开 DevTools（可看到 console 输出）
    if (isDebug) {
      writeLog('debug', '调试模式已启用，自动打开 DevTools');
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // F12 快捷键打开 DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
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

// ====== 主进程控制台日志重定向到调试日志文件 ======
const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleError = console.error;
console.log = function(...args) {
  writeLog('info', args.map(a => typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a)).join(' '));
  origConsoleLog.apply(console, args);
};
console.warn = function(...args) {
  writeLog('warn', args.map(a => typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a)).join(' '));
  origConsoleWarn.apply(console, args);
};
console.error = function(...args) {
  writeLog('error', args.map(a => typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a)).join(' '));
  origConsoleError.apply(console, args);
};
writeLog('info', '主进程 console 重定向到调试日志文件完成');
writeLog('info', '启动参数: ' + process.argv.slice(1).join(' '));
writeLog('info', '环境变量 DSH_DEBUG: ' + (process.env.DSH_DEBUG || '未设置'));

// ====== 全局异常处理 ======
process.on('uncaughtException', (error) => {
  writeLog('error', '主进程未捕获异常: ' + (error?.stack || error?.message || error));
});
process.on('unhandledRejection', (reason) => {
  writeLog('error', '主进程未处理 Promise 拒绝: ' + (reason?.stack || reason?.message || reason));
});
app.on('web-contents-created', (event, contents) => {
  contents.on('console-message', (event, level, message, line, sourceId) => {
    const levelNames = ['verbose', 'info', 'warning', 'error'];
    writeLog('debug', `[渲染进程] ${levelNames[level] || level}: ${message} (源: ${sourceId}:${line})`);
  });
});

// ====== 应用生命周期 ======

app.whenReady().then(async () => {
  createAppMenu();
  // 全局 IPC 日志：拦截 ipcMain.handle 包装所有处理器
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    return origHandle(channel, async (event, ...args) => {
      const start = Date.now();
      try {
        const result = await handler(event, ...args);
        const elapsed = Date.now() - start;
        writeLog('debug', `[IPC] ${channel} (${elapsed}ms) OK`);
        return result;
      } catch (error) {
        const elapsed = Date.now() - start;
        writeLog('error', `[IPC] ${channel} (${elapsed}ms) ERROR: ${error?.message || error}`);
        throw error;
      }
    });
  };
  // 注册所有 IPC 处理器（会被上面的包装自动拦截）
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