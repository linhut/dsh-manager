/**
 * 自我升级命令处理
 */

import chalk from 'chalk';
import ora from 'ora';
import { execa } from 'execa';

/**
 * 升级 dsh-manager 自身
 */
export async function handleSelfUpgrade() {
  console.log(chalk.bold.cyan('\n📦 dsh-manager 升级检查\n'));

  // 检查当前版本
  let currentVersion = '0.1.0';
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );
    currentVersion = pkg.version;
  } catch {}

  console.log(`  当前版本: ${chalk.cyan(currentVersion)}`);

  // 检查 npm 最新版本
  const spinner = ora('正在检查最新版本...').start();

  try {
    const { stdout } = await execa('npm', [
      'view', 'dsh-manager', 'version', '--json',
    ], { timeout: 30_000, reject: false });

    if (stdout) {
      const latestVersion = JSON.parse(stdout).replace(/"/g, '');
      spinner.stop();

      console.log(`  最新版本: ${chalk.cyan(latestVersion)}`);

      if (latestVersion === currentVersion) {
        console.log(chalk.green('\n✅ 已是最新版本！\n'));
        return;
      }

      console.log(chalk.yellow(`\n⚡ 发现新版本: ${currentVersion} → ${latestVersion}\n`));

      const { default: inquirer } = await import('inquirer');
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: '是否升级？',
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('已取消升级\n'));
        return;
      }

      // 执行升级
      const upgradeSpinner = ora('正在升级...').start();
      try {
        await execa('npm', ['install', '-g', 'dsh-manager@latest'], {
          stdio: 'pipe',
          timeout: 120_000,
        });
        upgradeSpinner.succeed(`升级成功！${chalk.green(currentVersion)} → ${chalk.green(latestVersion)}`);
        console.log(chalk.gray('\n请重启终端或重新加载 shell 配置\n'));
      } catch (error) {
        upgradeSpinner.fail(`升级失败: ${error.message}`);
      }
    } else {
      spinner.fail('无法获取最新版本信息');
      console.log(chalk.yellow('提示: 请检查网络连接\n'));
    }
  } catch (error) {
    spinner.fail(`检查失败: ${error.message}`);
  }
}