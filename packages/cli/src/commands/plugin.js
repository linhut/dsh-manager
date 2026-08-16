/**
 * 插件管理命令处理
 */

import chalk from 'chalk';
import ora from 'ora';
import { PluginRegistry, PluginInstaller, PluginManager } from '@dsh-manager/marketplace';

/**
 * 列出已安装的插件
 */
export async function handlePluginList(options) {
  const { json } = options;
  const manager = new PluginManager();

  const spinner = ora('获取插件列表...').start();
  try {
    const { local } = await manager.listAll();
    spinner.stop();

    if (json) {
      console.log(JSON.stringify(local, null, 2));
      return;
    }

    if (local.length === 0) {
      console.log(chalk.yellow('\n📭 暂无已安装的插件\n'));
      console.log(`  运行 ${chalk.cyan('dshm marketplace')} 浏览插件市场\n`);
      return;
    }

    console.log(chalk.bold.cyan(`\n🔌 已安装插件 (${local.length} 个)\n`));

    // 表头
    const header = [
      chalk.gray('ID'),
      chalk.gray('名称'),
      chalk.gray('版本'),
      chalk.gray('来源'),
      chalk.gray('状态'),
      chalk.gray('更新'),
    ];
    console.log(`  ${header.join('  ')}`);
    console.log(`  ${chalk.gray('─'.repeat(80))}`);

    for (const plugin of local) {
      const status = plugin.enabled !== false 
        ? chalk.green('● 启用') 
        : chalk.red('○ 禁用');
      const update = plugin.hasUpdate 
        ? chalk.yellow(`↑ ${plugin.latestVersion}`) 
        : chalk.gray('最新');
      const source = plugin.type === 'github' 
        ? chalk.blue('gh') 
        : chalk.magenta('npm');

      console.log(`  ${chalk.cyan(plugin.id.padEnd(20).slice(0, 20))}  ${(plugin.name || '').padEnd(16).slice(0, 16)}  ${chalk.green(plugin.version.padEnd(10).slice(0, 10))}  ${source}       ${status}  ${update}`);
    }

    console.log('');
    console.log(chalk.gray('  提示: 使用 dshm plugin info <id> 查看插件详情'));
    console.log('');

  } catch (error) {
    spinner.fail(`获取插件列表失败: ${error.message}`);
  }
}

/**
 * 安装插件
 */
