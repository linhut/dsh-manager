/**
 * @dsh-manager/core - DSH 工具函数
 * 
 * 检测 DSH 安装状态、获取版本信息、路径管理
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
 * 检测 DSH 是否已安装
 * @returns {Promise<boolean>}
 */
export async function isDSHInstalled() {
  try {
    const { stdout } = await execa('dsh', ['--version'], { reject: false });
    return !!stdout;
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
    const { stdout } = await execa('dsh', ['--version'], { reject: false });
    return stdout ? stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 获取 DSH 安装路径
 * @returns {Promise<string|null>}
 */
export async function getDSHPath() {
  try {
    const { stdout } = await execa('node', [
      '-e', 'console.log(require.resolve("@deepseek-ai/dsh/package.json"))'
    ], { reject: false });
    if (stdout) {
      return dirname(stdout.trim());
    }
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
    const { stdout } = await execa('npm', ['root', '-g'], { reject: false });
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
  try {
    await execa('dsh', ['--version'], { reject: false });
    return true;
  } catch {
    return false;
  }
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