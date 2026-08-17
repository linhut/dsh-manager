/**
 * DSH Manager - IPC 通信处理
 * 
 * 处理渲染进程的请求，调用核心逻辑
 */

import { shell, BrowserWindow, dialog } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 动态导入核心模块（使用相对路径，确保打包后可用）
let core, marketplace;

async function loadCore() {
  if (!core) {
    core = await import('../packages/core/src/index.js');
  }
  return core;
}

async function loadMarketplace() {
  if (!marketplace) {
    marketplace = await import('../packages/marketplace/src/index.js');
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
    return await installer.install(version, { tool });
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

  // ====== 进程管理 ======
  ipcMain.handle('dsh:process-info', async () => {
    const { getDSHProcessInfo } = await loadCore();
    return await getDSHProcessInfo();
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
      // 分离启动 DSH Web 服务（不阻塞主进程）
      const child = execa('dsh', ['web'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });
      child.unref();
      return { success: true, message: 'DSH 启动命令已发送' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('dsh:stop', async () => {
    try {
      const { execa } = await import('execa');
      // 通过 dsh CLI 停止 / 或直接结束进程（这里尝试优雅停止）
      const result = await execa('dsh', ['stop'], { reject: false, timeout: 10000 });
      return { success: result.exitCode === 0, message: result.stdout || '已停止' };
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

  // ====== 批量安装 ======
  ipcMain.handle('marketplace:batch-install', async (_, sources = []) => {
    const { PluginManager } = await loadMarketplace();
    const manager = new PluginManager();
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
      return '0.5.0';
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
      // 通过 npm 全局安装 pnpm（跨平台通用，无需 corepack/管理员权限的特殊要求）
      const child = await execa('npm', ['install', '-g', 'pnpm'], {
        timeout: 180_000,
        reject: false,
        stdio: 'pipe',
      });

      // 安装后验证
      const { checkPnpm } = await loadCore();
      const verify = await checkPnpm();
      if (verify.installed) {
        return { success: true, version: verify.version, message: `pnpm ${verify.version} 安装成功` };
      }
      return {
        success: false,
        message: '安装命令执行完成，但 pnpm 仍不可用',
        detail: child.stderr || child.stdout || '',
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}