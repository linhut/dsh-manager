/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { parseYAML } from './yaml-utils.js';

/**
 * DSH 路径配置
 */
export const DSH_PATHS = {
  /** DSH 主目录 */
  get home() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
  },
  /** 配置文件 */
  get settings() {
    return join(this.home, 'settings.yaml');
  },
  /** 凭据文件 */
  get credentials() {
    return join(this.home, '.credentials.yaml');
  },
  /** 配置文件目录 */
  get profiles() {
    return join(this.home, 'profiles');
  },
  /** 会话目录 */
  get sessions() {
    return join(this.home, 'sessions');
  },
  /** 技能目录 */
  get skills() {
    return join(this.home, 'skills');
  },
  /** 存储目录 */
  get storages() {
    return join(this.home, 'storages');
  },
  /** 偏好目录（用于 dsh-manager） */
  get managerDir() {
    return join(this.home, 'manager');
  },
  /** 便携环境目录（低配置最小化安装用） */
  get envDir() {
    return join(this.home, 'env');
  },
  /** 便携版 Node 目录 */
  get envNodeDir() {
    return join(this.envDir, 'node');
  },
  /** 本地插件缓存目录 */
  get pluginCache() {
    return join(this.managerDir, 'plugin-cache');
  },
  /** 本地插件注册表 */
  get pluginRegistry() {
    return join(this.managerDir, 'plugins.json');
  },
};

/**
 * 内部：解析 @deepseek-ai/dsh/package.json 的完整路径
 * 依次尝试：DSH_HOME 内 node_modules → npm root -g → require.resolve
 * （全局 npm 包不会出现在日常 require 的解析路径中，必须显式探测）
 */
async function resolveDSHPackageJson() {
  // ① 优先检查 DSH_HOME 下的 node_modules（本地部署场景）
  const homeGlobal = join(DSH_PATHS.home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (existsSync(homeGlobal)) return homeGlobal;

  // ② 通过 npm root -g 获取 npm 全局路径
  try {
    const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000 });
    if (globalRoot && globalRoot.trim()) {
      const pkgPath = join(globalRoot.trim(), '@deepseek-ai', 'dsh', 'package.json');
      if (existsSync(pkgPath)) return pkgPath;
    }
  } catch {}

  // ③ 回退：require.resolve（依赖 NODE_PATH 或 cwd 级 node_modules）
  try {
    const { stdout } = await execa('node', [
      '-e', 'try { console.log(require.resolve("@deepseek-ai/dsh/package.json")); } catch(e) { console.log(""); }'
    ], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim().length > 0) return stdout.trim();
  } catch {}

  return null;
}

/**
 * 检测 DSH 是否已安装
 * 通过 npm root -g 找到全局 node_modules，再检查 @deepseek-ai/dsh/package.json 是否存在
 * @returns {Promise<boolean>}
 */
export async function isDSHInstalled() {
  try {
    const pkgPath = await resolveDSHPackageJson();
    return !!pkgPath;
  } catch {
    return false;
  }
}

/**
 * 获取 DSH 版本信息
 * @returns {Promise<object|null>}
 */
export async function getDSHVersion() {
  try {
    const pkgPath = await resolveDSHPackageJson();
    if (!pkgPath) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * 解析 dsh 可执行命令
 * 
 * 用户可能通过自定义 npm prefix（如 E:\npm-global）安装 dsh，
 * 该目录未必在 PATH 中（Windows 常见问题），直接 execa('dsh') 会失败。
 * 依次尝试：PATH 中的 dsh → npm 全局 bin 下的 dsh(.cmd)。
 * @returns {Promise<string>} 可直接传给 execa 的命令名或完整路径
 */
export async function resolveDSHCommand() {
  // ① 优先 PATH 中的 dsh
  try {
    const { stdout } = await execa('dsh', ['--version'], { reject: false, timeout: 5_000 });
    if (stdout && stdout.trim()) return 'dsh';
  } catch {}

  // ② 通过 npm root -g 推导全局 bin 目录（Windows: <prefix> 下有 dsh.cmd；POSIX: <prefix>/bin/dsh）
  try {
    const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000 });
    if (globalRoot && globalRoot.trim()) {
      const prefix = dirname(globalRoot.trim());
      const candidates = process.platform === 'win32'
        ? [join(prefix, 'dsh.cmd'), join(prefix, 'dsh.exe'), join(prefix, 'dsh')]
        : [join(prefix, 'bin', 'dsh'), join(prefix, 'dsh')];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  } catch {}

  // ③ 兜底：返回 'dsh'，让调用方得到原始错误信息
  return 'dsh';
}

/**
 * 获取 DSH 安装路径
 * @returns {Promise<string|null>}
 */
export async function getDSHPath() {
  try {
    const pkgPath = await resolveDSHPackageJson();
    if (pkgPath) return dirname(pkgPath);
    return null;
  } catch {
    return null;
  }
}

/**
 * 获取 DSH 完整信息
 * @returns {Promise<object>}
 */
export async function getDSHInfo() {
  const installed = await isDSHInstalled();
  if (!installed) {
    return { installed: false, version: null, path: null, home: DSH_PATHS.home };
  }

  const version = await getDSHVersion();
  const dshPath = await getDSHPath();

  // 获取 npm 全局路径
  let npmGlobalPath = null;
  try {
    const { stdout } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000 });
    npmGlobalPath = stdout?.trim() || null;
  } catch {}

  return {
    installed: true,
    version,
    path: dshPath,
    home: DSH_PATHS.home,
    npmGlobalPath,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * 列出已安装的 DSH 版本（npm 全局缓存）
 * @returns {Promise<string[]>}
 */
export async function listDSHVersions() {
  try {
    const { stdout } = await execa('npm', [
      'view', '@deepseek-ai/dsh', 'versions', '--json'
    ], { reject: false });
    if (stdout) {
      const versions = JSON.parse(stdout);
      // 过滤出 rc 版本和正式版本
      return versions.filter(v => v.startsWith('0.')).reverse();
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 检查 DSH 目录结构完整性
 * @returns {Promise<{valid: boolean, missing: string[]}>}
 */
export async function checkDSHIntegrity() {
  const requiredPaths = [
    DSH_PATHS.home,
    DSH_PATHS.profiles,
    DSH_PATHS.sessions,
    DSH_PATHS.skills,
    DSH_PATHS.storages,
  ];

  const missing = requiredPaths.filter(p => !existsSync(p));
  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * 检查 DSH 命令行工具是否在 PATH 中
 * @returns {Promise<boolean>}
 */
export async function isDSHInPath() {
  return isDSHInstalled();
}

/**
 * 安全地读取 YAML/JSON 配置文件
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
export const DSHUtils = {
  DSH_PATHS,
  isDSHInstalled,
  getDSHVersion,
  getDSHPath,
  getDSHInfo,
  listDSHVersions,
  checkDSHIntegrity,
  isDSHInPath,
  readConfigFile,
};

export async function readConfigFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.json')) {
      return JSON.parse(content);
    }
    // 复用共享 YAML 解析（与 DSHConfig 一致）
    return parseYAML(content);
  } catch {
    return null;
  }
}