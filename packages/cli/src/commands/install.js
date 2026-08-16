/**
 * 安装/卸载命令处理
 */

import chalk from 'chalk';
import ora from 'ora';
import { DSHInstaller, DSHUtils } from '@dsh-manager/core';

/**
 * 安装 DSH
 */
export async function handleInstall(options) {
  const { version, registry, verbose } = options;

  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║     DeepSeek Harness 安装向导       ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════╝\n'));

  // 检查前置条件
  console.log(chalk.blue('🔍 检查系统环境...'));
  const spinner = ora('检测 Node.js 环境').start();
  
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (nodeMajor < 18) {
    spinner.fail(`Node.js 版本过低: ${nodeVersion}，需要 >= 18`);
    console.log(chalk.yellow('请访问 https://nodejs.org 安装最新 LTS 版本'));
    process.exit(1);
  }
  spinner.succeed(`Node.js ${nodeVersion}`);

  // 检查 npm
  const npmSpinner = ora('检测 npm 环境').start();
  const { execa } = await import('execa');
  try {
    const { stdout } = await execa('npm', ['--version'], { reject: false });
    if (stdout) {
      npmSpinner.succeed(`npm ${stdout.trim()}`);
    }
  } catch {
    npmSpinner.fail('npm 未找到');
    process.exit(1);
  }

  // 执行安装
  console.log('');
  const installSpinner = ora(
    version ? `正在安装 DSH ${version}...` : '正在安装最新版 DSH...'
  ).start();

  try {
    const installer = new DSHInstaller({
      registry,
      verbose,
      onProgress: ({ level, message }) => {
        if (level === 'warn') {
          installSpinner.warn(message);
          installSpinner.start();
        }
      },
    });

    const result = await installer.install(version);
    installSpinner.succeed(`DSH ${result.version} 安装成功！`);

    // 显示后续步骤
    console.log('\n' + chalk.green('✅ 安装完成！') + '\n');
    console.log(chalk.bold('下一步：'));
    console.log(`  ${chalk.cyan('dshm status')}    查看 DSH 状态`);
    console.log(`  ${chalk.cyan('dshm doctor')}    运行系统诊断`);
    console.log(`  ${chalk.cyan('dshm marketplace')}  浏览插件市场`);
    console.log(`  ${chalk.cyan('dsh web')}     启动 DSH Web 界面`);
    console.log(`  ${chalk.cyan('dsh --profile tui')}  启动 DSH 终端界面\n`);
    
  } catch (error) {
    installSpinner.fail(`安装失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 卸载 DSH
 */
export async function handleUninstall(options) {
  const { yes } = options;

  if (!yes) {
    console.log(chalk.bold.red('\n⚠️  即将卸载 DeepSeek Harness\n'));
    console.log(chalk.yellow('这将删除 DSH 命令行工具，但不会删除配置和数据文件。'));
    console.log(chalk.yellow(`配置目录: ${chalk.cyan(DSHUtils.DSH_PATHS.home)}\n`));
    
    const { default: inquirer } = await import('inquirer');
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: '确定要卸载 DSH 吗？',
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.blue('已取消卸载'));
      return;
    }
  }

  const spinner = ora('正在卸载 DSH...').start();

  try {
    const installer = new DSHInstaller();
    await installer.uninstall();
    spinner.succeed('DSH 已成功卸载');
  } catch (error) {
    spinner.fail(`卸载失败: ${error.message}`);
    process.exit(1);
  }
}