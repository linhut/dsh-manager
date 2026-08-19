/**
 * @dsh-manager/core - 基础环境检测
 * 
 * 面向"基础空白环境"（可能连 Node.js/npm 都未安装）的部署检测：
 * 安装 DSH 前先确认 node/npm/pnpm 是否可用，缺失时给出明确引导。
 * 低配置场景支持便携版 Node（~/.dsh/env/node），解压即用不污染系统。
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_PATHS } from './dsh-utils.js';

/**
 * 内部：检测命令是否可用（checkNode/checkNpm 共用）
 * @private
 * @param {string} cmd - 命令名
 * @param {string} label - 显示名
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null}>}
 */
async function checkCommand(cmd, label) {
  try {
    const { stdout, stderr } = await execa(cmd, ['--version'], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), error: null };
    }
    if (stderr) {
      return { installed: false, version: null, error: stderr.trim() };
    }
    return { installed: false, version: null, error: `${label} 命令未找到` };
  } catch (error) {
    return { installed: false, version: null, error: error.message };
  }
}

/**
 * 便携版 Node 可执行文件路径（存在返回完整路径，否则 null）
 * Windows: ~/.dsh/env/node/node.exe；POSIX: ~/.dsh/env/node/bin/node
 */
export function getPortableNodeBin() {
  const nodeDir = DSH_PATHS.envNodeDir;
  const bin = process.platform === 'win32'
    ? join(nodeDir, 'node.exe')
    : join(nodeDir, 'bin', 'node');
  return existsSync(bin) ? bin : null;
}

/**
 * 检测便携版 Node 是否已安装（低配置最小化安装）
 * @returns {Promise<{installed: boolean, version: string|null, bin: string|null}>}
 */
export async function checkPortableNode() {
  const bin = getPortableNodeBin();
  if (!bin) return { installed: false, version: null, bin: null };
  try {
    const { stdout } = await execa(bin, ['--version'], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), bin };
    }
  } catch {}
  return { installed: false, version: null, bin };
}

/**
 * 检测 Node.js 是否安装（系统 PATH 优先，便携版兜底）
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null, source?: string}>}
 */
export async function checkNode() {
  const sys = await checkCommand('node', 'node');
  if (sys.installed) return { ...sys, source: 'system' };
  const portable = await checkPortableNode();
  if (portable.installed) return { installed: true, version: portable.version, error: null, source: 'portable' };
  return sys;
}

/**
 * 检测 npm 是否安装（系统 PATH 优先，便携版兜底）
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null, source?: string}>}
 */
export async function checkNpm() {
  const sys = await checkCommand('npm', 'npm');
  if (sys.installed) return { ...sys, source: 'system' };
  // 便携版：node 目录下同级的 npm.cmd / npm
  const nodeDir = DSH_PATHS.envNodeDir;
  const npmBin = process.platform === 'win32'
    ? join(nodeDir, 'npm.cmd')
    : join(nodeDir, 'bin', 'npm');
  if (existsSync(npmBin)) {
    const { stdout } = await execa(npmBin, ['--version'], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), error: null, source: 'portable' };
    }
  }
  return sys;
}

/**
 * 检测完整基础环境（node / npm / pnpm / git）
 * @returns {Promise<{node: object, npm: object, pnpm: object, git: object}>}
 */
export async function checkEnvironment() {
  const [node, npm, pnpm, git] = await Promise.all([
    checkNode(),
    checkNpm(),
    checkCommand('pnpm', 'pnpm'),
    checkCommand('git', 'git'),
  ]);
  return { node, npm, pnpm, git };
}

/**
 * 检测 git 是否安装（git 插件安装依赖）
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null}>}
 */
export async function checkGit() {
  return checkCommand('git', 'git');
}

/**
 * 获取 git 安装引导提示（按平台）
 * @returns {string}
 */
export function getGitInstallGuide() {
  const platform = process.platform;
  const guides = {
    win32: 'winget install Git.Git\n  或: 前往 https://git-scm.com/download/win 下载安装',
    darwin: 'brew install git\n  或: 前往 https://git-scm.com/download/mac 下载安装',
    linux: 'sudo apt install git\n  或: 前往 https://git-scm.com/download/linux 下载安装',
  };
  return guides[platform] || guides.linux;
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
