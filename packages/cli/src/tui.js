/**
 * TUI - 交互式终端界面
 * 
 * 提供美观的交互式菜单界面
 */

import chalk from 'chalk';
import { getDSHInfo, isDSHInstalled, getDSHVersion } from '@dsh-manager/core';
import { PluginRegistry } from '@dsh-manager/marketplace';

const BANNER = `
  ██████╗ ███████╗██╗  ██╗    ███╗   ███╗ █████╗ ███╗   ██╗ █████╗  ██████╗ ███████╗██████╗ 
  ██╔══██╗██╔════╝██║  ██║    ████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝ ██╔════╝██╔══██╗
  ██║  ██║███████╗███████║    ██╔████╔██║███████║██╔██╗ ██║███████║██║  ███╗█████╗  ██████╔╝
  ██║  ██║╚════██║██╔══██║    ██║╚██╔╝██║██╔══██║██║╚██╗██║██╔══██║██║   ██║██╔══╝  ██╔══██╗
  ██████╔╝███████║██║  ██║    ██║ ╚═╝ ██║██║  ██║██║ ╚████║██║  ██║╚██████╔╝███████╗██║  ██║
  ╚═════╝ ╚══════╝╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
`;

/**
 * 启动 TUI
 */
export async function launchTUI() {
  console.clear();
  console.log(chalk.cyan(BANNER));
  console.log(chalk.bold('            DeepSeek Harness 管理工具'));
  console.log(chalk.gray('            ====================================\n'));

  let running = true;

  while (running) {
    const { default: inquirer } = await import('inquirer');
    
    // 获取状态信息
    const installed = await isDSHInstalled();
    const version = installed ? await getDSHVersion() : null;
    const registry = new PluginRegistry();
    const pluginCount = registry.getLocalPlugins().length;

    const statusLine = installed
      ? chalk.green(`● DSH ${version} 已运行`)
      : chalk.red('● DSH 未安装');

    const choices = [
      new inquirer.Separator(chalk.gray(` ── ${statusLine} ──`)),
      {
        name: `${chalk.bold('🔧 安装管理')}  ${chalk.gray('安装/卸载/升级 DSH')}`,
        value: 'install',
      },
      {
        name: `${chalk.bold('🛒 插件市场')}  ${chalk.gray('浏览和安装插件')}`,
        value: 'marketplace',
      },
      {
        name: `${chalk.bold('🔌 插件管理')}  ${chalk.gray(`管理已安装的 ${pluginCount} 个插件`)}`,
        value: 'plugin',
      },
      {
        name: `${chalk.bold('📊 系统状态')}  ${chalk.gray('查看 DSH 运行状态')}`,
        value: 'status',
      },
      {
        name: `${chalk.bold('🩺 系统诊断')}  ${chalk.gray('检查环境完整性')}`,
        value: 'doctor',
      },
      {
        name: `${chalk.bold('⚙️  配置管理')}  ${chalk.gray('查看/编辑 DSH 配置')}`,
        value: 'config',
      },
      {
        name: `${chalk.bold('📦 版本管理')}  ${chalk.gray('查看和切换 DSH 版本')}`,
        value: 'versions',
      },
      new inquirer.Separator(chalk.gray(' ────────────')),
      {
        name: `${chalk.red('✕ 退出')}`,
        value: 'exit',
      },
    ];

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: chalk.cyan('选择操作:'),
        choices,
        pageSize: 12,
      },
    ]);

    console.clear();

    switch (action) {
      case 'install': {
        console.log(chalk.cyan(BANNER));
        await showInstallMenu();
        break;
      }
      case 'marketplace': {
        const { handleMarketplace } = await import('./commands/marketplace.js');
        await handleMarketplace({ refresh: false });
        break;
      }
      case 'plugin': {
        await showPluginMenu();
        break;
      }
      case 'status': {
        const { handleStatus } = await import('./commands/status.js');
        await handleStatus();
        break;
      }
      case 'doctor': {
        const { handleDoctor } = await import('./commands/doctor.js');
        await handleDoctor();
        break;
      }
      case 'config': {
        const { handleConfigShow } = await import('./commands/config.js');
        await handleConfigShow({ key: null });
        break;
      }
      case 'versions': {
        const { handleVersions } = await import('./commands/versions.js');
        await handleVersions();
        break;
      }
      case 'exit':
        running = false;
        console.log(chalk.cyan('\n感谢使用 DSH Manager！\n'));
        break;
    }

    if (running && action !== 'exit') {
      const { default: inquirer } = await import('inquirer');
      const { continue: cont } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continue',
          message: chalk.gray('按 Enter 返回主菜单...'),
          default: true,
        },
      ]);
      console.clear();
    }
  }
}

/**
 * 安装管理子菜单
 */
