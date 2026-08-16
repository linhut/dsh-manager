/**
 * DSH Manager - IPC 通信处理
 * 
 * 处理渲染进程的请求，调用核心逻辑
 */

import { shell, BrowserWindow } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 动态导入核心模块
let core, marketplace;

async function loadCore() {
  if (!core) {
    core = await import('@dsh-manager/core');
  }
  return core;
}

async function loadMarketplace() {
  if (!marketplace) {
    marketplace = await import('@dsh-manager/marketplace');
  }
  return marketplace;
}

/**
 * 注册所有 IPC 处理器
 */
export function registerIpcHandlers(ipcMain, getMainWindow) {
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

  ipcMain.handle('dsh:install', async (_, version, registry) => {
    const { DSHInstaller } = await loadCore();
    const installer = new DSHInstaller({ registry });
    return await installer.install(version);
  });

  ipcMain.handle('dsh:uninstall', async () => {
    const { DSHInstaller } = await loadCore();
    const installer = new DSHInstaller();
    return await installer.uninstall();
  });

  ipcMain.handle('dsh:upgrade', async () => {
    const { DSHInstaller } = await loadCore();
    const installer = new DSHInstaller();
    return await installer.upgrade();
  });

  ipcMain.handle('dsh:check-update', async () => {
    const { DSHVersionManager } = await loadCore();
    const vm = new DSHVersionManager();
    return await vm.checkForUpdate();
  });

  ipcMain.handle('dsh:get-versions', async () => {
    const { DSHVersionManager } = await loadCore();
    const vm = new DSHVersionManager();
    const [versions, installed] = await Promise.all([
      vm.getAvailableVersions(),
      vm.getInstalledVersions(),
    ]);
    return { versions, installed };
  });

  ipcMain.handle('dsh:doctor', async () => {
    const { execa } = await import('execa');
    const { isDSHInstalled, getDSHVersion, DSH_PATHS } = await loadCore();
    const { existsSync } = await import('node:fs');

    const results = [];

    // Node.js
    results.push({
      name: 'Node.js 版本',
      status: 'ok',
      message: process.version,
    });

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
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.search({ query, page, perPage: 30, forceRefresh: page === 1 });
  });

  ipcMain.handle('marketplace:plugin-details', async (_, fullName) => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.getPluginDetails(fullName);
  });

  ipcMain.handle('marketplace:install-plugin', async (_, source) => {
    const { PluginInstaller } = await loadMarketplace();
    const installer = new PluginInstaller();
    return await installer.install(source, { fromMarketplace: true });
  });

  ipcMain.handle('marketplace:uninstall-plugin', async (_, pluginId) => {
    const { PluginInstaller } = await loadMarketplace();
    const installer = new PluginInstaller();
    return await installer.uninstall(pluginId);
  });

  ipcMain.handle('marketplace:local-plugins', async () => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return registry.getLocalPlugins();
  });

  ipcMain.handle('marketplace:check-updates', async () => {
    const { PluginRegistry } = await loadMarketplace();
    const registry = new PluginRegistry();
    return await registry.checkAllUpdates();
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

  ipcMain.handle('config:llm-providers', async () => {
    const { DSHConfig } = await loadCore();
    const config = new DSHConfig();
    return await config.listLLMProviders();
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
      return '0.1.0';
    }
  });
}