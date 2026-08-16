/**
 * 版本管理命令处理
 */

import chalk from 'chalk';
import ora from 'ora';
import { DSHVersionManager, getDSHVersion } from '@dsh-manager/core';

/**
 * 管理 DSH 版本
 */
export async function handleVersions() {
  const versionManager = new DSHVersionManager();

  console.log(chalk.bold.cyan('\n📦 DSH 版本管理\n'));

  // 当前版本
  const currentVersion = await getDSHVersion();
  console.log(`  当前版本: ${chalk.green(currentVersion || '未安装')}\n`);

  // 检查最新版本
  const spinner = ora('正在检查最新版本...').start();

  try {
    const { hasUpdate, current, latest } = await versionManager.checkForUpdate();
    spinner.stop();

    if (current && latest) {
      if (hasUpdate) {
        console.log(chalk.yellow(`  ⚡ 有新版本可用: ${chalk.green(current)} → ${chalk.yellow(latest)}`));
        console.log(`  升级命令: ${chalk.cyan('dshm install dsh')}\n`);
      } else {
        console.log(chalk.green('  ✅ 已是最新版本\n'));
      }
    }

    // 获取可用的版本列表
    const versionsSpinner = ora('正在获取可用版本列表...').start();
    try {
      const availableVersions = await versionManager.getAvailableVersions();
      versionsSpinner.stop();

      if (availableVersions.length > 0) {
        console.log(chalk.bold('📋 可用版本:\n'));

        // 显示最近的 20 个版本
        const displayVersions = availableVersions.slice(0, 20);
        for (const version of displayVersions) {
          const isCurrent = version === currentVersion;
          const prefix = isCurrent ? chalk.green('→') : ' ';
          const suffix = isCurrent ? chalk.gray(' (当前)') : '';
          console.log(`  ${prefix} ${chalk.cyan(version)}${suffix}`);
        }

        if (availableVersions.length > 20) {
          console.log(chalk.gray(`  ... 还有 ${availableVersions.length - 20} 个版本`));
        }

        console.log('');
        console.log(chalk.gray('  安装指定版本:'));
        console.log(chalk.gray(`  ${chalk.cyan('dshm install dsh --version 0.1.0-rc.3')}`));
        console.log('');
      }
    } catch {
      versionsSpinner.fail('无法获取版本列表');
    }

  } catch (error) {
    spinner.fail(`检查失败: ${error.message}`);
  }
}