/**
 * @dsh-manager/core - 基础环境检测
 * 
 * 面向"基础空白环境"（可能连 Node.js/npm 都未安装）的部署检测：
 * 安装 DSH 前先确认 node/npm/pnpm 是否可用，缺失时给出明确引导。
 */

import { execa } from 'execa';
import { checkPnpm } from './pnpm-check.js';

/**
 * 检测 Node.js 是否安装
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null}>}
 */
export async function checkNode() {
  try {
    const { stdout, stderr } = await execa('node', ['--version'], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), error: null };
    }
    if (stderr) {
      return { installed: false, version: null, error: stderr.trim() };
    }
    return { installed: false, version: null, error: 'node 命令未找到' };
  } catch (error) {
    return { installed: false, version: null, error: error.message };
  }
}

/**
 * 检测 npm 是否安装
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null}>}
 */
export async function checkNpm() {
  try {
    const { stdout, stderr } = await execa('npm', ['--version'], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), error: null };
    }
    if (stderr) {
      return { installed: false, version: null, error: stderr.trim() };
    }
    return { installed: false, version: null, error: 'npm 命令未找到' };
  } catch (error) {
    return { installed: false, version: null, error: error.message };
  }
}

/**
 * 检测完整基础环境（node / npm / pnpm）
 * @returns {Promise<{node: object, npm: object, pnpm: object}>}
 */
export async function checkEnvironment() {
  const [node, npm, pnpm] = await Promise.all([
    checkNode(),
    checkNpm(),
    checkPnpm(),
  ]);
  return { node, npm, pnpm };
}

/**
 * 获取 Node.js 安装引导提示（按平台）
 * @returns {string}
 */
export function getNodeInstallGuide() {
  const platform = process.platform;
  const guides = {
    win32: 'winget install OpenJS.NodeJS.LTS\n  或: 前往 https://nodejs.org 下载 LTS 安装包',
    darwin: 'brew install node\n  或: 前往 https://nodejs.org 下载 LTS 安装包',
    linux: 'sudo apt install nodejs npm\n  或: 前往 https://nodejs.org 下载 LTS 安装包',
  };
  return guides[platform] || guides.linux;
}

/**
 * 检查 Node.js/npm 是否可用，不可用时抛出友好错误
 * @param {string} [operation] - 操作描述，如"安装 DSH"
 * @returns {Promise<{node: object, npm: object}>}
 */
export async function requireNodeAndNpm(operation = '执行此操作') {
  const [node, npm] = await Promise.all([checkNode(), checkNpm()]);
  if (!node.installed) {
    const guide = getNodeInstallGuide();
    throw new Error(
      `未检测到 Node.js，请先安装 Node.js（含 npm）后再${operation}\n\n安装命令: ${guide}\n\n安装完成后重启 DSH Manager 即可。`
    );
  }
  if (!npm.installed) {
    throw new Error(
      `检测到 Node.js（${node.version}）但 npm 不可用，请修复 npm 后再${operation}\n\n可尝试: npm install -g npm@latest 或重新安装 Node.js。`
    );
  }
  return { node, npm };
}
