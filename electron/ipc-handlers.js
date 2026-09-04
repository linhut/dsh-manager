/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { shell, BrowserWindow, dialog, clipboard, app } from 'electron';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLog } from './debug-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 环境安装进度转发：同时推送到渲染进程 + 写入调试日志
 *
 * 前端环境页的安装日志框显示实时进度，但内容不进 ~/.dsh/manager/debug.log；
 * 用户遇到"安装后命令不可用"时无法把安装过程复制给我们。此 helper 双写，
 * 让 winget/便携版/pnpm/git 安装的每一步（含级别）都进调试日志，便于排查。
 */
function makeEnvPushProgress(win) {
  return (data) => {
    const message = data && data.message ? String(data.message) : '';
    const level = (data && data.level) || 'info';
    if (message) writeLog(level, '[env-install] ' + message);
    if (win && !win.isDestroyed()) {
      win.webContents.send('dsh:env-install-progress', data);
    }
  };
}

/**
 * 无窗口补丁源码（写入真实文件系统后通过 --require 注入 DSH 进程）
 * 强制所有 child_process.spawn/exec/execFile/fork 使用 windowsHide: true，
 * 根治 DSH Agent bash 调用弹窗问题。不修改 DSH 包文件，升级不丢失。
 */
const NO_WINDOW_PATCH_SOURCE = `'use strict';
const cp = require('child_process');
const origSpawn = cp.spawn;
const origSpawnSync = cp.spawnSync;
const origExec = cp.exec;
const origExecSync = cp.execSync;
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;
const origFork = cp.fork;
function forceNoWindow(options) {
  if (process.platform !== 'win32') return options;
  if (options && typeof options === 'object') options.windowsHide = true;
  return options;
}
cp.spawn = function(cmd, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return origSpawn.call(this, cmd, forceNoWindow(args));
  return origSpawn.call(this, cmd, args, forceNoWindow(options));
};
cp.spawnSync = function(cmd, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return origSpawnSync.call(this, cmd, forceNoWindow(args));
  return origSpawnSync.call(this, cmd, args, forceNoWindow(options));
};
cp.exec = function(cmd, options, callback) {
  if (typeof options === 'function' || options === undefined) return origExec.call(this, cmd, options, callback);
  return origExec.call(this, cmd, forceNoWindow(options), callback);
};
cp.execSync = function(cmd, options) {
  return origExecSync.call(this, cmd, forceNoWindow(options));
};
cp.execFile = function(file, args, options, callback) {
  if (typeof args === 'function') return origExecFile.call(this, file, args, options);
  if (typeof options === 'function') return origExecFile.call(this, file, args, forceNoWindow(options), callback);
  return origExecFile.call(this, file, args, forceNoWindow(options), callback);
};
cp.execFileSync = function(file, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return origExecFileSync.call(this, file, forceNoWindow(args));
  return origExecFileSync.call(this, file, args, forceNoWindow(options));
};
cp.fork = function(modulePath, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return origFork.call(this, modulePath, args);
  return origFork.call(this, modulePath, args, forceNoWindow(options));
};
if (process.env.DSH_DEBUG) {
  try {
    const { appendFileSync, existsSync, mkdirSync } = require('fs');
    const { join } = require('path');
    const os = require('os');
    const debugLog = join(process.env.DSH_HOME || (os.homedir() + '/.dsh'), 'manager', 'no-window-patch.log');
    if (!existsSync(require('path').dirname(debugLog))) mkdirSync(require('path').dirname(debugLog), { recursive: true });
    appendFileSync(debugLog, '[' + new Date().toISOString() + '] [INFO] no-window-patch 已加载, 进程: ' + process.pid + '\\n');
  } catch (e) { console.error('no-window-patch init error:', e.message); }
}`;

/**
 * 将无窗口补丁写入真实文件系统（userData 目录，不在 asar 内），返回可被系统 node --require 的路径
 * @private
 */
function getPatchPath() {
  const patchDir = join(app.getPath('userData'), 'patches');
  if (!existsSync(patchDir)) mkdirSync(patchDir, { recursive: true });
  const patchPath = join(patchDir, 'no-window-patch.cjs');
  try {
    writeFileSync(patchPath, NO_WINDOW_PATCH_SOURCE, 'utf-8');
  } catch (e) {
    writeLog('error', '写入无窗口补丁失败: ' + (e?.message || e));
  }
  return patchPath;
}

// 动态导入核心模块（使用相对路径，确保打包后可用）
let core, marketplace;

async function loadCore() {
  if (!core) {
    try {
      core = await import('../packages/core/src/index.js');
    } catch (e) {
      console.error('[debug] 核心模块加载失败:', e.message);
      throw e;
    }
  }
  return core;
}

async function loadMarketplace() {
  if (!marketplace) {
    try {
      marketplace = await import('../packages/marketplace/src/index.js');
    } catch (e) {
      console.error('[debug] 市场模块加载失败:', e.message);
      throw e;
    }
  }
  return marketplace;
}

// ====== DSH web token 捕获（0.1.2-alpha.4+ 需要 ?token= 鉴权） ======
// DSH 启动时打印 "dsh web: http://127.0.0.1:<port>/?token=XXX"，
// 解析并保存带 token 的完整 URL，供 webview 加载（裸 URL 访问会 401 白屏）。
let lastWebTokenUrl = null;
/** 从磁盘恢复的带 token web URL（Manager 重启后 DSH 仍运行时的回退） */
let __restoredWebUrl = null;
/** 持久化状态加载完成的 Promise（getDSHWebUrl 前 await，避免时序竞态） */
let __webUrlStateReady = Promise.resolve();

/**
 * DSH web 状态持久化：token URL 存内存会在「Manager 重启但 DSH 仍运行」时丢失，
 * 导致打开软件无法识别已运行的 DSH（裸 URL 401 白屏，只能网页访问）。
 * 捕获到 token URL 即写入 ~/.dsh/manager/dsh-web-url.json，启动时恢复复用。
 */
const WEB_URL_STATE_RELPATH = ['manager', 'dsh-web-url.json'];

async function webUrlStateFile() {
  try {
    const { DSH_PATHS } = await loadCore();
    return join(DSH_PATHS.home, ...WEB_URL_STATE_RELPATH);
  } catch {
    return null;
  }
}

function persistWebUrlState(port, url) {
  // 不阻塞：写文件失败不影响 DSH 运行（仅影响重启后自动恢复）
  webUrlStateFile().then((file) => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const data = { port, url, ts: Date.now() };
      writeFileSync(file, JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      writeLog('warn', '持久化 DSH web URL 状态失败: ' + (e?.message || e));
    }
  });
}

async function loadPersistedWebUrlState() {
  try {
    const file = await webUrlStateFile();
    if (!file || !existsSync(file)) return null;
    const raw = readFileSync(file, 'utf-8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && typeof data.url === 'string' && data.url.includes('token=') && data.port) {
      return data;
    }
  } catch {}
  return null;
}

/** 清理持久化 web URL 状态（DSH 停止时调用，避免残留过期 token）。 */
function clearWebUrlState() {
  lastWebTokenUrl = null;
  __restoredWebUrl = null;
  webUrlStateFile().then((file) => {
    if (!file) return;
    try { if (existsSync(file)) rmSync(file, { force: true }); } catch {}
  });
}

/** 匹配 DSH 打印的带鉴权 URL 行 */
const DSH_WEB_URL_RE = /dsh web:\s*(https?:\/\/\S+)/i;

/**
 * 监听 DSH 子进程 stdout/stderr，提取带 token 的 web URL。
 * @param {import('execa').ResultPromise} child
 * @param {number} port
 */
function captureDSHWebUrl(child, port) {
  const handle = (chunk) => {
    try {
      const text = String(chunk || '');
      const m = text.match(DSH_WEB_URL_RE);
      if (m) {
        const url = m[1].trim().replace(/[)\]]+$/, '');
        // 只接受本机回环地址（带 token），防止误取 LAN URL
        if (/^https?:\/\/127\.0\.0\.1(?:\:\d+)?\//.test(url) && url.includes('token=')) {
          lastWebTokenUrl = url;
          // 持久化到 ~/.dsh/manager/dsh-web-url.json：Manager 重启后 DSH 仍在运行时，
          // 能恢复带 token 的 URL 并连接已运行实例（否则裸 URL 401，只能网页访问）
          persistWebUrlState(port, url);
          writeLog('info', '捕获 DSH web 鉴权 URL: ' + url.replace(/token=\S+/, 'token=***'));
        }
      }
    } catch (e) {
      writeLog('warn', '解析 DSH web URL 异常: ' + e.message);
    }
  };
  // execa 的 ResultPromise 暴露 stdout/stderr 流
  if (child?.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', handle);
  }
  if (child?.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', handle);
  }
}

/**
 * 组装当前应使用的 DSH web URL（带 token，若有）。
 * @param {number} port
 * @returns {string}
 */
function resolveWebUrl(port) {
  if (lastWebTokenUrl) {
    try {
      const u = new URL(lastWebTokenUrl);
      if (u.port === String(port) || (u.port === '' && port === 80)) return lastWebTokenUrl;
    } catch {}
  }
  // 内存丢失（Manager 重启但 DSH 仍运行）：从持久化状态恢复带 token 的 URL
  if (typeof __restoredWebUrl === 'string' && __restoredWebUrl) {
    try {
      const u = new URL(__restoredWebUrl);
      if (u.port === String(port) || (u.port === '' && port === 80)) return __restoredWebUrl;
    } catch {}
  }
  return 'http://127.0.0.1:' + port;
}

/**
 * 构建并启动 DSH web 子进程（供 dsh:start 与启动失败自愈重启复用）
 * @returns {Promise<{error?: string, child?: import('execa').ResultPromise, actualPort?: number, preferredPort?: number, portResult?: object}>}
 */
