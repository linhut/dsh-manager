/**
 * @dsh-manager/core - 核心库入口
 * 
 * 提供 DSH 安装管理、配置管理、版本管理等核心功能
 */

export { DSHInstaller } from './installer.js';
export { DSHConfig } from './config.js';
export { DSHUtils, getDSHInfo } from './dsh-utils.js';
export { DSHVersionManager } from './version-manager.js';
export { MCPServerManager } from './mcp-manager.js';
export { checkPnpm, requirePnpm, getPnpmInstallGuide } from './pnpm-check.js';
export { DSHError, DSHErrorCodes } from './errors.js';

/**
 * 获取 DSH Manager 版本信息
 */
export function getVersion() {
  return {
    name: 'dsh-manager',
    version: '0.1.0',
    description: 'DeepSeek Harness 安装与管理工具'
  };
}