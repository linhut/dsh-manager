/**
 * 配置管理命令处理
 */

import chalk from 'chalk';
import { DSHConfig } from '@dsh-manager/core';

/**
 * 显示配置
 */
export async function handleConfigShow(options) {
  const { key } = options;
  const config = new DSHConfig();

  if (key) {
    const value = await config.get(key);
    if (value === undefined) {
      console.log(chalk.yellow(`\n配置项 "${key}" 未设置\n`));
    } else {
      console.log(chalk.cyan(`\n${key}:`));
      console.log(`  ${JSON.stringify(value, null, 2)}\n`);
    }
    return;
  }

  const { settings } = await config.read();
  
  console.log(chalk.bold.cyan('\n⚙️  DSH 配置\n'));

  if (Object.keys(settings).length === 0) {
    console.log(chalk.gray('  暂无配置\n'));
    return;
  }

  printConfig(settings, 0);
  console.log('');
}

/**
 * 设置配置项
 */
export async function handleConfigSet(key, value) {
  const config = new DSHConfig();

  // 尝试解析值
  let parsedValue = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (value === 'null') parsedValue = null;
  else if (!isNaN(Number(value)) && value !== '') parsedValue = Number(value);
  else if ((value.startsWith('[') && value.endsWith(']')) || 
           (value.startsWith('{') && value.endsWith('}'))) {
    try {
      parsedValue = JSON.parse(value);
    } catch {}
  }

  try {
    await config.set(key, parsedValue);
    console.log(chalk.green(`\n✅ 配置已更新: ${chalk.cyan(key)} = ${chalk.yellow(JSON.stringify(parsedValue))}\n`));
  } catch (error) {
    console.log(chalk.red(`\n❌ 配置更新失败: ${error.message}\n`));
  }
}

/**
 * 列出 LLM 提供商
 */
export async function handleListProviders() {
  const config = new DSHConfig();
  
  console.log(chalk.bold.cyan('\n🤖 已配置的 LLM 提供商\n'));

  try {
    const providers = await config.listLLMProviders();
    
    if (providers.length === 0) {
      console.log(chalk.gray('  暂无配置\n'));
      console.log(chalk.gray('  提示: 在 ~/.dsh/settings.yaml 中配置 LLM'));
      console.log(chalk.gray('  格式:'));
      console.log(chalk.gray('    llm:'));
      console.log(chalk.gray('      default:'));
      console.log(chalk.gray('        provider: openai'));
      console.log(chalk.gray('        model: gpt-4'));
      console.log(chalk.gray('        apiKey: sk-...'));
      console.log('');
      return;
    }

    console.log(`  ${chalk.gray('名称'.padEnd(16))}  ${chalk.gray('提供商'.padEnd(16))}  ${chalk.gray('模型')}`);
    console.log(`  ${chalk.gray('─'.repeat(50))}`);
    
    for (const p of providers) {
      console.log(`  ${chalk.cyan(p.name.padEnd(16))}  ${chalk.blue(p.provider.padEnd(16))}  ${chalk.green(p.model)}`);
    }
    console.log('');
    
  } catch (error) {
    console.log(chalk.red(`\n❌ 获取配置失败: ${error.message}\n`));
  }
}

/**
 * 递归打印配置
 */
function printConfig(obj, indent) {
  const prefix = '  '.repeat(indent + 1);
  
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      console.log(`${prefix}${chalk.gray(key)}: null`);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      console.log(`${prefix}${chalk.bold(key)}:`);
      printConfig(value, indent + 1);
    } else if (Array.isArray(value)) {
      console.log(`${prefix}${chalk.bold(key)}: [${value.map(v => 
        typeof v === 'string' ? `"${v}"` : v
      ).join(', ')}]`);
    } else if (typeof value === 'string') {
      console.log(`${prefix}${chalk.gray(key)}: ${chalk.green(`"${value}"`)}`);
    } else if (typeof value === 'boolean') {
      console.log(`${prefix}${chalk.gray(key)}: ${chalk.yellow(value)}`);
    } else {
      console.log(`${prefix}${chalk.gray(key)}: ${chalk.cyan(value)}`);
    }
  }
}