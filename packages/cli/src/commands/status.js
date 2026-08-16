/**
 * 状态命令处理
 */

import chalk from 'chalk';
import { getDSHInfo, isDSHInstalled, checkDSHIntegrity } from '@dsh-manager/core';

export async function handleStatus() {
  console.log(chalk.bold.cyan('\n📊 DeepSeek Harness 状态\n'));

  const info = await getDSHInfo();

  // DSH 安装状态
  console.log(chalk.bold('🔧 DSH 安装状态:'));
  console.log(`  ${chalk.gray('安装状态:')}   ${info.installed ? chalk.green('✅ 已安装') : chalk.red('❌ 未安装')}`);
  if (info.installed) {
    console.log(`  ${chalk.gray('版本:')}       ${chalk.cyan(info.version || '未知')}`);
    console.log(`  ${chalk.gray('安装路径:')}    ${chalk.cyan(info.path || '未知')}`);
    console.log(`  ${chalk.gray('主目录:')}      ${chalk.cyan(info.home)}`);
  }

  // 系统环境
  console.log('');
  console.log(chalk.bold('💻 系统环境:'));
  console.log(`  ${chalk.gray('Node.js:')}     ${chalk.cyan(info.nodeVersion)}`);
  console.log(`  ${chalk.gray('平台:')}        ${chalk.cyan(info.platform)}`);
  console.log(`  ${chalk.gray('架构:')}        ${chalk.cyan(info.arch)}`);

  // 目录完整性
  console.log('');
  console.log(chalk.bold('📁 目录结构:'));
  const integrity = await checkDSHIntegrity();
  if (integrity.valid) {
    console.log(`  ${chalk.green('✅ 所有必需目录均存在')}`);
  } else {
    console.log(`  ${chalk.yellow(`⚠️  缺失 ${integrity.missing.length} 个目录`)}`);
    for (const dir of integrity.missing) {
      console.log(`    ${chalk.red('✗')} ${dir}`);
    }
  }

  // 配置信息
  console.log('');
  console.log(chalk.bold('⚙️  配置概览:'));
  const { DSHConfig } = await import('@dsh-manager/core');
  const config = new DSHConfig();
  const { settings } = await config.read();
  
  const keys = Object.keys(settings);
  if (keys.length > 0) {
    for (const key of keys.slice(0, 10)) {
      const value = settings[key];
      if (typeof value === 'object') {
        console.log(`  ${chalk.gray(`${key}:`)} ${chalk.cyan(JSON.stringify(value).slice(0, 60))}`);
      } else {
        console.log(`  ${chalk.gray(`${key}:`)} ${chalk.cyan(String(value).slice(0, 60))}`);
      }
    }
    if (keys.length > 10) {
      console.log(`  ${chalk.gray(`... 还有 ${keys.length - 10} 个配置项`)}`);
    }
  } else {
    console.log(`  ${chalk.gray('暂无配置')}`);
  }

  // 插件统计
  console.log('');
  console.log(chalk.bold('🔌 插件:'));
  const { PluginRegistry } = await import('@dsh-manager/marketplace');
  const registry = new PluginRegistry();
  const localPlugins = registry.getLocalPlugins();
  
  if (localPlugins.length > 0) {
    console.log(`  ${chalk.gray('已安装:')}     ${chalk.cyan(`${localPlugins.length} 个插件`)}`);
    const enabled = localPlugins.filter(p => p.enabled !== false).length;
    console.log(`  ${chalk.gray('已启用:')}     ${chalk.green(`${enabled} 个`)}`);
    console.log(`  ${chalk.gray('已禁用:')}     ${chalk.yellow(`${localPlugins.length - enabled} 个`)}`);
  } else {
    console.log(`  ${chalk.gray('暂无已安装的插件')}`);
    console.log(`  运行 ${chalk.cyan('dshm marketplace')} 浏览插件市场`);
  }

  console.log('');
}