async function showInstallMenu() {
  const { default: inquirer } = await import('inquirer');

  const installed = await isDSHInstalled();
  const version = installed ? await getDSHVersion() : null;

  console.log(chalk.bold.cyan('🔧 DSH 安装管理\n'));
  console.log(chalk.gray(`  当前状态: ${installed ? chalk.green(`已安装 ${version}`) : chalk.red('未安装')}\n`));

  const choices = [
    {
      name: `${chalk.green('📥 安装 DSH')}  ${chalk.gray('安装最新版 DeepSeek Harness')}`,
      value: 'install',
    },
    {
      name: `${chalk.yellow('🔄 升级 DSH')}  ${chalk.gray('升级到最新版本')}`,
      value: 'upgrade',
      disabled: !installed,
    },
    {
      name: `${chalk.red('🗑️  卸载 DSH')}  ${chalk.gray('卸载当前 DSH')}`,
      value: 'uninstall',
      disabled: !installed,
    },
    {
      name: `${chalk.blue('📋 查看版本')}  ${chalk.gray('浏览所有可用版本')}`,
      value: 'versions',
    },
    {
      name: `${chalk.gray('🔙 返回主菜单')}`,
      value: 'back',
    },
  ];

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: '选择操作:',
      choices,
    },
  ]);

  switch (action) {
    case 'install': {
      const { registry } = await inquirer.prompt([
        {
          type: 'list',
          name: 'registry',
          message: '选择 npm 镜像源:',
          choices: [
            { name: '🌐 官方源 (registry.npmjs.org)', value: '' },
            { name: '🇨🇳 淘宝镜像 (registry.npmmirror.com)', value: 'https://registry.npmmirror.com' },
          ],
        },
      ]);
      const { handleInstall } = await import('./commands/install.js');
      await handleInstall({ version: null, registry, verbose: false });
      break;
    }
    case 'upgrade': {
      const { handleInstall } = await import('./commands/install.js');
      await handleInstall({ version: 'latest', registry: '', verbose: false });
      break;
    }
    case 'uninstall': {
      const { handleUninstall } = await import('./commands/install.js');
      await handleUninstall({ yes: false });
      break;
    }
    case 'versions': {
      const { handleVersions } = await import('./commands/versions.js');
      await handleVersions();
      break;
    }
  }
}

/**
 * 插件管理子菜单
 */
async function showPluginMenu() {
  const { default: inquirer } = await import('inquirer');
  const registry = new PluginRegistry();
  const plugins = registry.getLocalPlugins();

  console.log(chalk.bold.cyan('🔌 插件管理\n'));
  console.log(chalk.gray(`  已安装插件: ${plugins.length} 个\n`));

  const choices = [
    {
      name: `${chalk.blue('📋 列出插件')}  ${chalk.gray('查看所有已安装的插件')}`,
      value: 'list',
    },
    {
      name: `${chalk.green('📥 安装插件')}  ${chalk.gray('从市场或来源安装插件')}`,
      value: 'install',
    },
    {
      name: `${chalk.yellow('🔄 检查更新')}  ${chalk.gray('检查所有插件是否有新版本')}`,
      value: 'check-updates',
      disabled: plugins.length === 0,
    },
    {
      name: `${chalk.red('🗑️  卸载插件')}  ${chalk.gray('卸载已安装的插件')}`,
      value: 'remove',
      disabled: plugins.length === 0,
    },
    {
      name: `${chalk.gray('🔙 返回主菜单')}`,
      value: 'back',
    },
  ];

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: '选择操作:',
      choices,
    },
  ]);

  switch (action) {
    case 'list': {
      const { handlePluginList } = await import('./commands/plugin.js');
      await handlePluginList({ json: false });
      break;
    }
    case 'install': {
      const { answer } = await inquirer.prompt([
        {
          type: 'input',
          name: 'answer',
          message: '输入插件来源 (github:owner/repo 或 npm:package):',
          validate: (input) => input.trim() ? true : '请输入有效的插件来源',
        },
      ]);
      const { handlePluginInstall } = await import('./commands/plugin.js');
      await handlePluginInstall(answer.trim(), { profile: 'web', verbose: false });
      break;
    }
    case 'check-updates': {
      const { handleCheckUpdates } = await import('./commands/plugin.js');
      await handleCheckUpdates();
      break;
    }
    case 'remove': {
      if (plugins.length > 0) {
        const { selected } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selected',
            message: '选择要卸载的插件:',
            choices: plugins.map(p => ({
              name: `${p.name || p.id} ${chalk.gray(`(${p.version})`)}`,
              value: p.id,
            })),
          },
        ]);
        const { handlePluginRemove } = await import('./commands/plugin.js');
        await handlePluginRemove(selected, { profile: 'web' });
      }
      break;
    }
  }
}