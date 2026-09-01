/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_PATHS, buildCommandEnv } from './dsh-utils.js';

/**
 * 内部：检测命令是否可用（checkNode/checkNpm 共用）
 * @private
 * @param {string} cmd - 命令名
 * @param {string} label - 显示名
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null}>}
 */
async function checkCommand(cmd, label, options = {}) {
  const { useRuntimeEnv = false } = options;
  // 便携版 Node 场景：pnpm 可能装在 ~/.dsh/env/node（npm install -g pnpm），
  // 系统 PATH 不含该目录，注入运行时环境才能检测到
  const { env } = useRuntimeEnv ? buildCommandEnv() : { env: undefined };
  try {
    const { stdout, stderr, exitCode } = await execa(cmd, ['--version'], { reject: false, timeout: 10_000, windowsHide: true, env });
    if (!stdout && !stderr) console.warn('[dsh-manager] 命令检测无输出: ' + label + ' cmd=' + cmd + ' exit=' + exitCode + ' 注入运行时环境=' + useRuntimeEnv);
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), error: null };
    }
    // 部分工具把版本信息输出到 stderr，也认
    if (stderr && stderr.trim()) {
      const stderrVersion = stderr.trim().match(/v?\d+\.\d+\.\d+/);
      if (stderrVersion) {
        return { installed: true, version: stderrVersion[0], error: null };
      }
      return { installed: false, version: null, error: stderr.trim() };
    }
    return { installed: false, version: null, error: label + ' 命令未找到' };
  } catch (error) {
    console.warn('[dsh-manager] 命令检测失败: ' + label + ' cmd=' + cmd + ' error=' + (error?.message || error) + ' 注入运行时环境=' + useRuntimeEnv);
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
    const { stdout } = await execa(bin, ['--version'], { reject: false, timeout: 10_000, windowsHide: true });
    if (stdout && stdout.trim()) {
      return { installed: true, version: stdout.trim(), bin };
    }
  } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
  return { installed: false, version: null, bin };
}

/**
 * 检测 Node.js 是否安装（系统 PATH 优先，便携版兜底）
 * @returns {Promise<{installed: boolean, version: string|null, error: string|null, source?: string}>}
 */
export async function checkNode() {
  const sys = await checkCommand('node', 'node');
  if (sys.installed) return { ...sys, source: 'system' };
  console.warn('[dsh-manager] 系统 PATH 未找到 node，尝试便携版兜底 sysError=' + (sys?.error || '无') + ' portableBin=' + (getPortableNodeBin() || 'null'));
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
    const { stdout } = await execa(npmBin, ['--version'], { reject: false, timeout: 10_000, windowsHide: true });
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
    checkCommand('pnpm', 'pnpm', { useRuntimeEnv: true }),
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
      '未检测到 Node.js，请先安装 Node.js（含 npm）后再' + operation + '\n\n安装命令: ' + guide + '\n\n安装完成后重启 DSH Manager 即可。'
    );
  }
  // 校验最低版本（readdirSync recursive 需要 Node 20.1+）
  const nodeVer = (node.version || '').replace(/^v/, '').split('.').map(Number);
  if (nodeVer[0] < 20 || (nodeVer[0] === 20 && nodeVer[1] < 1)) {
    throw new Error(
      'Node.js 版本过低（' + node.version + '），需要 >= 20.1。请升级 Node.js 后再' + operation + '\n\n升级命令: 前往 https://nodejs.org 下载 LTS 版本'
    );
  }
  if (!npm.installed) {
    throw new Error(
      '检测到 Node.js（' + node.version + '）但 npm 不可用，请修复 npm 后再' + operation + '\n\n可尝试: npm install -g npm@latest 或重新安装 Node.js。'
    );
  }
  return { node, npm };
}