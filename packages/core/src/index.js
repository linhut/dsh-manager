/**
 * @dsh-manager/core - 核心库入口
 * 
 * 提供 DSH 安装管理、配置管理、版本管理等核心功能
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { DSHInstaller } from './installer.js';
export { DSHConfig } from './config.js';
export { DSHUtils, getDSHInfo, DSH_PATHS } from './dsh-utils.js';
export { DSHVersionManager } from './version-manager.js';
export { MCPServerManager } from './mcp-manager.js';
export { checkPnpm, requirePnpm, getPnpmInstallGuide } from './pnpm-check.js';
export { checkNode, checkNpm, checkEnvironment, getNodeInstallGuide, requireNodeAndNpm } from './env-check.js';
export { DSHError, DSHErrorCodes } from './errors.js';
export { getDSHStorageInfo, cleanDSHData } from './data-manager.js';
export { getDSHProcessInfo, stopProcessByPort, DSH_WEB_PORT } from './process-manager.js';
export { DSHProfileManager } from './profile-manager.js';

/**
 * 获取 DSH Manager 版本信息（从 package.json 读取，避免硬编码漂移）
 */
export function getVersion() {
  let version = '0.0.0';
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version || version;
  } catch {}
  return {
    name: 'dsh-manager',
    version,
    description: 'DeepSeek Harness 安装与管理工具'
  };
}