async function spawnDSHWeb() {
  const { execa } = await import('execa');
  const { DSHConfig, DSHUtils, buildRuntimeEnv, getRuntimeConfig, findAvailablePort } = await loadCore();
  // 预检并迁移旧版扁平布局的凭据文件 → 新版版本化布局
  // （新版 DSH 的 dsh-credentials-local 只接受顶层 version/refs/records，
  //   旧扁平布局会导致 DSH 启动即崩溃，表现为「重启 DSH 没生效」）
  try {
    const credResult = await new DSHConfig().migrateCredentialsToVersioned();
    if (credResult && credResult.migrated) {
      writeLog('info', '已自动迁移凭据文件到版本化布局（备份: ' + credResult.backup + '，迁移 ' + credResult.keys + ' 个密钥）');
    } else if (credResult && credResult.reason === 'already-versioned') {
      writeLog('info', '凭据文件已是最新版版本化布局，无需迁移');
    } else if (credResult && (credResult.reason === 'write-error' || credResult.reason === 'not-flat-layout' || credResult.reason === 'empty-value' || credResult.reason === 'version-mismatch')) {
      // 凭据文件格式 DSH 不接受且无法自动迁移 → 阻止启动并给出明确原因
      const detail = credResult.reason === 'write-error'
        ? ('写入失败: ' + (credResult.error || '未知错误'))
        : (credResult.reason === 'not-flat-layout' ? '包含不支持的行: ' + (credResult.line || '') : (credResult.reason === 'empty-value' ? '存在空值键: ' + (credResult.key || '') : 'version 键值不兼容'));
      const msg = 'DSH 凭据文件无法自动迁移为版本化布局（' + detail + '）。请检查 ' + new DSHConfig().credPath + '，或将其中凭据迁移到 refs 下。';  
      writeLog('error', msg);
      return { error: msg };
    }
  } catch (credErr) {
    writeLog('warn', '凭据文件预检异常（继续尝试启动）: ' + credErr.message);
  }
  // 启动前自动迁移/清洗 LLM 提供商配置（llm-openai-compatible 等 DSH 不读的段 → llm-pi-ai；
  // apiKeyEnv:"" / 空 baseURL / provider 字段等脏数据就地归一化），
  // 否则 DSH 会整段拒绝 llm-pi-ai → 表现为「配置了模型但 DSH 里看不到」
  try {
    const migResult = await new DSHConfig().migrateLLMProviders();
    if (migResult && (migResult.moved > 0 || migResult.cleaned.length > 0 || migResult.normalized > 0)) {
      writeLog('info', 'LLM 提供商配置已自动迁移/清洗（移动 ' + migResult.moved + '，清理 ' + migResult.cleaned.join('、') + '，归一化 ' + migResult.normalized + ' 条）');
    }
  } catch (migErr) {
    writeLog('warn', 'LLM 提供商配置迁移异常（继续启动）: ' + migErr.message);
  }
  // 启动前确保内置能力路由插件已装入 profile（node_modules + cordis.patch.yml 注册）。
  // 该插件读取 settings.capability-router 并在 agent/request 瀑布上按内容切换模型，
  // 使 Manager 的「能力路由」配置真正在 DSH 中生效（幂等，重复启动不重复写）。
  try {
    const { installCapabilityRouter } = await loadCore();
    const inst = await installCapabilityRouter('web');
    if (inst && !inst.success) {
      writeLog('warn', '能力路由插件安装未完成（不影响 DSH 启动）: ' + (inst.error || 'unknown'));
    } else if (inst && inst.installed) {
      writeLog('info', '能力路由插件就绪（' + (inst.method || 'ok') + '）');
    }
  } catch (instErr) {
    writeLog('warn', '能力路由插件安装异常（继续启动）: ' + instErr.message);
  }
  const dshPkgPath = await DSHUtils.getDSHPath();
  if (!dshPkgPath) return { error: 'DSH 未安装，请先安装 DSH' };
  const pkgJson = JSON.parse(readFileSync(join(dshPkgPath, 'package.json'), 'utf-8'));
  const binEntry = pkgJson.bin;
  let cliPath;
  if (typeof binEntry === 'string') {
    cliPath = join(dshPkgPath, binEntry);
  } else if (binEntry && typeof binEntry === 'object') {
    cliPath = join(dshPkgPath, binEntry.dsh || Object.values(binEntry)[0]);
  }
  if (!cliPath || !existsSync(cliPath)) {
    return { error: '无法定位 DSH CLI 入口文件: ' + (cliPath || '未找到') };
  }
  const [{ env }, rt] = await Promise.all([buildRuntimeEnv(), getRuntimeConfig()]);
  const preferredPort = rt.port && rt.port > 0 ? rt.port : 3080;
  const portResult = await findAvailablePort(preferredPort);
  const actualPort = portResult.port;

  // 首选端口被占用：先检测是否已有 DSH 实例在运行（健康检查），
  // 有则直接复用（返回 reuse），不要双开第二个实例（双开会随机换端口，且 Manager 重开后
  // 的 token URL 丢失会导致 webview 无法连接已运行实例，只能网页访问）。
  if (portResult.used === true && actualPort !== preferredPort) {
    try {
      const { testDSHHealth } = await loadCore();
      const health = await testDSHHealth(preferredPort);
      if (health && health.reachable) {
        const webUrl = resolveWebUrl(preferredPort);
        writeLog('info', '检测到 DSH 已在端口 ' + preferredPort + ' 运行，直接复用（不启动新实例）');
        // 尝试从磁盘恢复带 token 的 URL（Manager 重启后 lastWebTokenUrl 丢失）
        if (!/token=/.test(webUrl)) {
          const persisted = await loadPersistedWebUrlState();
          if (persisted && persisted.port === preferredPort) {
            __restoredWebUrl = persisted.url;
            lastWebTokenUrl = persisted.url;
          }
        }
        return { reuse: true, actualPort: preferredPort, preferredPort, portResult, webUrl: resolveWebUrl(preferredPort) };
      }
    } catch (reuseErr) {
      writeLog('warn', '检测已运行 DSH 实例异常（继续按双开处理）: ' + (reuseErr?.message || reuseErr));
    }
  }

  const startArgs = ['web'];
  if (actualPort !== 3080) startArgs.push('--port', String(actualPort));
  const nodeEnv = { ...env, NO_COLOR: '1' };
  if (rt.retryCount && rt.retryCount > 0) {
    nodeEnv.DSH_AGENT_MAX_RETRIES = String(rt.retryCount);
  }
  if (rt.lowMemory) {
    nodeEnv.NODE_OPTIONS = `--max-old-space-size=${rt.maxOldSpace}`;
  }
  // 注入 --require 无窗口补丁（写入真实文件系统，强制所有子进程 windowsHide: true）
  const patchRealPath = getPatchPath();
  const startArgsWithPatch = ['--require', patchRealPath, cliPath, ...startArgs];
  const child = execa('node', startArgsWithPatch, {
    detached: true,                // 所有平台脱离父进程树，防止被回收
    windowsHide: !nodeEnv.DSH_SHOW_CONSOLE, // 默认隐藏；设置 DSH_SHOW_CONSOLE=1 可显示控制台窗口
    stdio: ['ignore', 'pipe', 'pipe'],
    env: nodeEnv,
    reject: false,                 // 不抛异常，由调用方统一处理失败
  });
  // execa v10 不暴露 .unref()，需通过底层 nodeChildProcess 调用
  child.nodeChildProcess?.unref();
  // —— DSH 0.1.2-alpha.4 起 web 需要 token 鉴权 ——
  // 解析 DSH 启动时打印的 "dsh web: http://127.0.0.1:<port>/?token=XXX" 行，
  // 把带 token 的完整 URL 保存下来，供 webview 使用（裸 URL 访问会 401 白屏）。
  captureDSHWebUrl(child, actualPort);
  return { child, actualPort, preferredPort, portResult };
}

/**
 * 注册所有 IPC 处理器
 */
