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

// 单实例锁：防止多开实例互相占用 userData/GPUCache（"Unable to move the cache 0x5" 的诱因之一），
// 重复启动时聚焦已有窗口而非新建实例
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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

// ====== GPU 启动失败自动回退：无 GPU / 远程会话语境下自动以 --disable-gpu 重启一次 ======
function relaunchedWithoutGpu() { return process.argv.includes('--disable-gpu'); }
app.on('child-process-gone', (event, details) => {
  if (!details || details.type !== 'GPU') return;
  writeLog('warn', '[GPU 回退] GPU 进程异常: reason=' + (details.reason || 'unknown') + ' exitCode=' + (details.exitCode ?? '-'));
  if (relaunchedWithoutGpu()) {
    writeLog('warn', '[GPU 回退] 已处于 --disable-gpu 模式，不再重启；若仍失败说明该环境不支持硬件加速');
    return;
  }
  writeLog('info', '[GPU 回退] 检测到 GPU 进程不可用，自动以 --disable-gpu 重启应用（一次，防重入）');
  app.relaunch({ args: process.argv.slice(1).concat('--disable-gpu') });
  app.exit(0);
});

app.on('web-contents-created', (event, contents) => {
  contents.on('console-message', (event, level, message, line, sourceId) => {
    const levelNames = ['verbose', 'info', 'warning', 'error'];
    writeLog('debug', `[渲染进程] ${levelNames[level] || level}: ${message} (源: ${sourceId}:${line})`);
  });

  // 导航防护：主窗口与 webview 只允许本应用页面（file:// 本目录 index.html）或本地 DSH 页面（127.0.0.1/localhost），
  // 阻止 XSS 后 location 跳转到远程页面把完整 dshManager preload 桥交给攻击者
  contents.on('will-navigate', (navEvent, url) => {
    try {
      const parsed = new URL(url);
      const isSelf = parsed.protocol === 'file:' && parsed.pathname.replace(/\\/g, '/').endsWith('/src/index.html');
      const isLocalDsh = ['http:', 'https:'].includes(parsed.protocol) &&
        ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
      if (isSelf || isLocalDsh) return;
    } catch { /* URL 解析失败按拒绝处理 */ }
    navEvent.preventDefault();
    writeLog('warn', '[导航防护] 已阻止导航到非白名单地址: ' + url);
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

  // 内置内容自动安装（首次运行 + 每次启动校验，幂等）：
  // 把随包内置的技能同步到 ~/.dsh/skills，并自动安装内置插件（能力路由 / dsh-skills）。
  // 异步执行、不阻塞窗口创建；失败仅记日志，不影响应用启动。
  ensureBundledContentOnStartup().catch((err) => {
    writeLog('warn', '内置内容自动安装异常: ' + (err?.message || err));
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

/** 启动时执行内置技能/插件自动安装（幂等，日志记录结果） */
async function ensureBundledContentOnStartup() {
  try {
    const core = await import('../packages/core/src/index.js');
    const result = await core.ensureBundledContent({ profile: 'web' });
    const skills = result.skills || {};
    if (skills.source) {
      const changed = (skills.results || []).filter(r => r.action === 'installed' || r.action === 'updated');
      writeLog('info', `内置技能同步完成: 来源 ${skills.source}，新装/更新 ${changed.length} 个，跳过 ${skills.skipped || 0} 个`
        + (changed.length ? '（' + changed.map(r => r.name).join(', ') + '）' : ''));
    } else {
      writeLog('warn', '内置技能同步跳过: ' + (skills.error || '未找到内置技能源'));
    }
    const plugins = result.plugins;
    if (plugins) {
      if (plugins.capabilityRouter) {
        writeLog('info', '内置插件[能力路由]: ' + (plugins.capabilityRouter.already ? '已安装，跳过' : (plugins.capabilityRouter.success ? '自动安装完成' : '安装失败: ' + (plugins.capabilityRouter.error || ''))));
      }
      if (plugins.dshSkills) {
        writeLog('info', '内置插件[dsh-skills]: ' + (plugins.dshSkills.already ? '已安装，跳过' : (plugins.dshSkills.success ? '自动安装完成' : '安装失败: ' + (plugins.dshSkills.error || ''))));
      }
    }
  } catch (e) {
    writeLog('warn', '内置内容自动安装失败: ' + (e?.message || e));
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export function getMainWindow() { return mainWindow; }