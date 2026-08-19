/**
 * DSH Manager
 * Copyright (c) 2026 linhut (https://github.com/linhut)
 * MIT License
 */

/**
 * @dsh-manager/core - pnpm 检测工具
 * 
 * DSH 的插件管理依赖 pnpm（通过 `dsh plugin --profile <name> add <package>` 间接使用）。
 * 如果系统中没有安装 pnpm，插件安装/卸载/更新操作将失败。
 * 本模块提供检测和安装引导功能。
 */

import { execa } from 'execa';
import { DSHError, DSHErrorCodes } from './errors.js';

/**
 * 检测 pnpm 是否已安装
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null}>}
 */
export async function checkPnpm() {
  try {
    const { stdout, stderr } = await execa('pnpm', ['--version'], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), error: null };
    }
    if (stderr) {
      return { installed: false, version: null, error: stderr.trim() };
    }
    return { installed: false, version: null, error: 'pnpm 命令未找到' };
  } catch (error) {
    return { installed: false, version: null, error: error.message };
  }
}

/**
 * 获取 pnpm 安装引导提示
 * @returns {string}
 */
export function getPnpmInstallGuide() {
  const platform = process.platform;
  const guides = {
    darwin: 'brew install pnpm',
    win32: 'corepack enable && corepack prepare pnpm@latest --activate\n  或: npm install -g pnpm',
    linux: 'corepack enable\n  或: npm install -g pnpm',
  };
  const cmd = guides[platform] || guides.linux;
  return cmd;
}

/**
 * 检查 pnpm 是否可用，不可用时抛出友好错误
 * @param {string} [operation] - 操作描述，如"安装插件"
 * @returns {Promise<void>}
 */
export async function requirePnpm(operation = '执行此操作') {
  const result = await checkPnpm();
  if (!result.installed) {
    const guide = getPnpmInstallGuide();
    throw new DSHError(
      DSHErrorCodes.PLUGIN_INSTALL_FAILED,
      `未找到 pnpm，请先安装 pnpm 后再${operation}\n\n安装命令: ${guide}\n\n安装后重启 DSH Manager 即可。`
    );
  }
  return result;
}