export function registerIpcHandlers(ipcMain, getMainWindow) {
  // 跟踪最后一次启动的实际端口（用于 stop 和诊断）
  let lastActivePort = 3080;

  // Manager 重启后 DSH 仍运行时：从磁盘恢复带 token 的 web URL 与端口，
  // 使 webview 能连接已运行实例（否则裸 URL 401 白屏，只能网页访问）。
  // 存为模块级 Promise：dsh:get-web-url 等 handler 会 await，避免渲染进程先于恢复完成就取到裸 URL。
  __webUrlStateReady = loadPersistedWebUrlState().then((st) => {
    if (st) {
      if (st.url && st.url.includes('token=')) __restoredWebUrl = st.url;
      if (st.port) lastActivePort = st.port;
      writeLog('info', '已从持久化状态恢复 DSH web URL（端口 ' + st.port + '，token 已脱敏）');
    }
  }).catch(() => {});

  // ====== 窗口控制 ======
  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  
  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  
  ipcMain.handle('window-is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false;
  });

  // ====== DSH 管理 ======
  ipcMain.handle('dsh:get-info', async () => {
    const { getDSHInfo, testDSHHealth, getDSHProcessInfo } = await loadCore();
    const info = await getDSHInfo();
    // 运行时探测兜底：安装路径未识别（profile/自定义位置安装）时，
    // 只要端口上有 DSH 服务特征（HTTP 200/401，0.1.2+ 无 token 访问根路径返回 401），
    // 就识别为"已安装且正在运行"，避免"DSH 在跑但管理器显示未安装、控制台空白"
    if (!info.installed) {
      try {
        const targetPort = lastActivePort && lastActivePort !== 3080 ? lastActivePort : 3080;
        const [health, proc] = await Promise.all([
          testDSHHealth(targetPort),
          getDSHProcessInfo(targetPort),
        ]);
        const detected = health.reachable || proc.portInUse;
        if (detected) {
          writeLog('info', '检测到运行中的 DSH（端口 ' + targetPort + '，安装路径未识别，按运行时探测识别）');
          return {
            ...info,
            installed: true,
            runningDetected: true,
            version: info.version || null,
            path: info.path,
            runtimeHealth: health,
            runtimeProcess: proc,
          };
        }
      } catch (e) {
        writeLog('warn', 'DSH 运行时探测失败: ' + (e?.message || e));
      }
    }
    return info;
  });

  ipcMain.handle('dsh:get-detection-detail', async () => {
    const { getDSHDetectionDetail } = await loadCore();
    return getDSHDetectionDetail();
  });

  ipcMain.handle('dsh:install', async (_, version, registry, tool = 'auto') => {
    const { DSHInstaller } = await loadCore();
    const installer = new DSHInstaller({
      registry,
      onProgress: (data) => {
        // 将安装日志推送到渲染进程，驱动真实进度条
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('dsh:install-progress', data);
        }
      },
    });
    try {
      const result = await installer.install(version, { tool });
      // 记录安装/升级后的版本（与 switch-version 保持一致，保证版本管理页记录完整）
      if (result && result.version) {
        try {
          const { DSHVersionManager } = await loadCore();
          const vm = new DSHVersionManager();
          let dshPath = null;
          try {
            const { getDSHPath } = await loadCore();
            dshPath = await getDSHPath();
          } catch {}
          await vm.recordVersion(result.version, dshPath);
        } catch (e) {
          console.warn('[dsh-manager] 记录安装版本失败:', e?.message);
        }
      }
      return result;
    } catch (error) {
      // 透传 execa 的 stderr 细节，避免渲染层只见 "Error invoking remote method" 无法排查
      const detail = error?.stderr ? `\n${String(error.stderr).trim().slice(0, 800)}` : '';
      throw new Error(`${error?.message || '安装失败'}${detail}`);
    }
  });

  ipcMain.handle('dsh:uninstall', async () => {
    const { DSHInstaller } = await loadCore();
    const installer = new DSHInstaller();
    return await installer.uninstall();
  });

  ipcMain.handle('dsh:check-update', async () => {
    const { DSHVersionManager } = await loadCore();
    const vm = new DSHVersionManager();
    return await vm.checkForUpdate();
  });

  // ====== DSH 重启（组合 stop + start） ======
  ipcMain.handle('dsh:restart', async () => {
    try {
      // 先停止
      const { stopProcessByPort, testDSHHealth } = await loadCore();
      try {
        const health = await testDSHHealth(lastActivePort);
        if (health.reachable) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          try {
            await fetch('http://127.0.0.1:' + lastActivePort + '/api/shutdown', { method: 'POST', signal: controller.signal });
          } catch {}
          clearTimeout(timeoutId);
        }
      } catch {}
      await stopProcessByPort(lastActivePort);
      // 清理所有 DSH 相关进程
      try {
        const { execa } = await import('execa');
        if (process.platform === 'win32') {
          const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '@deepseek-ai[/\\\\]dsh(?=[/\\\\\\\\\\\\s]|$)' } | ForEach-Object { $_.ProcessId }";
          const { stdout } = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { reject: false, timeout: 10_000, windowsHide: true });
          const pids = stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
          for (const pid of pids) {
            try { await execa('taskkill', ['/PID', pid, '/F', '/T'], { reject: false, timeout: 10_000, windowsHide: true }); } catch {}
          }
        }
      } catch {}

      // 再启动
      const sp = await spawnDSHWeb();
      if (sp.error) {
        return { success: false, error: sp.error };
      }
      const { child, actualPort, portResult, preferredPort } = sp;
      lastActivePort = actualPort;

      // 等待服务就绪
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const health = await testDSHHealth(actualPort);
          if (health.reachable) {
            return { success: true, port: actualPort, reachable: true, webUrl: resolveWebUrl(actualPort) };
          }
        } catch {}
      }

      return { success: true, port: actualPort, reachable: false, message: 'DSH 已重启，等待服务就绪中...' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ====== 数据管理 ======
  ipcMain.handle('dsh:storage-info', async () => {
    const { getDSHStorageInfo } = await loadCore();
    return await getDSHStorageInfo();
  });

  ipcMain.handle('dsh:clean-data', async (_, opts = {}) => {
    const { cleanDSHData } = await loadCore();
    return await cleanDSHData(opts);
  });

  // ====== 回复语言 ======
  ipcMain.handle('dsh:set-reply-language', async (_, lang) => {
    const { setReplyLanguage } = await loadCore();
    return await setReplyLanguage(lang);
  });

  ipcMain.handle('dsh:get-reply-language', async () => {
    const { getReplyLanguage } = await loadCore();
    return await getReplyLanguage();
  });

  // ====== 进程管理 ======
  ipcMain.handle('dsh:process-info', async () => {
    const { getDSHProcessInfo } = await loadCore();
    return await getDSHProcessInfo(lastActivePort);
  });

  // ====== Profile 管理 ======
  ipcMain.handle('dsh:list-profiles', async () => {
    const { DSHProfileManager } = await loadCore();
    return new DSHProfileManager().list();
  });

  ipcMain.handle('dsh:create-profile', async (_, name) => {
    const { DSHProfileManager } = await loadCore();
    return await new DSHProfileManager().create(name);
  });

  ipcMain.handle('dsh:backup-profile', async (_, name) => {
    const { DSHProfileManager } = await loadCore();
    return await new DSHProfileManager().backup(name);
  });

  ipcMain.handle('dsh:start', async () => {
    try {
      const { testDSHHealth } = await loadCore();
      const sp = await spawnDSHWeb();
      if (sp.error) {
        return { success: false, error: sp.error };
      }
      // 端口占用且检测到已有 DSH 健康运行 → 直接复用，不启动新实例
      if (sp.reuse) {
        lastActivePort = sp.actualPort;
        const webUrl = sp.webUrl || resolveWebUrl(sp.actualPort);
        writeLog('info', 'dsh:start 复用已运行 DSH（端口 ' + sp.actualPort + '）');
        return {
          success: true,
          reachable: true,
          reused: true,
          port: sp.actualPort,
          portChanged: false,
          webUrl,
        };
      }
      const { child, actualPort, portResult, preferredPort } = sp;
      lastActivePort = actualPort; // 记录本次实际端口，供 stop/diagnose 使用

      child.then(async result => {
        // 进程已退出（成功启动后退出或启动即失败）。短暂存活期内的非零退出视为启动失败
        if (result.exitCode !== 0 && result.failed) {
          const stderr = (result.stderr || '').toString().trim();
          writeLog('error', 'DSH 启动失败: exit=' + result.exitCode + (stderr ? ' stderr: ' + stderr.slice(0, 2000) : ''));
          // 自动诊断是否有无效插件/缺失模块导致启动失败
          // 从 stderr 中提取失效插件 ID / 缺失模块（更可靠：直接匹配运行时报错信息）
          let invalidPlugins = [];
          try {
            const { PluginRegistry } = await loadMarketplace();
            const registry = new PluginRegistry();
            // 传入 stderr 让诊断提取运行时报错的插件 ID
            const diag = registry.diagnoseInvalidPlugins('web', stderr);
            invalidPlugins = diag.invalid || [];
          } catch (diagErr) {
            writeLog('error', '启动失败后插件诊断异常: ' + (diagErr?.message || diagErr));
          }
          // 兜底：如果诊断未找到，直接从 stderr 解析 failing plugin ID
          if (invalidPlugins.length === 0 && stderr) {
            // 注意：括号内可能是 undefined（如损坏 include 条目 "ui-skin-stock (undefined)"），
            // 此时回退使用 loader entry 名（ui-skin-stock）；cordis:include 等机制名需过滤
            const re = /failed to (?:apply|import) loader entry\s+([^\s(]+)(?:\s*\(([^)]*)\))?/g;
            let m;
            while ((m = re.exec(stderr)) !== null) {
              let id = (m[2] || '').trim();
              // 括号内是 cordis 机制名（如 include (cordis:include)）→ loader entry 为机制本身，跳过
              if (id && /^cordis:/i.test(id)) {
                continue;
              }
              // 括号值无效（undefined / 空）→ 使用 loader entry 名（如 ui-skin-stock）
              if (!id || id === 'undefined') {
                id = (m[1] || '').trim();
              }
              if (id && !id.startsWith('@deepseek-ai/') && !/^cordis:/i.test(id)) {
                invalidPlugins.push({ id, reason: '启动时加载失败（stderr 指示）', kind: 'plugin' });
              }
            }
            // 兜底也提取 Cannot find module 的缺失模块（单引号路径）
            const re2 = /Cannot find module ['"]([^'"]+)['"]/g;
            while ((m = re2.exec(stderr)) !== null) {
              const path = m[1];
              const idx = path.indexOf('node_modules');
              const parts = (idx >= 0 ? path.slice(idx + 'node_modules'.length) : path).split(/[\\/]/).filter(Boolean);
              let pkg = null;
              if (parts.length > 0) {
                pkg = parts[0].startsWith('@') && parts.length >= 2 ? parts[0] + '/' + parts[1] : parts[0];
              }
              if (pkg && !pkg.startsWith('@deepseek-ai/') && !invalidPlugins.some(p => p.id === pkg)) {
                invalidPlugins.push({ id: pkg, reason: '模块缺失（stderr 指示）', kind: 'module' });
              }
            }
          }

          const win = getMainWindow();
          const sendError = (extra = {}) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('dsh:start-error', {
                exitCode: result.exitCode,
                stderr: stderr.slice(0, 2000),
                port: actualPort,
                invalidPlugins,
                ...extra,
              });
            }
          };

          // ===== 主进程自愈：直接修复并自动重启，不再依赖前端确认/诊断触发 =====
          if (invalidPlugins.length > 0) {
            writeLog('info', '检测到启动故障，主进程自动修复中... 问题项: ' +
              invalidPlugins.map(p => p.id + '(' + p.kind + ')').join('、'));
            let repaired = [];
            let failed = [];
            try {
              const { copyModuleToProfile, repairProfileDependencies } = await loadCore();
              const { PluginRegistry } = await loadMarketplace();
              const registry = new PluginRegistry();
              // ① 移除无效插件（plugin kind）
              try {
                const fixResult = await registry.fixInvalidPlugins('web');
                repaired.push(...(fixResult.fixed || []).map(f => f.id));
              } catch (fixErr) {
                writeLog('warn', '移除无效插件异常: ' + (fixErr?.message || fixErr));
              }
              // ② 定向补齐缺失模块（module kind，如 shiki）
              const moduleIds = invalidPlugins.filter(p => p.kind === 'module').map(p => p.id);
              for (const id of moduleIds) {
                try {
                  const r = await copyModuleToProfile('web', id);
                  if (r.success) repaired.push(id);
                  else failed.push(id);
                } catch (mErr) {
                  failed.push(id);
                  writeLog('warn', '补齐模块 ' + id + ' 异常: ' + (mErr?.message || mErr));
                }
              }
              // ③ 仍有失败 → 在 profile 内重建依赖树（pnpm/npm install 按锁文件整体修复）
              if (failed.length > 0) {
                try {
                  const rebuild = await repairProfileDependencies('web');
                  writeLog('info', 'profile 依赖重建: ' + (rebuild?.summary || ''));
                } catch (rbErr) {
                  writeLog('warn', 'profile 依赖重建异常: ' + (rbErr?.message || rbErr));
                }
                // 重建后重试失败模块
                const retryFailed = [];
                for (const id of failed) {
                  try {
                    const r = await copyModuleToProfile('web', id);
                    if (r.success) repaired.push(id);
                    else retryFailed.push(id);
                  } catch (mErr) {
                    retryFailed.push(id);
                  }
                }
                failed = retryFailed;
              }
            } catch (repairErr) {
              writeLog('error', '主进程自愈修复异常: ' + (repairErr?.message || repairErr));
            }
            writeLog('info', '自愈修复结果: 成功=' + (repaired.join('、') || '无') + ' 失败=' + (failed.join('、') || '无'));

            // 修复有进展 → 自动重启 DSH
            if (repaired.length > 0) {
              writeLog('info', '自愈修复完成，自动重启 DSH...');
              try {
                const sp2 = await spawnDSHWeb();
                if (sp2.error) {
                  sendError({ afterFix: true, repaired, failed, restartError: sp2.error });
                  return;
                }
                lastActivePort = sp2.actualPort;
                // 监控重启结果
                sp2.child.then(async r2 => {
                  if (r2.exitCode !== 0 && r2.failed) {
                    const stderr2 = (r2.stderr || '').toString().trim();
                    writeLog('error', '自愈重启后 DSH 仍失败: exit=' + r2.exitCode + (stderr2 ? ' stderr: ' + stderr2.slice(0, 2000) : ''));
                    sendError({ afterFix: true, repaired, failed, restartExitCode: r2.exitCode });
                  } else {
                    writeLog('info', '自愈重启后 DSH 进程运行中: exit=' + r2.exitCode + ' port=' + sp2.actualPort);
                  }
                }).catch(err => {
                  writeLog('error', '自愈重启监控异常: ' + err.message);
                });
                // 等待 HTTP 就绪（同时确认本次启动的子进程仍存活，
                // 避免端口被残留进程占用导致"假就绪"误判）
                let health2 = null;
                for (let i = 0; i < 10; i++) {
                  // 本次启动的子进程已退出（exitCode 变为数字）→ 立即判定失败
                  const childExit = sp2.child.nodeChildProcess?.exitCode;
                  if (childExit !== null && childExit !== undefined) {
                    health2 = null;
                    break;
                  }
                  await new Promise(r => setTimeout(r, 1000));
                  health2 = await testDSHHealth(sp2.actualPort);
                  if (health2.reachable) break;
                }
                // 子进程已退出则无论端口是否可达都按失败处理
                const finalChildExit = sp2.child.nodeChildProcess?.exitCode;
                if (finalChildExit !== null && finalChildExit !== undefined) {
                  health2 = null;
                }
                if (health2?.reachable) {
                  // 自愈成功：通知前端刷新 webview 并回显修复结果
                  if (win && !win.isDestroyed()) {
                    win.webContents.send('dsh:start-error', {
                      exitCode: 0,
                      stderr: '',
                      port: sp2.actualPort,
                      webUrl: resolveWebUrl(sp2.actualPort),
                      invalidPlugins: [],
                      autoRepaired: true,
                      repaired,
                      failed,
                    });
                  }
                  writeLog('info', '✅ 自愈成功，DSH 已就绪: http://127.0.0.1:' + sp2.actualPort);
                } else {
                  sendError({ afterFix: true, repaired, failed, reachable: false });
                }
              } catch (restartErr) {
                writeLog('error', '自愈重启异常: ' + (restartErr?.message || restartErr));
                sendError({ afterFix: true, repaired, failed });
              }
            } else {
              // 无修复进展 → 通知前端展示真实错误
              sendError({ afterFix: true, repaired, failed });
            }
          } else {
            // 无诊断结果 → 通知前端展示原始错误
            sendError();
          }
        } else {
          writeLog('info', 'DSH 进程已退出: exit=' + result.exitCode + ' port=' + actualPort);
        }
      }).catch(err => {
        // reject:false 下极少走到这里，兜底记录
        writeLog('error', 'DSH 启动监控异常: ' + err.message);
      });
      // 短暂等待后检查 DSH 是否成功启动（最多 10 秒）
      // 同时确认本次启动的子进程仍存活：端口可能被残留进程占用，
      // 仅凭 HTTP 可达会把"启动即崩"误判为成功
      let health = null;
      for (let i = 0; i < 10; i++) {
        const childExit = child.nodeChildProcess?.exitCode;
        if (childExit !== null && childExit !== undefined) {
          health = null;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
        health = await testDSHHealth(actualPort);
        if (health.reachable) break;
      }
      // 子进程已退出则无论端口是否可达都按失败处理
      const finalExit = child.nodeChildProcess?.exitCode;
      if (finalExit !== null && finalExit !== undefined) {
        health = null;
      }
      // DSH 0.1.2-alpha.4+ 需要 ?token= 鉴权：HTTP 可达后补等 token 被捕获
      // （DSH 打印 "dsh web: ...?token=" 与 HTTP 就绪几乎同步，这里兜底 3 秒）
      if ((health?.reachable) && !/token=/.test(resolveWebUrl(actualPort))) {
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (/token=/.test(resolveWebUrl(actualPort))) break;
        }
      }
      return {
        success: true,
        message: 'DSH 启动命令已发送',
        port: actualPort,
        portChanged: portResult.used,
        preferredPort: preferredPort,
        reachable: health?.reachable || false,
        webUrl: resolveWebUrl(actualPort),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('dsh:stop', async () => {
    try {
      const { execa } = await import('execa');
      const { DSHUtils } = await loadCore();
      const dshPkgPath = await DSHUtils.getDSHPath();

      if (dshPkgPath) {
        // 读取 dsh package.json 获取 CLI 入口，直接 node 运行（绕过 .cmd 包装）
        const pkgJson = JSON.parse(readFileSync(join(dshPkgPath, 'package.json'), 'utf-8'));
        const binEntry = pkgJson.bin;
        let cliPath;
        if (typeof binEntry === 'string') {
          cliPath = join(dshPkgPath, binEntry);
        } else if (binEntry && typeof binEntry === 'object') {
          cliPath = join(dshPkgPath, binEntry.dsh || Object.values(binEntry)[0]);
        }
        if (cliPath && existsSync(cliPath)) {
          const result = await execa('node', [cliPath, 'stop'], {
            reject: false,
            timeout: 10000,
            windowsHide: true,
          });
          if (result.exitCode === 0) {
            // 停止成功：清理持久化的 token URL（DSH 重启后 token 会变，残留会导致复用失效）
            clearWebUrlState();
            return { success: true, message: result.stdout || '已停止' };
          }
        }
      }
      // dsh stop 命令不可用时，降级为按端口结束进程（Windows taskkill / Unix kill）
      const { stopProcessByPort } = await loadCore();
      const fallback = await stopProcessByPort(lastActivePort);
      if (fallback.success) clearWebUrlState();
      return { success: fallback.success, message: fallback.message, fallback: true, port: lastActivePort };
    } catch (error) {
      // CLI 异常也尝试端口降级
      try {
        const { stopProcessByPort } = await loadCore();
        const fallback = await stopProcessByPort(lastActivePort);
        return { success: fallback.success, message: fallback.message, fallback: true, port: lastActivePort };
      } catch {
        return { success: false, error: error.message };
      }
    }
  });

  // ====== DSH 服务诊断与端口管理 ======
  ipcMain.handle('dsh:diagnose', async (_, port) => {
    const { diagnoseDSHProcess } = await loadCore();
    const targetPort = Number(port) || lastActivePort || 3080;
    return await diagnoseDSHProcess(targetPort);
  });

  ipcMain.handle('dsh:check-port', async (_, port) => {
    const { isPortFree, findAvailablePort } = await loadCore();
    const targetPort = Number(port) || (lastActivePort !== 3080 ? lastActivePort : 3080);
    const free = isPortFree(targetPort);
    const avail = await findAvailablePort(targetPort);
    return {
      port: targetPort,
      free: await free,
      available: avail.port,
      wouldUse: avail.port,
      note: avail.used
        ? '端口 ' + targetPort + ' 被占用，启动时将自动切换到 ' + avail.port
        : '端口 ' + targetPort + ' 空闲，可直接使用',
    };
  });

  ipcMain.handle('dsh:get-actual-port', async () => {
    await __webUrlStateReady; // 等持久化状态恢复完成，避免返回旧端口
    return { port: lastActivePort, defaultPort: 3080 };
  });

  // 返回当前应使用的 DSH web URL（带 token 鉴权，若有；DSH 0.1.2-alpha.4+ 需要）
  ipcMain.handle('dsh:get-web-url', async () => {
    await __webUrlStateReady; // 等持久化状态恢复完成，避免返回裸 URL 导致 401 白屏
    const url = resolveWebUrl(lastActivePort);
    writeLog('debug', 'dsh:get-web-url -> ' + url.replace(/token=\S+/, 'token=***'));
    return { url, port: lastActivePort, hasToken: /token=/.test(url) };
  });

  // 一键修复无效插件/缺失依赖并重启 DSH（解决 gongwen-skill "invalid plugin"、shiki/js-yaml 缺失等启动失败）
  ipcMain.handle('dsh:fix-and-restart', async (_, moduleIds) => {
    try {
      // ① 修复无效插件（注册表中指向缺失包的条目）
      const { PluginRegistry } = await loadMarketplace();
      const registry = new PluginRegistry();
      const fixResult = await registry.fixInvalidPlugins('web');

      // ①.5 修复依赖完整性：profile 缺失模块（如 shiki）从全局副本补齐；
      //      全局安装自身缺失（如 js-yaml）在全局目录内 npm install 恢复
      const { repairProfileFromGlobal, repairGlobalDSHInstall, copyModuleToProfile, repairProfileDependencies } = await loadCore();
      let depFix = { repaired: [], failed: [], skipped: [], summary: '' };
      let globalFix = { fixed: [], failed: [], summary: '' };
      try {
        globalFix = await repairGlobalDSHInstall();
      } catch (gErr) {
        globalFix = { fixed: [], failed: [], summary: '全局依赖修复异常: ' + (gErr?.message || gErr) };
      }
      try {
        depFix = await repairProfileFromGlobal('web', { includeSystem: true });
      } catch (dErr) {
        depFix = { repaired: [], failed: [], skipped: [], summary: 'profile 依赖修复异常: ' + (dErr?.message || dErr) };
      }

      // ①.6 定向补齐：启动失败时 stderr 中 ERR_MODULE_NOT_FOUND 指向的模块
      //      （如 shiki 是传递依赖，不在 profile package.json 声明中，需按 ID 复制）
      let moduleFix = { copied: [], failed: [] };
      if (Array.isArray(moduleIds) && moduleIds.length > 0) {
        for (const id of moduleIds) {
          try {
            const r = await copyModuleToProfile('web', id);
            if (r.success) moduleFix.copied.push(id);
            else moduleFix.failed.push({ id, error: r.error || '复制失败' });
          } catch (mErr) {
            moduleFix.failed.push({ id, error: mErr?.message || String(mErr) });
          }
        }
      }

      // ①.7 兜底：profile 依赖树重建（按锁文件整体重建）
      //      覆盖两类场景：① 模块复制失败（全局无该包）→ 重建后重试复制；
      //      ② 版本漂移（如 profile rc.7 vs 全局 rc.8 导致 client bundle
      //      "build-time externals drift" / "missed the module table"）→ pnpm install 对齐
      let profileRebuild = null;
      try {
        profileRebuild = await repairProfileDependencies('web');
        writeLog('info', 'profile 依赖重建: ' + (profileRebuild?.summary || ''));
        // 重建后对之前失败的模块再试一次定向复制
        if (moduleFix.failed.length > 0) {
          const retryFailed = [];
          for (const item of moduleFix.failed) {
            try {
              const r = await copyModuleToProfile('web', item.id);
              if (r.success) moduleFix.copied.push(item.id);
              else retryFailed.push({ id: item.id, error: r.error || '复制失败' });
            } catch (mErr) {
              retryFailed.push({ id: item.id, error: mErr?.message || String(mErr) });
            }
          }
          moduleFix.failed = retryFailed;
        }
      } catch (pErr) {
        profileRebuild = { success: false, summary: 'profile 依赖重建异常: ' + (pErr?.message || pErr) };
      }

      // ② 重新触发启动（复用 dsh:start 逻辑）
      const { execa } = await import('execa');
      const { DSHUtils, findAvailablePort, testDSHHealth, buildRuntimeEnv, getRuntimeConfig } = await loadCore();
      const dshPkgPath = await DSHUtils.getDSHPath();
      if (!dshPkgPath) {
        return { success: false, error: 'DSH 未安装，请先安装 DSH' };
      }
      const pkgJson = JSON.parse(readFileSync(join(dshPkgPath, 'package.json'), 'utf-8'));
      const binEntry = pkgJson.bin;
      let cliPath;
      if (typeof binEntry === 'string') {
        cliPath = join(dshPkgPath, binEntry);
      } else if (binEntry && typeof binEntry === 'object') {
        cliPath = join(dshPkgPath, binEntry.dsh || Object.values(binEntry)[0]);
      }
      if (!cliPath || !existsSync(cliPath)) {
        return { success: false, error: '无法定位 DSH CLI 入口文件: ' + (cliPath || '未找到') };
      }
      const [{ env }, rt] = await Promise.all([buildRuntimeEnv(), getRuntimeConfig()]);
      const preferredPort = rt.port && rt.port > 0 ? rt.port : 3080;
      const portResult = await findAvailablePort(preferredPort);
      const actualPort = portResult.port;
      lastActivePort = actualPort;

      const startArgs = ['web'];
      if (actualPort !== 3080) startArgs.push('--port', String(actualPort));
      const nodeEnv = { ...env, NO_COLOR: '1' };
      if (rt.retryCount && rt.retryCount > 0) {
        nodeEnv.DSH_AGENT_MAX_RETRIES = String(rt.retryCount);
      }
      if (rt.lowMemory) {
        nodeEnv.NODE_OPTIONS = `--max-old-space-size=${rt.maxOldSpace}`;
      }
      const patchRealPath = getPatchPath();
      const startArgsWithPatch = ['--require', patchRealPath, cliPath, ...startArgs];
      const child = execa('node', startArgsWithPatch, {
        detached: true,
        windowsHide: !nodeEnv.DSH_SHOW_CONSOLE, // 默认隐藏；设置 DSH_SHOW_CONSOLE=1 可显示
        stdio: ['ignore', 'pipe', 'pipe'],
        env: nodeEnv,
        reject: false,
      });
      child.nodeChildProcess?.unref();
      child.then(async result => {
        if (result.exitCode !== 0 && result.failed) {
          const stderr = (result.stderr || '').toString().trim();
          writeLog('error', '修复后 DSH 重启仍失败: exit=' + result.exitCode + (stderr ? ' stderr: ' + stderr.slice(0, 2000) : ''));
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('dsh:start-error', {
              exitCode: result.exitCode,
              stderr: stderr.slice(0, 2000),
              port: actualPort,
              invalidPlugins: [],
              afterFix: true,
            });
          }
        } else {
          writeLog('info', '修复后 DSH 进程已退出: exit=' + result.exitCode + ' port=' + actualPort);
        }
      }).catch(err => {
        writeLog('error', '修复后 DSH 启动监控异常: ' + err.message);
      });

      // 等待 HTTP 就绪
      let health = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(res => setTimeout(res, 1000));
        health = await testDSHHealth(actualPort);
        if (health.reachable) break;
      }
      return {
        success: true,
        message: '无效插件/缺失依赖已修复，DSH 重新启动',
        fixResult,
        depFix,
        globalFix,
        moduleFix,
        profileRebuild,
        port: actualPort,
        webUrl: resolveWebUrl(actualPort),
        reachable: health?.reachable || false,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('dsh:get-versions', async () => {
    const { DSHInstaller, DSHVersionManager } = await loadCore();
    const installer = new DSHInstaller();
    const vm = new DSHVersionManager();
    const [versions, installed] = await Promise.all([
      installer.getAvailableVersions(),
      vm.getInstalledVersions(),
    ]);
    return { versions, installed };
  });

  ipcMain.handle('dsh:switch-version', async (_, version) => {
    const { DSHInstaller, DSHVersionManager } = await loadCore();
    const win = getMainWindow();
    const installer = new DSHInstaller({
      onProgress: (data) => {
        // 将卸载/安装日志推送到渲染进程，驱动版本切换进度条
        if (win && !win.isDestroyed()) {
          win.webContents.send('dsh:switch-version-progress', data);
        }
      },
    });
    try {
      const result = await installer.switchVersion(version);
      // 记录切换后的版本（含安装路径，供检测兜底与诊断）
      const vm = new DSHVersionManager();
      let dshPath = null;
      try {
        const { getDSHPath } = await loadCore();
        dshPath = await getDSHPath();
      } catch {}
      if (result.newVersion) await vm.recordVersion(result.newVersion, dshPath);
      return result;
    } catch (error) {
      // 切换失败：进度回显失败原因
      if (win && !win.isDestroyed()) {
        win.webContents.send('dsh:switch-version-progress', { level: 'error', message: '版本切换失败: ' + (error.message || error) });
      }
      throw error;
    }
  });

  ipcMain.handle('dsh:doctor', async () => {
    const { execa } = await import('execa');
    const { isDSHInstalled, getDSHVersion, DSH_PATHS } = await loadCore();

    const results = [];

    // Node.js
    results.push({
      name: 'Node.js 版本',
      status: 'ok',
      message: process.version,
    });

    // npm
    try {
      const npmResult = await execa('npm', ['--version'], { reject: false, timeout: 10000, windowsHide: true });
      results.push({
        name: 'npm 版本',
        status: npmResult.stdout ? 'ok' : 'error',
        message: npmResult.stdout?.trim() || '未找到 npm',
        fix: npmResult.stdout ? null : '请安装 Node.js（自带 npm）',
      });
    } catch {
      results.push({ name: 'npm 版本', status: 'error', message: 'npm 检查失败', fix: '请安装 Node.js' });
    }

    // pnpm
    try {
      const pnpmResult = await execa('pnpm', ['--version'], { reject: false, timeout: 10000, windowsHide: true });
      results.push({
        name: 'pnpm 版本',
        status: pnpmResult.stdout ? 'ok' : 'warning',
        message: pnpmResult.stdout?.trim() || '未安装 pnpm',
        fix: pnpmResult.stdout ? null : '插件管理需要 pnpm，可在"安装/升级"页一键安装',
      });
    } catch {
      results.push({ name: 'pnpm 版本', status: 'warning', message: '未安装 pnpm', fix: '插件管理需要 pnpm，可在"安装/升级"页一键安装' });
    }

    // DSH 安装
    const installed = await isDSHInstalled();
    results.push({
      name: 'DSH 安装',
      status: installed ? 'ok' : 'error',
      message: installed ? `已安装 ${await getDSHVersion()}` : '未安装',
      fix: installed ? null : '请点击"安装 DSH"按钮',
    });

    // DSH 目录
    results.push({
      name: 'DSH 主目录',
      status: existsSync(DSH_PATHS.home) ? 'ok' : 'warning',
      message: DSH_PATHS.home,
    });

    // GitHub API（直连失败时用 DoH 解析真实 IP 兜底，绕过 DNS 污染）
    try {
      let resp = null;
      try {
        resp = await fetch('https://api.github.com', {
          headers: { 'User-Agent': 'dsh-manager' },
        });
      } catch {}
      if (!resp || !resp.ok) {
        // DoH 兜底：系统 DNS 被污染时，用 DoH 解析真实 IP 直连
        try {
          const coreMod = await loadCore();
          const { resolveViaDoh, fetchViaDoh } = coreMod;
          const ips = await resolveViaDoh('api.github.com');
          if (ips && ips.length) {
            resp = await fetchViaDoh('https://api.github.com', {
              ip: ips[0],
              timeoutMs: 15_000,
              headers: { 'User-Agent': 'dsh-manager' },
            });
          }
        } catch {}
      }
      results.push({
        name: 'GitHub API',
        status: resp && resp.ok ? 'ok' : 'warning',
        message: resp && resp.ok ? '可访问' : (resp ? `状态码: ${resp.status}` : '无法访问，插件市场可能受限'),
      });
    } catch {
      results.push({
        name: 'GitHub API',
        status: 'warning',
        message: '无法访问，插件市场可能受限',
      });
    }

    return results;
  });

  // ====== 插件市场 ======
  ipcMain.handle('marketplace:search', async (_, query, page = 1) => {
    try {
      const { PluginRegistry } = await loadMarketplace();
      const registry = new PluginRegistry();
      return await registry.search({ query, page, perPage: 30, forceRefresh: page === 1 });
    } catch (error) {
      console.warn('插件市场搜索失败，返回精选插件降级:', error.message);
      // 返回空数组，让渲染进程使用本地精选插件降级
      return [];
    }
  });

  ipcMain.handle('marketplace:plugin-details', async (_, fullName) => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.getPluginDetails(fullName);
  });

  ipcMain.handle('marketplace:install-plugin', async (_, source) => {
    const { PluginInstaller } = await loadMarketplace();
    const installer = new PluginInstaller({
      onProgress: (data) => {
        // 将插件安装日志推送到渲染进程，驱动实时进度提示
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('dsh:plugin-install-progress', data);
        }
      },
    });
    try {
      return await installer.install(source, { fromMarketplace: true });
    } catch (error) {
      // 透传 execa 的 stderr 细节，便于排查
      const detail = error?.stderr ? `\n${String(error.stderr).trim().slice(0, 500)}` : '';
      throw new Error(`${error?.message || '插件安装失败'}${detail}`);
    }
  });

  ipcMain.handle('marketplace:uninstall-plugin', async (_, pluginId) => {
    const { PluginInstaller } = await loadMarketplace();
    const installer = new PluginInstaller();
    return await installer.uninstall(pluginId);
  });

  ipcMain.handle('marketplace:local-plugins', async (_, forceRefresh = false) => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return registry.getLocalPlugins(forceRefresh);
  });

  ipcMain.handle('marketplace:composed-plugins', async (_, profile = 'web', forceRefresh = false) => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.getComposedPlugins(profile, forceRefresh);
  });

  ipcMain.handle('marketplace:diagnose-plugins', async (_, profile = 'web') => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return registry.diagnoseInvalidPlugins(profile);
  });

  ipcMain.handle('marketplace:fix-plugins', async (_, profile = 'web') => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.fixInvalidPlugins(profile);
  });

  ipcMain.handle('marketplace:check-updates', async () => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.checkAllUpdates();
  });

  // ====== 批量安装 ======
  ipcMain.handle('marketplace:batch-install', async (_, sources = []) => {
    const { PluginManager } = await loadMarketplace();
    const win = getMainWindow();
    const manager = new PluginManager({
      onProgress: (data) => {
        // 将批量安装中每条插件的进度推送到渲染进程
        if (win && !win.isDestroyed()) {
          win.webContents.send('dsh:plugin-install-progress', data);
        }
      },
    });
    return await manager.batchInstall(sources);
  });

  // ====== 本地目录选择 ======
  ipcMain.handle('marketplace:pick-plugin-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择插件目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 技能管理：选择本地技能目录
  ipcMain.handle('skills:pick-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择技能目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('marketplace:enable-plugin', async (_, pluginId) => {
    const { PluginManager } = await loadMarketplace();
    const manager = new PluginManager();
    return await manager.enable(pluginId);
  });

  ipcMain.handle('marketplace:disable-plugin', async (_, pluginId) => {
    const { PluginManager } = await loadMarketplace();
    const manager = new PluginManager();
    return await manager.disable(pluginId);
  });

  // ====== 配置 ======
  ipcMain.handle('config:get-all', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.read();
  });

  ipcMain.handle('config:get', async (_, key) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.get(key);
  });

  ipcMain.handle('config:set', async (_, key, value) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    await config.set(key, value);
    return { success: true };
  });

  ipcMain.handle('config:delete', async (_, key) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    await config.delete(key);
    return { success: true };
  });

  ipcMain.handle('config:llm-providers', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    // 打开 LLM 设置页即自动迁移历史错误命名空间（llm-openai-compatible 等 DSH 不读的段）
    // 搬到 llm-pi-ai.providers，并清洗 apiKeyEnv/models，让 DSH 真正读取到配置
    try { await config.migrateLLMProviders(); } catch (migErr) { console.warn('[dsh-manager] migrateLLMProviders:', migErr?.message); }
    return await config.listLLMProviders();
  });

  ipcMain.handle('config:write', async (_, configData) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    await config.write(configData);
    return { success: true };
  });

  // ====== AI 生图（直接调 OpenAI 兼容 /images/generations，保存到本地） ======
  ipcMain.handle('imagegen:generate', async (_, opts) => {
    const { generateImage } = await loadCore();
    try {
      const result = await generateImage(opts || {});
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e), code: (e && e.code) || 'UNKNOWN' };
    }
  });
  ipcMain.handle('imagegen:image-dir', async () => {
    const { getImageSaveDir } = await loadCore();
    return { dir: getImageSaveDir() };
  });
  // 读取本地图片转 data URL（供 CSP data: 预览，避免开放 file: 协议）
  ipcMain.handle('imagegen:read-image', async (_, filePath) => {
    try {
      const { getImageSaveDir } = await loadCore();
      // 安全白名单：仅允许读取图片保存目录内的图片文件，防止任意文件读取（含 ~/.dsh 凭据）
      const ext = (filePath || '').split('.').pop().toLowerCase();
      const allowedExt = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
      if (!allowedExt.includes(ext)) {
        return { success: false, error: '仅支持读取 png/jpg/jpeg/webp/gif 图片' };
      }
      const resolved = resolve(filePath || '');
      const saveDir = resolve(getImageSaveDir());
      if (resolved !== saveDir && !resolved.startsWith(saveDir + sep)) {
        return { success: false, error: '只允许读取图片保存目录内的文件' };
      }
      const st = statSync(resolved);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) {
        return { success: false, error: '文件不存在或超过 20MB 限制' };
      }
      const buf = readFileSync(resolved);
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
      return { success: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  });
  ipcMain.handle('imagegen:open-folder', async () => {
    const { getImageSaveDir } = await loadCore();
    const dir = getImageSaveDir();
    try {
      const err = await shell.openPath(dir);
      return { success: !err, error: err || '' };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('config:agent-presets', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.listAgentPresets();
  });

  ipcMain.handle('config:update-llm-provider', async (_, name, providerConfig, adapter) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    // 使用 DSH 官方格式存储（settings.llm-<adapter>.providers.<name>）
    const result = await config.saveLLMProvider(name, providerConfig, adapter);
    return { success: true, ...result };
  });

  ipcMain.handle('config:delete-llm-provider', async (_, name) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    // 使用 DSH 官方格式删除（兼容新旧两种格式）
    const result = await config.removeLLMProvider(name);
    return { success: true, ...result };
  });

  // ====== LLM 能力路由（按能力自动切换模型） ======
  ipcMain.handle('llm-routing:get', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.getLLMRouting();
  });

  ipcMain.handle('llm-routing:save', async (_, routing) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.saveLLMRouting(routing);
  });

  ipcMain.handle('llm-routing:models', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.listCapabilityModels();
  });

  ipcMain.handle('llm-routing:apply-default', async (_, capability) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.applyDefaultModel(capability);
  });

  ipcMain.handle('llm-routing:resolve', async (_, capability) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.resolveCapability(capability);
  });

  // ====== 内置能力路由插件（真正让能力路由在 DSH 生效的插件） ======
  ipcMain.handle('llm-routing:plugin-status', async (_, profile = 'web') => {
    const { isCapabilityRouterInstalled, detectNodeRuntime } = await loadCore();
    let node = null;
    try { node = await detectNodeRuntime(); } catch {}
    return { installed: isCapabilityRouterInstalled(profile), node };
  });

  // 读取能力路由插件的运行时事件日志（~/.dsh/manager/capability-router.log）。
  // 插件每次「加载成功 / 挂载 agent / 实际切换模型」都会写一行，用户可在 UI 看到
  // 「这次请求从哪个模型切到哪个模型」的真实记录——解决"路由是否生效不清楚"。
  ipcMain.handle('llm-routing:read-log', async (_, opts = {}) => {
    try {
      const { DSH_PATHS } = await loadCore();
      const file = join(DSH_PATHS.home, 'manager', 'capability-router.log');
      if (!existsSync(file)) return { exists: false, lines: [], path: file, message: '尚无路由日志（插件未加载或尚未触发过路由）' };
      const raw = readFileSync(file, 'utf-8');
      const maxLines = Number(opts && opts.maxLines) || 80;
      const all = raw.split(String.fromCharCode(10)).filter(function (l) { return l.trim().length > 0; });
      const lines = all.slice(-maxLines);
      return { exists: true, lines, path: file, total: all.length };
    } catch (err) {
      return { exists: false, lines: [], error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('llm-routing:plugin-install', async (_, profile = 'web') => {
    const { installCapabilityRouter } = await loadCore();
    const result = await installCapabilityRouter(profile);
    return result;
  });

  ipcMain.handle('llm-routing:plugin-uninstall', async (_, profile = 'web') => {
    const { uninstallCapabilityRouter } = await loadCore();
    const result = await uninstallCapabilityRouter(profile);
    return result;
  });

  // ====== LLM 模型获取 ======
  ipcMain.handle('llm:fetch-models', async (_, provider, baseUrl, apiKey) => {
    const defaults = {
      openai: 'https://api.openai.com/v1',
      deepseek: 'https://api.deepseek.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      google: 'https://generativelanguage.googleapis.com/v1beta',
      azure: '',
      ollama: 'http://localhost:11434/v1',
      'openai-compatible': 'https://api.openai.com/v1',
    };
    let base = (baseUrl || defaults[provider] || 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (!base) return { success: false, error: '请先填写 API Base URL（Azure 需填写 endpoint）' };
    // 安全校验：仅 http/https、禁止 URL 内嵌凭据、回环地址仅放行 ollama 默认端口（防 SSRF 内网探测）
    try {
      const u = new URL(base);
      if (!['http:', 'https:'].includes(u.protocol)) {
        return { success: false, error: 'API Base URL 仅支持 http/https 协议' };
      }
      if (u.username || u.password) {
        return { success: false, error: 'API Base URL 不允许包含用户名/密码' };
      }
      const host = u.hostname.replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
      const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
      if (isLoopback && provider !== 'ollama') {
        return { success: false, error: '回环地址仅允许 ollama 使用' };
      }
      if (provider === 'ollama' && isLoopback && u.port && u.port !== '11434') {
        return { success: false, error: 'ollama 仅允许默认端口 11434' };
      }
    } catch {
      return { success: false, error: 'API Base URL 格式无效' };
    }
    const hasVersion = /\/v\d+(\.\d+)?$/.test(base);
    const candidates = hasVersion ? [base + '/models'] : [base + '/v1/models', base + '/models'];
    let lastErr = '';
    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + (apiKey || ''), 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) { lastErr = 'HTTP ' + resp.status + ' ' + resp.statusText + '（' + url + '）'; continue; }
        const data = await resp.json();
        const models = (data.data || []).map(m => ({
          id: m.id,
          ownedBy: m.owned_by || '',
          created: m.created ? new Date(m.created * 1000).toISOString() : '',
        })).sort((a, b) => a.id.localeCompare(b.id));
        return { success: true, models, count: models.length, sourceUrl: url };
      } catch (e) {
        lastErr = e.message + '（' + url + '）';
        // 继续尝试下一个候选 URL
      }
    }
    return { success: false, error: lastErr || '无法连接到模型服务，请检查 API Base URL 和 Key', candidates };
  });

  // ====== 配置备份/还原 ======
  ipcMain.handle('config:create-backup', async (_, reason) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.createBackup(reason);
  });

  ipcMain.handle('config:list-backups', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.listBackups('settings');
  });

  ipcMain.handle('config:restore-backup', async (_, nameOrIndex) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.restoreBackup(nameOrIndex);
  });

  ipcMain.handle('config:validate', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.checkConfig();
  });


  // ====== MCP 服务端管理 ======
  ipcMain.handle('mcp:list', async (_, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile });
    return mgr.list(profile);
  });

  ipcMain.handle('mcp:get', async (_, serverName, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile });
    return mgr.get(serverName);
  });

  ipcMain.handle('mcp:add', async (_, config) => {
    const { MCPServerManager } = await loadCore();
    // profile 作为独立参数传递，避免污染 config
    const prof = config && config.__profile ? config.__profile : 'web';
    const clean = { ...config };
    delete clean.__profile;
    const mgr = new MCPServerManager({ profile: prof });
    return await mgr.add(clean);
  });

  ipcMain.handle('mcp:remove', async (_, serverName, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile });
    return await mgr.remove(serverName);
  });


  // ====== MCP 增强：JSON 导入 / 导出 / 备份 ======
  ipcMain.handle('mcp:import-json', async (_, jsonText, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile: profile || 'web' });
    return mgr.convertJsonToYaml(jsonText);
  });

  ipcMain.handle('mcp:apply-import', async (_, servers, options) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile: (options && options.__profile) || 'web' });
    const opts = { ...options };
    delete opts.__profile;
    return await mgr.importServers(servers, opts);
  });

  ipcMain.handle('mcp:export-json', async (_, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile: profile || 'web' });
    return mgr.exportJson();
  });

  ipcMain.handle('mcp:backup', async (_, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile: profile || 'web' });
    return await mgr.backup();
  });

  ipcMain.handle('mcp:list-backups', async (_, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile: profile || 'web' });
    return await mgr.listBackups();
  });

  // ====== MCP 市场搜索（本地注册表） ======
  ipcMain.handle('mcp:search-market', async (_, query, category) => {
    const { searchMcpMarket, mcpMarketStats } = await import('../packages/marketplace/src/mcp-registry.js');
    const results = searchMcpMarket(query, category);
    const stats = mcpMarketStats();
    return { results, stats };
  });

  // ====== 技能管理 ======
  ipcMain.handle('skills:list', async (_, filter) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.list(filter || {});
  });

  ipcMain.handle('skills:get', async (_, name) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.get(name);
  });

  ipcMain.handle('skills:create', async (_, input) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.create(input);
  });

  ipcMain.handle('skills:update', async (_, name, patch) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.update(name, patch);
  });

  ipcMain.handle('skills:delete', async (_, name) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.remove(name);
  });

  ipcMain.handle('skills:toggle', async (_, name, kind, value) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.toggleInvocation(name, kind, value);
  });

  ipcMain.handle('skills:import-github', async (_, url, options) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return await mgr.importFromGitHub(url, options || {});
  });

  ipcMain.handle('skills:import-dir', async (_, srcPath, options) => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.importFromDirectory(srcPath, options || {});
  });

  ipcMain.handle('skills:stats', async () => {
    const { SkillManager } = await loadCore();
    const mgr = new SkillManager();
    return mgr.stats();
  });

  // ====== 总提示词管理 (Master Prompts) ======
  ipcMain.handle('prompts:list', async (_, filter) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.list(filter || {});
  });

  ipcMain.handle('prompts:get', async (_, id) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.get(id);
  });

  ipcMain.handle('prompts:create', async (_, input) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.create(input);
  });

  ipcMain.handle('prompts:update', async (_, id, patch) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.update(id, patch);
  });

  ipcMain.handle('prompts:delete', async (_, id) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.delete(id);
  });

  ipcMain.handle('prompts:toggle', async (_, id, enabled) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.toggle(id, enabled);
  });

  ipcMain.handle('prompts:render', async (_, options) => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.render(options || {});
  });

  ipcMain.handle('prompts:stats', async () => {
    const { MasterPromptManager } = await loadCore();
    const mgr = new MasterPromptManager();
    return mgr.stats();
  });

  // ====== GitHub Skill 搜索（可搜索 skill 项目仓库） ======
  ipcMain.handle('skills:search-github', async (_, query, page = 1) => {
    try {
      const q = (query || '').trim();
      if (!q) return { success: false, error: '请输入搜索关键词', items: [] };
      // GitHub Search API：搜索仓库（skills 相关关键词组合）
      const queries = [
        `${q} skill in:name,description,readme sort:stars-desc`,
        `dsh-skill OR agent-skill OR claude-skill ${q} sort:stars-desc`,
      ];
      const results = [];
      const seen = new Set();
      for (const searchQ of queries) {
        try {
          const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(searchQ) + '&per_page=30&page=' + page;
          const searchHeaders = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dsh-manager' };
          // 直连优先；失败/非 2xx 时 DoH 兜底（绕过 DNS 污染，浏览器/Chromium fetch 无法自定义 DNS）
          let resp = null;
          try {
            resp = await fetch(url, { headers: searchHeaders, signal: AbortSignal.timeout(15000) });
          } catch {}
          if (!resp || !resp.ok) {
            try {
              const coreMod = await loadCore();
              if (coreMod.tryFetchViaDoh) {
                resp = await coreMod.tryFetchViaDoh(url, { timeoutMs: 15000, headers: searchHeaders });
              }
            } catch {}
          }
          if (!resp || !resp.ok) continue;
          const data = await resp.json();
          for (const repo of (data.items || [])) {
            const fullName = repo.full_name || '';
            if (seen.has(fullName)) continue;
            seen.add(fullName);
            results.push({
              fullName,
              name: repo.name,
              description: repo.description || '',
              stars: repo.stargazers_count || 0,
              forks: repo.forks_count || 0,
              updatedAt: repo.updated_at || '',
              htmlUrl: repo.html_url || '',
              topics: repo.topics || [],
              license: repo.license?.spdx_id || '',
              defaultBranch: repo.default_branch || 'main',
            });
          }
        } catch {}
      }
      return { success: true, items: results, count: results.length };
    } catch (error) {
      return { success: false, error: error.message, items: [] };
    }
  });

  // ====== 系统 ======
  ipcMain.handle('shell:open-external', async (_, url) => {
    if (!url) return { success: false, error: 'URL 为空' };
    // 仅允许 http/https/mailto 协议，防止 file:/// smb:// 自定义协议被利用
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return { success: false, error: '不允许的协议: ' + parsed.protocol };
      }
    } catch {
      return { success: false, error: '无效的 URL' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('app:get-version', () => {
    // 优先通过 Electron app.getVersion() 获取（打包后版本自动匹配），文件读取仅作开发兜底
    try {
      const v = app.getVersion();
      if (v && v !== '0.0.0' && v !== '0.0.0.0') return v;
    } catch {}
    try {
      const pkg = JSON.parse(
        readFileSync(join(__dirname, '../package.json'), 'utf-8')
      );
      return pkg.version;
    } catch {
      return '0.0.0';
    }
  });


  // ====== 剪贴板 ======
  ipcMain.handle('app:copy-to-clipboard', async (_, text) => {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  ipcMain.handle('app:check-pnpm', async () => {
    const { checkPnpm, getPnpmInstallGuide } = await loadCore();
    const result = await checkPnpm();
    return {
      ...result,
      installGuide: getPnpmInstallGuide(),
    };
  });

  ipcMain.handle('app:install-pnpm', async () => {
    try {
      const { execa } = await import('execa');
      const win = getMainWindow();
      const pushProgress = makeEnvPushProgress(win);
      pushProgress({ level: 'info', message: '开始安装 pnpm（npm install -g pnpm）...' });

      // 便携版 Node（最小化安装）不在系统 PATH，注入运行时环境让 npm 可被找到
      const { buildCommandEnv } = await loadCore();
      const { env: runtimeEnv } = buildCommandEnv();

      // 流式安装 pnpm（跨平台通用）
      const child = execa('npm', ['install', '-g', 'pnpm'], {
        timeout: 180_000,
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: runtimeEnv,
      });
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) pushProgress({ level: 'info', message: text });
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) pushProgress({ level: 'warn', message: text });
      });
      const result = await child;

      // 安装后验证
      const { checkPnpm } = await loadCore();
      const verify = await checkPnpm();
      if (verify.installed) {
        return { success: true, version: verify.version, message: `pnpm ${verify.version} 安装成功` };
      }
      return {
        success: false,
        message: '安装命令执行完成，但 pnpm 仍不可用',
        detail: result.stderr || result.stdout || '',
      };
    } catch (error) {
      console.error('[dsh-manager] 安装 pnpm 失败: ' + (error?.stack || error?.message || error));
      return { success: false, error: error.message };
    }
  });

  // ====== 基础环境检测（空白环境部署支持） ======
  // ====== 便携版 Node（低配置最小化安装） ======
  ipcMain.handle('app:install-nodejs-portable', async (_, opts = {}) => {
    try {
      const win = getMainWindow();
      const pushProgress = makeEnvPushProgress(win);
      pushProgress({ level: 'info', message: '开始安装便携版 Node.js（镜像下载）...' });
      const { installPortableNode } = await loadCore();
      const result = await installPortableNode({
        version: opts.version || undefined,
        onProgress: (m) => pushProgress({ level: 'info', message: m }),
      });
      // 安装后验证检测链路（确认界面能识别便携版 Node / npm）
      try {
        const { checkNode, checkNpm, checkPortableNode } = await loadCore();
        const [node, npm, portable] = await Promise.all([checkNode(), checkNpm(), checkPortableNode()]);
        console.log('[dsh-manager] 便携版安装后检测: node=' + (node.installed ? 'OK ' + node.version + ' source=' + node.source : 'FAIL ' + (node.error || '未安装')) + ' npm=' + (npm.installed ? 'OK ' + npm.version + ' source=' + npm.source : 'FAIL ' + (npm.error || '未安装')) + ' portable=' + (portable.installed ? 'OK ' + portable.version : 'FAIL'));
        try {
          const { getSystemDiagnostics } = await loadCore();
          const diag = await getSystemDiagnostics();
          console.log('[dsh-manager] 便携版安装完成后系统诊断: ' + JSON.stringify(diag));
        } catch (de) { console.warn('[dsh-manager] 诊断采集失败: ' + (de?.message || de)); }
      } catch (e) {
        console.warn('[dsh-manager] 便携版安装后检测异常: ' + (e?.message || e));
      }
      return { success: true, ...result, message: `便携版 Node ${result.version} 安装成功` };
    } catch (error) {
      console.error('[dsh-manager] 便携版 Node 安装失败: ' + (error?.stack || error?.message || error));
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('app:uninstall-nodejs-portable', async () => {
    const { uninstallPortableNode } = await loadCore();
    return await uninstallPortableNode();
  });

  ipcMain.handle('app:get-portable-node', async () => {
    const { getPortableNodeInfo } = await loadCore();
    return await getPortableNodeInfo();
  });

  ipcMain.handle('app:check-env', async () => {
    const { checkEnvironment, getNodeInstallGuide, getPnpmInstallGuide, getGitInstallGuide } = await loadCore();
    const env = await checkEnvironment();
    return {
      ...env,
      nodeInstallGuide: getNodeInstallGuide(),
      pnpmInstallGuide: getPnpmInstallGuide(),
      gitInstallGuide: getGitInstallGuide(),
    };
  });

  ipcMain.handle('app:install-nodejs', async () => {
    try {
      const { execa } = await import('execa');
      const platform = process.platform;
      const win = getMainWindow();
      const pushProgress = makeEnvPushProgress(win);
      pushProgress({ level: 'info', message: `开始安装 Node.js（平台: ${platform}）...` });

      const cmdOptions = { timeout: 300_000, reject: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
      let child;
      if (platform === 'win32') {
        child = execa('winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '--silent', '--accept-source-agreements', '--accept-package-agreements'], cmdOptions);
      } else if (platform === 'darwin') {
        child = execa('brew', ['install', 'node'], cmdOptions);
      } else {
        child = execa('sudo', ['apt-get', 'install', '-y', 'nodejs', 'npm'], cmdOptions);
      }
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) pushProgress({ level: 'info', message: text });
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) pushProgress({ level: 'warn', message: text });
      });
      const result = await child;
      console.log('[dsh-manager] Node 安装命令完成: exit=' + result.exitCode);
      if (result.stderr) console.warn('[dsh-manager] Node 安装 stderr: ' + String(result.stderr).trim().slice(0, 1500));

      // winget/brew/apt 安装后，本进程 PATH 仍是启动时快照（不含新装命令路径），
      // 先从注册表刷新进程 PATH 再检测，避免"装好了却仍报命令不可用"
      try {
        const { refreshSystemPath } = await loadCore();
        const beforePath = process.env.PATH || '';
        const afterPath = await refreshSystemPath();
        console.log('[dsh-manager] PATH 刷新前: ' + beforePath.slice(0, 300));
        console.log('[dsh-manager] PATH 刷新后: ' + afterPath.slice(0, 300));
      } catch (e) { console.warn("[dsh-manager] 刷新 PATH 失败:", e?.message); }

      const { checkNode, checkNpm } = await loadCore();
      const [node, npm] = await Promise.all([checkNode(), checkNpm()]);
      console.log('[dsh-manager] 安装后检测: node=' + (node.installed ? 'OK ' + node.version : 'FAIL ' + (node.error || '未安装')) + ' npm=' + (npm.installed ? 'OK ' + npm.version : 'FAIL ' + (npm.error || '未安装')));
      try {
        const { getSystemDiagnostics } = await loadCore();
        const diag = await getSystemDiagnostics();
        console.log('[dsh-manager] 安装完成后系统诊断: ' + JSON.stringify(diag));
      } catch (e) { console.warn('[dsh-manager] 诊断采集失败: ' + (e?.message || e)); }
      if (node.installed) {
        return { success: true, nodeVersion: node.version, npmVersion: npm.version, message: `Node.js ${node.version} 安装成功${npm.version ? `（npm ${npm.version}）` : ''}` };
      }
      return {
        success: false,
        message: '安装命令执行完成，但 Node.js 仍不可用（可能需重启 DSH Manager 使 PATH 生效，或使用便携版 Node 最小化安装）',
        detail: result.stderr || result.stdout || '',
      };
    } catch (error) {
      console.error('[dsh-manager] 正常安装 Node 失败: ' + (error?.stack || error?.message || error));
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('app:install-git', async () => {
    try {
      const { execa } = await import('execa');
      const platform = process.platform;
      const win = getMainWindow();
      const pushProgress = makeEnvPushProgress(win);
      pushProgress({ level: 'info', message: `开始安装 git（平台: ${platform}）...` });

      const cmdOptions = { timeout: 300_000, reject: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
      let child;
      if (platform === 'win32') {
        child = execa('winget', ['install', '--id', 'Git.Git', '--silent', '--accept-source-agreements', '--accept-package-agreements'], cmdOptions);
      } else if (platform === 'darwin') {
        child = execa('brew', ['install', 'git'], cmdOptions);
      } else {
        child = execa('sudo', ['apt-get', 'install', '-y', 'git'], cmdOptions);
      }
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) pushProgress({ level: 'info', message: text });
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) pushProgress({ level: 'warn', message: text });
      });
      const result = await child;

      // winget/brew/apt 安装后刷新进程 PATH，再检测 git
      try {
        const { refreshSystemPath } = await loadCore();
        await refreshSystemPath();
      } catch (e) { console.warn("[dsh-manager] 刷新 PATH 失败:", e?.message); }

      const { checkGit } = await loadCore();
      const git = await checkGit();
      if (git.installed) {
        return { success: true, version: git.version, message: `git ${git.version} 安装成功` };
      }
      return {
        success: false,
        message: '安装命令执行完成，但 git 仍不可用（可能需重启 DSH Manager 使 PATH 生效）',
        detail: result.stderr || result.stdout || '',
      };
    } catch (error) {
      console.error('[dsh-manager] 安装 git 失败: ' + (error?.stack || error?.message || error));
      return { success: false, error: error.message };
    }
  });

  // ====== 调试日志 ======
  ipcMain.handle('debug:get-log', async () => {
    const { readLog } = await import('./debug-logger.js');
    return readLog();
  });

  ipcMain.handle('debug:clear-log', async () => {
    const { clearLog } = await import('./debug-logger.js');
    clearLog();
    return { success: true };
  });

  ipcMain.handle('debug:get-log-path', async () => {
    const { getLogPath, isDebugEnabled } = await import('./debug-logger.js');
    return { path: getLogPath(), enabled: isDebugEnabled() };
  });

  ipcMain.handle('debug:is-enabled', async () => {
    const { isDebugEnabled } = await import('./debug-logger.js');
    return isDebugEnabled();
  });

  ipcMain.handle('debug:write-log', async (_, level, message) => {
    const { writeLog } = await import('./debug-logger.js');
    writeLog(level || 'info', String(message || ''));
    return { success: true };
  });

  // ====== 应用版本更新检查 ======
  ipcMain.handle('app:check-app-update', async () => {
    const { writeLog } = await import('./debug-logger.js');
    const { readFileSync, existsSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // 读取当前版本
    const __dirname = dirname(fileURLToPath(import.meta.url));
    let currentVersion = '0.0.0';
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
      currentVersion = pkg.version || '0.0.0';
    } catch {}

    writeLog('info', '[更新检查] 当前版本: ' + currentVersion);

    // 从 GitHub 获取最新 release
    const GITHUB_URL = 'https://api.github.com/repos/linhut/dsh-manager/releases/latest';
    // 代理候选
    const PROXIES = ['https://gh-proxy.com/']; // gh-proxy.com 是唯一验证可用的代理

    // 加载 DoH 能力（失败时降级跳过 DoH 候选，不阻断更新检查）
    let resolveViaDoh = null;
    let fetchViaDoh = null;
    try {
      const coreMod = await loadCore();
      resolveViaDoh = coreMod.resolveViaDoh;
      fetchViaDoh = coreMod.fetchViaDoh;
    } catch (e) {
      writeLog('warn', '[更新检查] core 加载失败，跳过 DoH 直连: ' + (e?.message || e));
    }

    let lastError = null;
    // 候选：[GitHub 直连, DoH 直连(加载成功时), gh-proxy 代理]
    // DoH 直连用应用内置解析真实 IP（绕过 DNS 污染），失败自动回落代理链
    const updateCandidates = [
      { url: GITHUB_URL },
      ...(resolveViaDoh && fetchViaDoh ? [{ url: GITHUB_URL, doh: true }] : []),
      ...PROXIES.map(p => ({ url: p + GITHUB_URL })),
    ];
    for (const cand of updateCandidates) {
      try {
        writeLog('info', '[更新检查] 请求: ' + cand.url + (cand.doh ? ' (DoH直连)' : ''));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let resp;
        if (cand.doh) {
          const hostname = new URL(cand.url).hostname;
          const ips = await resolveViaDoh(hostname, { raceTimeoutMs: 4000 });
          if (!ips || !ips.length) { clearTimeout(timeout); lastError = 'DoH 解析失败'; continue; }
          resp = await fetchViaDoh(cand.url, {
            ip: ips[0],
            timeoutMs: 15_000,
            signal: controller.signal,
            headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dsh-manager/' + currentVersion },
          });
        } else {
          resp = await fetch(cand.url, {
            headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dsh-manager/' + currentVersion },
            signal: controller.signal,
          });
        }
        clearTimeout(timeout);
        if (!resp.ok) { lastError = 'HTTP ' + resp.status; continue; }
        const data = await resp.json();
        const latestTag = (data.tag_name || '').replace(/^v/, '');
        if (!latestTag) { lastError = '无版本标签'; continue; }

        // 提取 .exe 下载资产
        let asset = data.assets && data.assets.find(a => a.name && a.name.endsWith('.exe') && a.name.includes('Setup'));
        const downloadName = asset ? asset.name : ('DSH Manager Setup ' + latestTag + '.exe');
        const downloadUrl = asset ? asset.browser_download_url : 'https://github.com/linhut/dsh-manager/releases/download/v' + latestTag + '/' + downloadName;

        // 构建代理下载链接（gh-proxy.com 自动加速 + github.akams.cn 网站手动加速）
        const proxyUrls = [
          ...PROXIES.map(p => p + downloadUrl),
          'https://github.akams.cn/?url=' + encodeURIComponent(downloadUrl),
        ];

        // 简易版本比较（去除非数字后缀如 -debug -test）
        const normalizeVer = (v) => {
          const m = v.match(/^(\d+\.\d+\.\d+)/);
          return m ? m[1] : v;
        };
        const currentNorm = normalizeVer(currentVersion);
        const latestNorm = normalizeVer(latestTag);
        const hasUpdate = latestNorm !== currentNorm;

        writeLog('info', '[更新检查] 最新: ' + latestTag + ' 当前: ' + currentVersion + ' 有更新: ' + hasUpdate);
        return {
          hasUpdate,
          currentVersion,
          latestVersion: latestTag,
          downloadUrl,
          proxyUrls,
          releaseNotes: (data.body || '').slice(0, 2000),
          releaseUrl: data.html_url || '',
          publishedAt: data.published_at || '',
        };
      } catch (e) {
        lastError = e.message;
        writeLog('warn', '[更新检查] 请求失败: ' + e.message);
      }
    }

    writeLog('error', '[更新检查] 全部失败: ' + lastError);
    return { hasUpdate: false, currentVersion, latestVersion: null, error: lastError };
  });

  // ====== 依赖完整性检查与修复 ======
  ipcMain.handle('deps:check-integrity', async (_, profile, options) => {
    const { checkProfileIntegrity } = await loadCore();
    const result = await checkProfileIntegrity(profile || 'web', options || {});
    return result;
  });

  ipcMain.handle('deps:repair', async (_, profile, options) => {
    const { repairProfileFromGlobal } = await loadCore();
    const result = await repairProfileFromGlobal(profile || 'web', options || {});
    return result;
  });

  ipcMain.handle('deps:repair-all', async (_, options) => {
    const { repairAllProfiles } = await loadCore();
    const result = await repairAllProfiles(options || {});
    return result;
  });

  ipcMain.handle('deps:health', async (_, profile) => {
    const { getDependencyHealth } = await loadCore();
    const result = await getDependencyHealth(profile || 'web');
    return result;
  });

  ipcMain.handle('deps:classify', async (_, name) => {
    const { isSystemComponent, isExternalPlugin, classifyPackage } = await loadCore();
    return {
      name,
      system: isSystemComponent(name),
      external: isExternalPlugin(name),
      category: classifyPackage(name),
    };
  });
}