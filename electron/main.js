/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { app, BrowserWindow, ipcMain, shell, Menu, dialog, session, nativeTheme, globalShortcut } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { registerIpcHandlers } from './ipc-handlers.js';
import { initDebugLog, writeLog, isDebugEnabled } from './debug-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 无 GPU / 远程桌面 / 虚拟机环境下禁用硬件加速，避免 GPU 进程启动失败导致 FATAL 崩溃
app.disableHardwareAcceleration();
if (process.env.DSH_DISABLE_GPU === 'true' || process.argv.includes('--disable-gpu')) {
  app.commandLine.appendSwitch('disable-gpu');
}

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
  const nativeThemeHandler = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(getWindowBackground());
    }
  };
  nativeTheme.on('updated', nativeThemeHandler);
  // 在窗口关闭时移除监听器，避免泄漏
  mainWindow.on('closed', () => nativeTheme.removeListener('updated', nativeThemeHandler));

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

  // 外部链接用浏览器打开（仅允许 http/https/mailto，防止 file://、自定义协议被利用）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return { action: 'deny' };
    } catch {
      return { action: 'deny' };
    }
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

  // 启动预检：凭据文件若仍是旧扁平布局，先迁移为 DSH 新版版本化布局，
  // 避免后续启动 DSH 时因 unknown top-level key 崩溃（表现为「重启 DSH 没生效」）
  try {
    const core = await import('../packages/core/src/index.js');
    const credResult = await new core.DSHConfig().migrateCredentialsToVersioned();
    if (credResult && credResult.migrated) {
      writeLog('info', '启动预检: 已自动迁移凭据文件到版本化布局（备份: ' + credResult.backup + '，迁移 ' + credResult.keys + ' 个密钥）');
    } else if (credResult && credResult.reason === 'already-versioned') {
      writeLog('info', '启动预检: 凭据文件已是最新版版本化布局，无需迁移');
    } else if (credResult && credResult.reason === 'write-error') {
      writeLog('error', '启动预检: 凭据迁移失败（' + (credResult.error || '未知错误') + '），DSH 可能无法启动');
    }
  } catch (preErr) {
    writeLog('warn', '启动预检: 凭据检查异常（不影响应用启动）: ' + preErr.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export function getMainWindow() { return mainWindow; }