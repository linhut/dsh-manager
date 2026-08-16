#!/usr/bin/env node

/**
 * dshm (dsh-manager) - DeepSeek Harness 安装与管理工具
 * 
 * 使用方式：
 *   dshm                启动交互式 TUI
 *   dshm install        安装 DSH
 *   dshm marketplace    打开插件市场
 *   dshm plugin list    列出已安装插件
 *   dshm status         查看 DSH 状态
 *   dshm doctor         系统诊断
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取版本号
function readVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

const VERSION = readVersion();

const program = new Command();

program
  .name('dshm')
  .version(VERSION, '-V, --version', '输出版本号')
  .description('🚀 DeepSeek Harness 安装与管理工具')
  .helpOption('-h, --help', '显示帮助信息');

// ====== 交互式 TUI ======
program
  .command('tui', { isDefault: true })
  .description('启动交互式终端界面（默认）')
  .action(async () => {
    const { launchTUI } = await import('./tui.js');
    await launchTUI();
  });

// ====== 安装命令 ======
const installCmd = program
  .command('install')
  .description('安装或升级 DSH');

installCmd
  .command('dsh')
  .description('安装 DeepSeek Harness')
  .option('-v, --version <version>', '指定版本号，默认最新版')
  .option('--registry <url>', '指定 npm registry 镜像源')
  .option('--verbose', '显示详细日志')
  .action(async (options) => {
    const { handleInstall } = await import('./commands/install.js');
    await handleInstall(options);
  });

installCmd
  .command('plugin')
  .description('从市场安装插件')
  .argument('<source>', '插件来源 (github:owner/repo 或 npm:package)')
  .option('--profile <profile>', '目标 profile', 'web')
  .option('--verbose', '显示详细日志')
  .action(async (source, options) => {
    const { handlePluginInstall } = await import('./commands/plugin.js');
    await handlePluginInstall(source, options);
  });

// ====== 卸载命令 ======
program
  .command('uninstall')
  .description('卸载 DSH')
  .option('-y, --yes', '跳过确认')
  .action(async (options) => {
    const { handleUninstall } = await import('./commands/install.js');
    await handleUninstall(options);
  });

// ====== 状态命令 ======
program
  .command('status')
  .alias('info')
  .description('查看 DSH 安装状态和系统信息')
  .action(async () => {
    const { handleStatus } = await import('./commands/status.js');
    await handleStatus();
  });

// ====== 诊断命令 ======
program
  .command('doctor')
  .description('系统诊断 - 检查 DSH 环境完整性')
  .action(async () => {
    const { handleDoctor } = await import('./commands/doctor.js');
    await handleDoctor();
  });

// ====== 插件管理 ======
const pluginCmd = program
  .command('plugin')
  .description('插件管理');

pluginCmd
  .command('list')
  .description('列出已安装的插件')
  .option('--json', '以 JSON 格式输出')
  .action(async (options) => {
    const { handlePluginList } = await import('./commands/plugin.js');
    await handlePluginList(options);
  });

pluginCmd
  .command('search')
  .description('搜索插件市场')
  .argument('<query>', '搜索关键词')
  .option('--json', '以 JSON 格式输出')
  .action(async (query, options) => {
    const { handlePluginSearch } = await import('./commands/plugin.js');
    await handlePluginSearch(query, options);
  });

pluginCmd
  .command('info')
  .description('查看插件详情')
  .argument('<pluginId>', '插件 ID')
  .action(async (pluginId) => {
    const { handlePluginInfo } = await import('./commands/plugin.js');
    await handlePluginInfo(pluginId);
  });

pluginCmd
  .command('remove')
  .description('卸载插件')
  .argument('<pluginId>', '插件 ID')
  .option('--profile <profile>', '目标 profile', 'web')
  .action(async (pluginId, options) => {
    const { handlePluginRemove } = await import('./commands/plugin.js');
    await handlePluginRemove(pluginId, options);
  });

pluginCmd
  .command('update')
  .description('更新插件')
  .argument('<pluginId>', '插件 ID')
  .action(async (pluginId) => {
    const { handlePluginUpdate } = await import('./commands/plugin.js');
    await handlePluginUpdate(pluginId);
  });

pluginCmd
  .command('check-updates')
  .description('检查所有插件更新')
  .action(async () => {
    const { handleCheckUpdates } = await import('./commands/plugin.js');
    await handleCheckUpdates();
  });

// ====== 插件市场 ======
program
  .command('marketplace')
  .alias('market')
  .alias('store')
  .description('浏览插件市场')
  .option('--refresh', '强制刷新缓存')
  .action(async (options) => {
    const { handleMarketplace } = await import('./commands/marketplace.js');
    await handleMarketplace(options);
  });

// ====== 配置管理 ======
const configCmd = program
  .command('config')
  .description('配置管理');

configCmd
  .command('show')
  .description('显示当前配置')
  .option('--key <key>', '查看特定配置项')
  .action(async (options) => {
    const { handleConfigShow } = await import('./commands/config.js');
    await handleConfigShow(options);
  });

configCmd
  .command('set')
  .description('设置配置项')
  .argument('<key>', '配置键 (如 llm.provider)')
  .argument('<value>', '配置值')
  .action(async (key, value) => {
    const { handleConfigSet } = await import('./commands/config.js');
    await handleConfigSet(key, value);
  });

configCmd
  .command('list-providers')
  .description('列出已配置的 LLM 提供商')
  .action(async () => {
    const { handleListProviders } = await import('./commands/config.js');
    await handleListProviders();
  });

// ====== 升级命令 ======
program
  .command('upgrade')
  .alias('update')
  .description('升级 dsh-manager 自身')
  .action(async () => {
    const { handleSelfUpgrade } = await import('./commands/self-upgrade.js');
    await handleSelfUpgrade();
  });

// ====== 版本命令 ======
program
  .command('versions')
  .description('管理 DSH 版本')
  .action(async () => {
    const { handleVersions } = await import('./commands/versions.js');
    await handleVersions();
  });

// 解析参数
await program.parseAsync(process.argv);