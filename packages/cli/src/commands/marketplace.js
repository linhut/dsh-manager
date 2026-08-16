/**
 * 插件市场命令处理
 */

import chalk from 'chalk';
import ora from 'ora';
import { PluginRegistry, PluginManager } from '@dsh-manager/marketplace';

/**
 * 交互式插件市场浏览
 */
export async function handleMarketplace(options) {
  const { refresh } = options;
  const registry = new PluginRegistry();

  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║        DSH 插件市场                  ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════╝\n'));

  // 获取插件列表
  const spinner = ora('正在加载插件市场...').start();

  try {
    const results = await registry.search({ forceRefresh: refresh, perPage: 30 });
    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow('📭 插件市场暂无数据\n'));
      console.log(chalk.gray('  可能的原因:'));
      console.log(chalk.gray('  • 网络连接问题'));
      console.log(chalk.gray('  • GitHub API 限制'));
      console.log(chalk.gray('  • 暂未有插件发布\n'));
      return;
    }

    console.log(chalk.bold(`📊 共发现 ${chalk.cyan(results.length)} 个插件\n`));

    // 显示插件列表（分页）
    const pageSize = 10;
    let page = 0;
    const totalPages = Math.ceil(results.length / pageSize);

    while (page < totalPages) {
      const start = page * pageSize;
      const end = Math.min(start + pageSize, results.length);
      const pageItems = results.slice(start, end);

      console.log(chalk.bold(`第 ${page + 1}/${totalPages} 页:\n`));

      for (const plugin of pageItems) {
        const stars = plugin.stars > 0 
          ? chalk.yellow(`★ ${plugin.stars}`) 
          : chalk.gray('☆ 0');
        const desc = (plugin.description || '暂无描述').slice(0, 60);
        
        console.log(`  ${chalk.cyan(plugin.fullName)}`);
        console.log(`    ${chalk.gray(desc)}`);
        console.log(`    ${stars}  ${chalk.gray(plugin.language || '')}  ${chalk.gray(`更新: ${new Date(plugin.updatedAt).toLocaleDateString()}`)}`);
        console.log('');
      }

      // 分页导航
      if (page < totalPages - 1) {
        const { default: inquirer } = await import('inquirer');
        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: '选择操作:',
            choices: [
              { name: '📄 下一页', value: 'next' },
              { name: '🔍 搜索插件', value: 'search' },
              { name: '🔢 输入编号安装', value: 'install' },
              { name: '🚪 退出', value: 'exit' },
            ],
          },
        ]);

        if (action === 'next') {
          page++;
          continue;
        } else if (action === 'search') {
          const { query } = await inquirer.prompt([
            { type: 'input', name: 'query', message: '搜索关键词:' },
          ]);
          if (query.trim()) {
            await handlePluginSearch(query, registry);
            return;
          }
        } else if (action === 'install') {
          const { index } = await inquirer.prompt([
            {
              type: 'input',
              name: 'index',
              message: '输入要安装的插件编号 (1-10):',
              validate: (input) => {
                const num = parseInt(input);
                return num >= 1 && num <= pageItems.length ? true : '请输入有效编号';
              },
            },
          ]);
          const plugin = pageItems[parseInt(index) - 1];
          await installPlugin(plugin);
          return;
        } else {
          console.log(chalk.gray('\n感谢使用 DSH 插件市场！\n'));
          return;
        }
      }

      page++;
    }

    // 最后一页：选择操作
    const { default: inquirer } = await import('inquirer');
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '选择操作:',
        choices: [
          { name: '🔍 搜索插件', value: 'search' },
          { name: '🔢 输入编号安装', value: 'install' },
          { name: '🚪 退出', value: 'exit' },
        ],
      },
    ]);

    if (action === 'search') {
      const { query } = await inquirer.prompt([
        { type: 'input', name: 'query', message: '搜索关键词:' },
      ]);
      if (query.trim()) {
        await handlePluginSearch(query, registry);
      }
    } else if (action === 'install') {
      const { index } = await inquirer.prompt([
        {
          type: 'input',
          name: 'index',
          message: '输入要安装的插件编号 (1-10):',
          validate: (input) => {
            const num = parseInt(input);
            return num >= 1 && num <= results.length ? true : '请输入有效编号';
          },
        },
      ]);
      const plugin = results[parseInt(index) - 1];
      await installPlugin(plugin);
    } else {
      console.log(chalk.gray('\n感谢使用 DSH 插件市场！\n'));
    }

  } catch (error) {
    spinner.fail(`加载插件市场失败: ${error.message}`);
    console.log(chalk.yellow('\n提示: 检查网络连接或使用 GITHUB_TOKEN 环境变量提高 API 限制\n'));
  }
}

/**
 * 安装插件
 */
async function installPlugin(plugin) {
  console.log(chalk.cyan(`\n📥 准备安装: ${plugin.fullName}\n`));

  const { default: inquirer } = await import('inquirer');
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `确定安装 ${plugin.fullName} 吗？`,
      default: true,
    },
  ]);

  if (!confirm) {
    console.log(chalk.gray('已取消安装\n'));
    return;
  }

  const spinner = ora('正在安装...').start();

  try {
    const { PluginInstaller } = await import('@dsh-manager/marketplace');
    const installer = new PluginInstaller();
    const result = await installer.install(`github:${plugin.fullName}`, { fromMarketplace: true });
    spinner.succeed(`插件 ${chalk.bold(result.name)} 安装成功！`);
    console.log(`  版本: ${chalk.green(result.version)}`);
    console.log(`  运行 ${chalk.cyan('dshm plugin list')} 查看已安装的插件\n`);
  } catch (error) {
    spinner.fail(`安装失败: ${error.message}`);
  }
}

/**
 * 搜索插件
 */
async function handlePluginSearch(query, registry) {
  const spinner = ora(`搜索 "${query}"...`).start();

  try {
    const results = await registry.search({ query, perPage: 15 });
    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow(`\n未找到匹配 "${query}" 的插件\n`));
      return;
    }

    console.log(chalk.bold.cyan(`\n搜索结果: ${results.length} 个\n`));

    for (let i = 0; i < results.length; i++) {
      const plugin = results[i];
      console.log(`  ${chalk.cyan(`${i + 1}.`)} ${chalk.bold(plugin.fullName)}`);
      console.log(`     ${chalk.gray((plugin.description || '暂无描述').slice(0, 60))}`);
      console.log(`     ${chalk.yellow(`★ ${plugin.stars}`)}  ${chalk.gray(plugin.language || '')}`);
      console.log('');
    }

    const { default: inquirer } = await import('inquirer');
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '选择操作:',
        choices: [
          { name: '🔢 输入编号安装', value: 'install' },
          { name: '🚪 返回', value: 'back' },
        ],
      },
    ]);

    if (action === 'install') {
      const { index } = await inquirer.prompt([
        {
          type: 'input',
          name: 'index',
          message: `输入编号 (1-${results.length}):`,
          validate: (input) => {
            const num = parseInt(input);
            return num >= 1 && num <= results.length ? true : '请输入有效编号';
          },
        },
      ]);
      await installPlugin(results[parseInt(index) - 1]);
    }

  } catch (error) {
    spinner.fail(`搜索失败: ${error.message}`);
  }
}