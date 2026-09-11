/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * Node.js 版本门槛的**唯一真源**。
 *
 * 背景：此前三处口径不一致（install.ps1 ≥18、env-check.js ≥20.1、capability-router ≥22），
 * 导致「安装时放行、运行时报错」的错位。DSH 的 profile 插件加载器
 * （cordis-plugin-loader fromInternal）要求 Node >= 22，且 DSH Manager 自带的
 * 便携版 Node 就是 v22.x，故统一以 22 为最低门槛。
 *
 * 需要调整全局门槛时，只改这里。
 */

/** 最低支持的 Node.js 大版本 */
export const MIN_NODE_MAJOR = 22;

/** 最低支持的 Node.js 次版本（与大版本共同构成门槛） */
export const MIN_NODE_MINOR = 0;

/** 人类可读的门槛字符串，如 "22.0" */
export const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

/**
 * 解析 Node 版本号字符串
 * @param {string} version - 如 'v22.12.0' / '22.12.0'
 * @returns {{major: number, minor: number, patch: number}}
 */
export function parseNodeVersion(version) {
  const parts = String(version || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

/**
 * 判断版本号是否满足最低门槛
 * @param {string} version - 如 'v22.12.0'
 * @returns {boolean}
 */
export function meetsMinNodeVersion(version) {
  const { major, minor } = parseNodeVersion(version);
  if (major > MIN_NODE_MAJOR) return true;
  if (major < MIN_NODE_MAJOR) return false;
  return minor >= MIN_NODE_MINOR;
}

/** 升级引导文案（各平台） */
export function getNodeUpgradeHint() {
  return `请升级 Node.js 至 >= ${MIN_NODE_VERSION}（推荐安装 https://nodejs.org 的 LTS 版本，或使用 DSH Manager 的便携版 Node）`;
}

export default {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  MIN_NODE_VERSION,
  parseNodeVersion,
  meetsMinNodeVersion,
  getNodeUpgradeHint,
};
