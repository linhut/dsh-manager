/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { shell, BrowserWindow, dialog } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLog } from './debug-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/**
 * 注册所有 IPC 处理器
 */
export function registerIpcHandlers(ipcMain, getMainWindow) {
  // 跟踪最后一次启动的实际端口（用于 stop 和诊断）
  let lastActivePort = 3080;

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
    const { getDSHInfo } = await loadCore();
    return await getDSHInfo();
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
      return await installer.install(version, { tool });
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
      const { execa } = await import('execa');
      const { DSHUtils } = await loadCore();

      const dshPkgPath = await DSHUtils.getDSHPath();
      if (!dshPkgPath) {
        return { success: false, error: 'DSH 未安装，请先安装 DSH' };
      }

      // 读取 dsh package.json 获取 CLI 入口
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

      // 直接启动 node + CLI（绕过 .cmd 包装，避免 Windows 弹窗）
      // 关键修复：用 detached: true（所有平台）确保子进程脱离父进程树，
      // 不会被父进程（终端/任务计划/管理器）退出时回收杀死。
      // 旧版本 detached: !isWindows 导致 Windows 上进程挂靠在父进程树中。
      const { buildRuntimeEnv, getRuntimeConfig, findAvailablePort, testDSHHealth } = await loadCore();
      const [{ env }, rt] = await Promise.all([buildRuntimeEnv(), getRuntimeConfig()]);
      const preferredPort = rt.port && rt.port > 0 ? rt.port : 3080;

      // 端口自动检测：首选端口若被占用，自动切换到随机空闲端口
      const portResult = await findAvailablePort(preferredPort);
      const actualPort = portResult.port;
      lastActivePort = actualPort; // 记录本次实际端口，供 stop/diagnose 使用

      // 构建启动参数
      const startArgs = ['web'];
      if (actualPort !== 3080) startArgs.push('--port', String(actualPort));
      const nodeEnv = { ...env, NO_COLOR: '1' };
      if (rt.retryCount && rt.retryCount > 0) {
        nodeEnv.DSH_AGENT_MAX_RETRIES = String(rt.retryCount);
      }
      if (rt.lowMemory) {
        nodeEnv.NODE_OPTIONS = `--max-old-space-size=${rt.maxOldSpace}`;
      }
      const child = execa('node', [cliPath, ...startArgs], {
        detached: true,                // 所有平台脱离父进程树，防止被回收
        windowsHide: true,             // Windows 隐藏控制台窗口（CREATE_NO_WINDOW）
        stdio: ['ignore', 'pipe', 'pipe'],
        env: nodeEnv,
        reject: false,                 // 不抛异常，由下方统一处理失败
      });
      // execa v10 不暴露 .unref()，需通过底层 nodeChildProcess 调用
      child.nodeChildProcess?.unref();
      child.then(async result => {
        // 进程已退出（成功启动后退出或启动即失败）。短暂存活期内的非零退出视为启动失败
        if (result.exitCode !== 0 && result.failed) {
          const stderr = (result.stderr || '').toString().trim();
          writeLog('error', 'DSH 启动失败: exit=' + result.exitCode + (stderr ? ' stderr: ' + stderr.slice(0, 2000) : ''));
          // 自动诊断是否有无效插件导致启动失败（如 gongwen-skill "invalid plugin"）
          // 从 stderr 中提取失效插件 ID（更可靠：直接匹配运行时报错信息）
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
            const re = /failed to apply loader entry [^(]+\(([^)]+)\)/g;
            let m;
            while ((m = re.exec(stderr)) !== null) {
              const id = m[1].trim();
              if (id && !id.startsWith('@deepseek-ai/')) {
                invalidPlugins.push({ id, reason: '启动时加载失败（stderr 指示）' });
              }
            }
          }
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('dsh:start-error', {
              exitCode: result.exitCode,
              stderr: stderr.slice(0, 2000),
              port: actualPort,
              invalidPlugins,
            });
          }
        } else {
          writeLog('info', 'DSH 进程已退出: exit=' + result.exitCode + ' port=' + actualPort);
        }
      }).catch(err => {
        // reject:false 下极少走到这里，兜底记录
        writeLog('error', 'DSH 启动监控异常: ' + err.message);
      });
      // 短暂等待后检查 DSH 是否成功启动（最多 10 秒）
      let health = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        health = await testDSHHealth(actualPort);
        if (health.reachable) break;
      }
      return {
        success: true,
        message: 'DSH 启动命令已发送',
        port: actualPort,
        portChanged: portResult.used,
        preferredPort: preferredPort,
        reachable: health?.reachable || false,
        webUrl: 'http://127.0.0.1:' + actualPort,
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
            return { success: true, message: result.stdout || '已停止' };
          }
        }
      }
      // dsh stop 命令不可用时，降级为按端口结束进程（Windows taskkill / Unix kill）
      const { stopProcessByPort } = await loadCore();
      const fallback = await stopProcessByPort(lastActivePort);
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
    return { port: lastActivePort, defaultPort: 3080 };
  });

  // 一键修复无效插件并重启 DSH（解决 gongwen-skill "invalid plugin" 等启动失败）
  ipcMain.handle('dsh:fix-and-restart', async () => {
    try {
      // ① 修复无效插件
      const { PluginRegistry } = await loadMarketplace();
      const registry = new PluginRegistry();
      const fixResult = await registry.fixInvalidPlugins('web');

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
      const child = execa('node', [cliPath, ...startArgs], {
        detached: true,
        windowsHide: true,
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
        message: '无效插件已修复，DSH 重新启动',
        fixResult,
        port: actualPort,
        webUrl: 'http://127.0.0.1:' + actualPort,
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
    const installer = new DSHInstaller();
    const result = await installer.switchVersion(version);
    // 记录切换后的版本
    const vm = new DSHVersionManager();
    if (result.newVersion) await vm.recordVersion(result.newVersion);
    return result;
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
      const npmResult = await execa('npm', ['--version'], { reject: false, timeout: 10000 });
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
      const pnpmResult = await execa('pnpm', ['--version'], { reject: false, timeout: 10000 });
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

    // GitHub API
    try {
      const resp = await fetch('https://api.github.com', {
        headers: { 'User-Agent': 'dsh-manager' },
      });
      results.push({
        name: 'GitHub API',
        status: resp.ok ? 'ok' : 'warning',
        message: resp.ok ? '可访问' : `状态码: ${resp.status}`,
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
          win.webContents.send('plugin-install-progress', data);
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
          win.webContents.send('plugin-install-progress', data);
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
    return await config.listLLMProviders();
  });

  ipcMain.handle('config:write', async (_, configData) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    await config.write(configData);
    return { success: true };
  });

  ipcMain.handle('config:agent-presets', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.listAgentPresets();
  });

  ipcMain.handle('config:update-llm-provider', async (_, name, providerConfig) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    const { settings } = await config.read();
    if (!settings.llm) settings.llm = {};
    settings.llm[name] = providerConfig;
    await config.write(settings);
    return { success: true };
  });

  ipcMain.handle('config:delete-llm-provider', async (_, name) => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    const { settings } = await config.read();
    if (settings.llm && settings.llm[name]) {
      delete settings.llm[name];
      await config.write(settings);
    }
    return { success: true };
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

  // ====== MCP 服务端管理 ======
  ipcMain.handle('mcp:list', async (_, profile) => {
    const { MCPServerManager } = await loadCore();
    const mgr = new MCPServerManager({ profile });
    return mgr.list();
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
          const resp = await fetch(url, {
            headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dsh-manager' },
            signal: AbortSignal.timeout(15000),
          });
          if (!resp.ok) continue;
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
    return shell.openExternal(url);
  });

  ipcMain.handle('app:get-version', () => {
    try {
      const pkg = JSON.parse(
        readFileSync(join(__dirname, '../package.json'), 'utf-8')
      );
      return pkg.version;
    } catch {
      return '1.3.3';
    }
  });


  // ====== 剪贴板 ======
  ipcMain.handle('app:copy-to-clipboard', async (_, text) => {
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(text);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }),
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
      const pushProgress = (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('env-install-progress', data);
        }
      };
      pushProgress({ level: 'info', message: '开始安装 pnpm（npm install -g pnpm）...' });

      // 流式安装 pnpm（跨平台通用）
      const child = execa('npm', ['install', '-g', 'pnpm'], {
        timeout: 180_000,
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
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
      return { success: false, error: error.message };
    }
  });

  // ====== 基础环境检测（空白环境部署支持） ======
  // ====== 便携版 Node（低配置最小化安装） ======
  ipcMain.handle('app:install-nodejs-portable', async (_, opts = {}) => {
    try {
      const win = getMainWindow();
      const pushProgress = (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('env-install-progress', data);
        }
      };
      pushProgress({ level: 'info', message: '开始安装便携版 Node.js（镜像下载）...' });
      const { installPortableNode } = await loadCore();
      const result = await installPortableNode({
        version: opts.version || undefined,
        onProgress: (m) => pushProgress({ level: 'info', message: m }),
      });
      return { success: true, ...result, message: `便携版 Node ${result.version} 安装成功` };
    } catch (error) {
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
      const pushProgress = (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('env-install-progress', data);
        }
      };
      pushProgress({ level: 'info', message: `开始安装 Node.js（平台: ${platform}）...` });

      const cmdOptions = { timeout: 300_000, reject: false, stdio: ['ignore', 'pipe', 'pipe'] };
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

      const { checkNode, checkNpm } = await loadCore();
      const [node, npm] = await Promise.all([checkNode(), checkNpm()]);
      if (node.installed) {
        return { success: true, nodeVersion: node.version, npmVersion: npm.version, message: `Node.js ${node.version} 安装成功${npm.version ? `（npm ${npm.version}）` : ''}` };
      }
      return {
        success: false,
        message: '安装命令执行完成，但 Node.js 仍不可用（可能需要重启终端使 PATH 生效）',
        detail: result.stderr || result.stdout || '',
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('app:install-git', async () => {
    try {
      const { execa } = await import('execa');
      const platform = process.platform;
      const win = getMainWindow();
      const pushProgress = (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('env-install-progress', data);
        }
      };
      pushProgress({ level: 'info', message: `开始安装 git（平台: ${platform}）...` });

      const cmdOptions = { timeout: 300_000, reject: false, stdio: ['ignore', 'pipe', 'pipe'] };
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

      const { checkGit } = await loadCore();
      const git = await checkGit();
      if (git.installed) {
        return { success: true, version: git.version, message: `git ${git.version} 安装成功` };
      }
      return {
        success: false,
        message: '安装命令执行完成，但 git 仍不可用（可能需要重启终端使 PATH 生效）',
        detail: result.stderr || result.stdout || '',
      };
    } catch (error) {
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

    let lastError = null;
    for (const url of [GITHUB_URL, ...PROXIES.map(p => p + GITHUB_URL)]) {
      try {
        writeLog('info', '[更新检查] 请求: ' + url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'dsh-manager/1.2.3' },
          signal: controller.signal,
        });
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