export async function handlePluginInstall(source, options) {
  const { profile, verbose } = options;

  console.log(chalk.bold.cyan(`\n📥 安装插件: ${source}\n`));

  const spinner = ora('正在安装...').start();

  try {
    const installer = new PluginInstaller({ profile, verbose });
    const result = await installer.install(source);
    spinner.succeed(`插件 ${chalk.bold(result.name)} v${result.version} 安装成功！`);
    console.log(`  插件 ID: ${chalk.cyan(result.id)}`);
    console.log(`  目标 Profile: ${chalk.cyan(profile)}`);
    console.log('');
  } catch (error) {
    spinner.fail(`安装失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 搜索插件市场
 */
export async function handlePluginSearch(query, options) {
  const { json } = options;
  const registry = new PluginRegistry();

  const spinner = ora(`搜索 "${query}"...`).start();

  try {
    const results = await registry.search({ query, perPage: 15 });
    spinner.stop();

    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log(chalk.yellow(`\n🔍 未找到匹配 "${query}" 的插件\n`));
      return;
    }

    console.log(chalk.bold.cyan(`\n🔍 搜索结果: "${query}" (${results.length} 个)\n`));

    for (const plugin of results) {
      const stars = plugin.stars > 0 ? chalk.yellow(`★ ${plugin.stars}`) : chalk.gray('☆ 0');
      const lang = plugin.language ? chalk.gray(plugin.language) : '';
      
      console.log(`  ${chalk.cyan(plugin.fullName)}`);
      console.log(`    ${plugin.description?.slice(0, 80) || chalk.gray('暂无描述')}`);
      console.log(`    ${stars}  ${lang}  ${chalk.gray(`更新: ${new Date(plugin.updatedAt).toLocaleDateString()}`)}`);
      console.log(`    安装: ${chalk.cyan(`dshm install plugin github:${plugin.fullName}`)}`);
      console.log('');
    }

  } catch (error) {
    spinner.fail(`搜索失败: ${error.message}`);
  }
}

/**
 * 查看插件详情
 */
export async function handlePluginInfo(pluginId) {
  const registry = new PluginRegistry();

  const spinner = ora('获取插件信息...').start();

  try {
    // 先检查本地
    const local = registry.getLocalPlugins().find(p => p.id === pluginId);
    
    if (local) {
      spinner.stop();
      console.log(chalk.bold.cyan(`\n📦 插件详情: ${local.name || local.id}\n`));
      console.log(`  ${chalk.gray('ID:')}        ${chalk.cyan(local.id)}`);
      console.log(`  ${chalk.gray('名称:')}      ${local.name || chalk.gray('未知')}`);
      console.log(`  ${chalk.gray('版本:')}      ${chalk.green(local.version)}`);
      console.log(`  ${chalk.gray('来源:')}      ${chalk.blue(local.source)}`);
      console.log(`  ${chalk.gray('类型:')}      ${local.type === 'github' ? 'GitHub' : 'npm'}`);
      console.log(`  ${chalk.gray('Profile:')}   ${local.profile || '未指定'}`);
      console.log(`  ${chalk.gray('状态:')}      ${local.enabled !== false ? chalk.green('已启用') : chalk.red('已禁用')}`);
      console.log(`  ${chalk.gray('描述:')}      ${local.description || chalk.gray('暂无描述')}`);
      console.log(`  ${chalk.gray('安装时间:')}  ${local.installedAt ? new Date(local.installedAt).toLocaleString() : chalk.gray('未知')}`);
      
      if (local.repoUrl) {
        console.log(`  ${chalk.gray('仓库:')}      ${chalk.blue(local.repoUrl)}`);
      }
      
      console.log('');

      // 检查更新
      const updateSpinner = ora('检查更新...').start();
      try {
        const updateInfo = await registry.checkPluginUpdate(pluginId);
        updateSpinner.stop();
        if (updateInfo.hasUpdate) {
          console.log(chalk.yellow(`  ⚡ 有新版本可用: ${chalk.green(local.version)} → ${chalk.yellow(updateInfo.latestVersion)}`));
          console.log(`  更新命令: ${chalk.cyan(`dshm plugin update ${pluginId}`)}\n`);
        } else {
          console.log(chalk.green('  ✅ 已是最新版本\n'));
        }
      } catch {
        updateSpinner.stop();
      }

      return;
    }

    // 不在本地，尝试从 GitHub 搜索
    spinner.text = '在市场中搜索...';
    try {
      const results = await registry.search({ query: pluginId, perPage: 5 });
      const match = results.find(r => r.name === pluginId || r.fullName === pluginId);
      
      spinner.stop();

      if (match) {
        console.log(chalk.bold.cyan(`\n📦 市场中的插件: ${match.fullName}\n`));
        console.log(`  ${chalk.gray('名称:')}        ${chalk.cyan(match.fullName)}`);
        console.log(`  ${chalk.gray('描述:')}        ${match.description || chalk.gray('暂无描述')}`);
        console.log(`  ${chalk.gray('⭐ Stars:')}     ${chalk.yellow(match.stars)}`);
        console.log(`  ${chalk.gray('语言:')}        ${match.language || chalk.gray('未知')}`);
        console.log(`  ${chalk.gray('主题:')}        ${match.topics.join(', ') || chalk.gray('无')}`);
        console.log(`  ${chalk.gray('更新:')}        ${new Date(match.updatedAt).toLocaleDateString()}`);
        console.log(`  ${chalk.gray('仓库:')}        ${chalk.blue(match.url)}`);
        console.log('');
        console.log(`  安装: ${chalk.cyan(`dshm install plugin github:${match.fullName}`)}\n`);
      } else {
        console.log(chalk.yellow(`\n未找到插件 "${pluginId}"\n`));
      }
    } catch (error) {
      spinner.fail(`搜索失败: ${error.message}`);
    }

  } catch (error) {
    spinner.fail(`获取插件信息失败: ${error.message}`);
  }
}

/**
 * 移除插件
 */
export async function handlePluginRemove(pluginId, options) {
  const { profile } = options;

  const spinner = ora(`正在卸载 ${pluginId}...`).start();

  try {
    const installer = new PluginInstaller({ profile });
    await installer.uninstall(pluginId);
    spinner.succeed(`插件 ${chalk.bold(pluginId)} 已卸载`);
  } catch (error) {
    spinner.fail(`卸载失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 更新插件
 */
export async function handlePluginUpdate(pluginId) {
  const spinner = ora(`正在更新 ${pluginId}...`).start();

  try {
    const installer = new PluginInstaller();
    const result = await installer.update(pluginId);
    spinner.succeed(
      `插件 ${chalk.bold(pluginId)} 已更新: ${chalk.green(result.oldVersion)} → ${chalk.green(result.newVersion)}`
    );
  } catch (error) {
    spinner.fail(`更新失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 检查所有插件更新
 */
export async function handleCheckUpdates() {
  const registry = new PluginRegistry();

  const spinner = ora('正在检查插件更新...').start();

  try {
    const updates = await registry.checkAllUpdates();
    spinner.stop();

    const hasUpdates = updates.filter(u => u.hasUpdate);

    if (hasUpdates.length === 0) {
      console.log(chalk.green('\n✅ 所有插件已是最新版本\n'));
      return;
    }

    console.log(chalk.bold.cyan(`\n📦 发现 ${hasUpdates.length} 个插件可更新\n`));

    for (const update of hasUpdates) {
      console.log(`  ${chalk.cyan(update.name || update.id)}`);
      console.log(`    ${chalk.green(update.currentVersion)} → ${chalk.yellow(update.latestVersion)}`);
      console.log(`    更新: ${chalk.cyan(`dshm plugin update ${update.id}`)}`);
      console.log('');
    }

  } catch (error) {
    spinner.fail(`检查更新失败: ${error.message}`);
  }
}