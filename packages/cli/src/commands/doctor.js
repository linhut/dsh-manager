/**
 * 诊断命令 - 系统环境检查
 */

import chalk from 'chalk';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { isDSHInstalled, getDSHVersion, DSH_PATHS } from '@dsh-manager/core';

export async function handleDoctor() {
  console.log(chalk.bold.cyan('\n🩺 DeepSeek Harness 系统诊断\n'));

  let allPassed = true;
  const results = [];

  // 1. Node.js 检查
  results.push(await check('Node.js 版本', async () => {
    const version = process.version;
    const major = parseInt(version.slice(1).split('.')[0]);
    if (major < 18) {
      return { status: 'warning', message: `版本 ${version}，建议 >= 18` };
    }
    return { status: 'ok', message: version };
  }));

  // 2. npm 检查
  results.push(await check('npm 可用性', async () => {
    const { stdout } = await execa('npm', ['--version'], { reject: false });
    if (!stdout) throw new Error('npm 未找到');
    return { status: 'ok', message: stdout.trim() };
  }));

  // 3. DSH 安装检查
  results.push(await check('DSH 安装', async () => {
    const installed = await isDSHInstalled();
    if (!installed) {
      return { status: 'error', message: '未安装 DSH', fix: 'dshm install dsh' };
    }
    const version = await getDSHVersion();
    return { status: 'ok', message: `已安装 ${version}` };
  }));

  // 4. DSH 主目录
  results.push(await check('DSH 主目录', async () => {
    const home = DSH_PATHS.home;
    if (!existsSync(home)) {
      return { status: 'warning', message: `目录不存在: ${home}`, fix: 'dshm install dsh' };
    }
    return { status: 'ok', message: home };
  }));

  // 5. PATH 环境变量
  results.push(await check('dsh 在 PATH 中', async () => {
    try {
      await execa('dsh', ['--version'], { reject: false });
      return { status: 'ok', message: '可用' };
    } catch {
      return { status: 'error', message: 'dsh 命令不在 PATH 中', fix: '检查 npm 全局安装路径是否在 PATH 环境变量中' };
    }
  }));

  // 6. DSH 配置目录
  results.push(await check('Profile 目录', async () => {
    if (!existsSync(DSH_PATHS.profiles)) {
      return { status: 'warning', message: 'Profile 目录未创建', fix: 'dshm install dsh' };
    }
    return { status: 'ok', message: '存在' };
  }));

  // 7. npm 全局路径
  results.push(await check('npm 全局路径', async () => {
    const { stdout } = await execa('npm', ['root', '-g'], { reject: false });
    if (!stdout) {
      return { status: 'warning', message: '无法获取 npm 全局路径' };
    }
    return { status: 'ok', message: stdout.trim() };
  }));

  // 8. 网络连接
  results.push(await check('网络连接 (npmjs.org)', async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('https://registry.npmjs.org/', { signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) {
        return { status: 'ok', message: '可访问' };
      }
      return { status: 'warning', message: `状态码: ${response.status}` };
    } catch {
      return { status: 'warning', message: '无法访问，可能影响安装', fix: '检查网络连接或配置镜像源' };
    }
  }));

  // 9. GitHub API
  results.push(await check('GitHub API 访问', async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('https://api.github.com', {
        headers: { 'User-Agent': 'dsh-manager' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        return { status: 'ok', message: '可访问' };
      }
      return { status: 'warning', message: `状态码: ${response.status}` };
    } catch {
      return { status: 'warning', message: '无法访问，插件市场不可用', fix: '检查网络连接' };
    }
  }));

  // 打印结果
  console.log(chalk.bold('检查结果:\n'));

  for (const result of results) {
    const icon = result.status === 'ok' ? chalk.green('✅') :
                 result.status === 'warning' ? chalk.yellow('⚠️ ') :
                 chalk.red('❌');
    
    console.log(`  ${icon} ${chalk.bold(result.name)}`);
    console.log(`     ${chalk.gray(result.message)}`);
    
    if (result.fix) {
      console.log(`     ${chalk.blue('💡 建议:')} ${chalk.cyan(result.fix)}`);
    }
    console.log('');

    if (result.status === 'error') allPassed = false;
  }

  // 总结
  console.log(chalk.bold('总结:'));
  const okCount = results.filter(r => r.status === 'ok').length;
  const warnCount = results.filter(r => r.status === 'warning').length;
  const errCount = results.filter(r => r.status === 'error').length;

  if (errCount === 0 && warnCount === 0) {
    console.log(`  ${chalk.green(`✅ 全部 ${okCount} 项检查通过，系统状态良好！`)}`);
  } else if (errCount === 0) {
    console.log(`  ${chalk.yellow(`⚠️  ${okCount} 项通过，${warnCount} 项警告（不影响使用）`)}`);
  } else {
    console.log(`  ${chalk.red(`❌ ${okCount} 项通过，${warnCount} 项警告，${errCount} 项错误需要修复`)}`);
  }

  console.log('');
}

/**
 * 运行检查项
 */
async function check(name, fn) {
  try {
    const result = await fn();
    return { name, ...result };
  } catch (error) {
    return { name, status: 'error', message: error.message };
  }
}