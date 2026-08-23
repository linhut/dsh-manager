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
 *
 * 校验：候选目录必须"可用"（package.json 可解析且 bin 入口文件存在）。
 * 修复场景：npm uninstall 因 ENOTEMPTY 残留的 package.json（入口文件已删）会被
 * 视为未安装，避免前端误报"已安装"导致无法重新安装。
 */
async function resolveDSHPackageJson() {
  const candidates = [];

  // ① 优先检查 DSH_HOME 下的 node_modules（本地部署场景）
  candidates.push(join(DSH_PATHS.home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));

  // ② 通过 npm root -g 获取 npm 全局路径
  try {
    const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000, windowsHide: true });
    if (globalRoot && globalRoot.trim()) {
      candidates.push(join(globalRoot.trim(), '@deepseek-ai', 'dsh', 'package.json'));
    }
  } catch {}

  // ③ 通过 pnpm root -g 获取 pnpm 全局路径（npm 不可用时的备选）
  try {
    const { stdout: pnpmRoot } = await execa('pnpm', ['root', '-g'], { reject: false, timeout: 10_000, windowsHide: true });
    if (pnpmRoot && pnpmRoot.trim()) {
      candidates.push(join(pnpmRoot.trim(), '@deepseek-ai', 'dsh', 'package.json'));
    }
  } catch {}

  // ④ 回退：require.resolve（依赖 NODE_PATH 或 cwd 级 node_modules）
  try {
    const { stdout } = await execa('node', [
      '-e', 'try { console.log(require.resolve("@deepseek-ai/dsh/package.json")); } catch(e) { console.log(""); }'
    ], { reject: false, timeout: 10_000 });
    if (stdout && stdout.trim().length > 0) candidates.push(stdout.trim());
  } catch {}

  // ⑤ 通过 dsh 命令本身查找：兼容 npm/pnpm 不在 PATH 但 dsh 在 PATH 的场景
  try {
    const dshCmd = await resolveDSHCommand();
    if (dshCmd && dshCmd !== 'dsh' && existsSync(dshCmd)) {
      const cmdDir = dirname(dshCmd);
      // 直接父级 node_modules（npm 全局布局：bin 目录与 node_modules 同级）
      candidates.push(join(cmdDir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
      // 双层父级（某些 pnpm/其他布局）
      candidates.push(join(cmdDir, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    }
  } catch {}

  // ⑥ 兜底：检查 DSH_HOME 下是否有已记录的版本文件（已安装记录）
  try {
    const versionsPath = join(DSH_PATHS.home, 'versions.json');
    if (existsSync(versionsPath)) {
      const records = JSON.parse(readFileSync(versionsPath, 'utf-8'));
      if (Array.isArray(records) && records.length > 0) {
        // 遍历所有记录，尝试从记录的路径查找
        for (const rec of records) {
          if (rec.path && existsSync(join(rec.path, 'package.json'))) {
            candidates.push(join(rec.path, 'package.json'));
          }
        }
      }
    }
  } catch {}

  for (const pkgPath of candidates) {
    if (!pkgPath || !existsSync(pkgPath)) continue;
    // 校验安装可用性：package.json 可解析且 bin 入口文件存在（残留/损坏目录视为未安装）
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const binEntry = pkg.bin;
      const binFile = typeof binEntry === 'string'
        ? binEntry
        : (binEntry && typeof binEntry === 'object' ? (binEntry.dsh || Object.values(binEntry)[0]) : null);
      if (binFile) {
        if (existsSync(join(dirname(pkgPath), binFile))) return pkgPath;
        // bin 入口缺失 → 损坏安装，跳过（继续探测下一个候选）
        continue;
      }
      return pkgPath;
    } catch {
      // package.json 损坏 → 视为未安装
      continue;
    }
  }

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
    const { stdout } = await execa('dsh', ['--version'], { reject: false, timeout: 5_000, windowsHide: true });
    if (stdout && stdout.trim()) {
      // dsh 在 PATH 中，尝试获取完整路径（用于推导 package.json 位置）
      try {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const { stdout: fullPath } = await execa(whichCmd, ['dsh'], { reject: false, timeout: 5_000, windowsHide: true });
        if (fullPath && fullPath.trim()) {
          const path = fullPath.trim().split('\n')[0].trim(); // where 可能返回多行
          if (path && (existsSync(path) || path.endsWith('.cmd') || path.endsWith('.exe'))) return path;
        }
      } catch {}
      return 'dsh';
    }
  } catch {}

  // ② 通过 npm root -g 推导全局 bin 目录（Windows: <prefix> 下有 dsh.cmd；POSIX: <prefix>/bin/dsh）
  try {
    const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000, windowsHide: true });
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
 * 语义化版本比较（支持 DSH 的 0.x-rc.N / 0.x-beta.N 预发布格式）
 *
 * npm 上 @deepseek-ai/dsh 全部为预发布版本（latest/next 均为 rc 系列），
 * 字符串排序（如 .reverse()）会把 rc.10 排在 rc.9 前面，必须按
 * 主/次/修订/预发布段逐级比较。规则：
 *   - 主/次/修订逐段比较；
 *   - 同主版本号下：带 -rc.N/-beta.N 的预发布 < 对应正式版本（正式版 pre=Infinity）；
 *   - rc.N 之间按 N 数值比较。
 * @param {string} a
 * @param {string} b
 * @returns {number} a<b 返回负数，a>b 返回正数，相等返回 0
 */
export function compareDSHVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(?:rc|beta|alpha|next)\.(\d+))?/i.exec(String(v || '').trim());
    if (!m) return { nums: [0, 0, 0], pre: Infinity };
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] !== undefined ? Number(m[4]) : Infinity,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  const diff = pa.pre - pb.pre;
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

/**
 * 语义化版本降序排序（最新在前），替代不可靠的字符串 .reverse()
 * @param {string[]} versions
 * @returns {string[]} 排序后的新数组
 */
export function sortDSHVersionsDesc(versions) {
  return [...versions].sort((a, b) => compareDSHVersions(b, a));
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
      // 只保留合法语义化版本号（兼容 0.x-rc.N 预发布与未来的 1.x 正式版）
      return sortDSHVersionsDesc(
        versions.filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v.trim()))
      );
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