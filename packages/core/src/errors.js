/**
 * @dsh-manager/core - 错误处理模块
 */

export const DSHErrorCodes = {
  // 通用错误
  UNKNOWN: 'UNKNOWN',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  
  // DSH 相关
  DSH_NOT_FOUND: 'DSH_NOT_FOUND',
  DSH_ALREADY_INSTALLED: 'DSH_ALREADY_INSTALLED',
  DSH_VERSION_NOT_FOUND: 'DSH_VERSION_NOT_FOUND',
  DSH_INSTALL_FAILED: 'DSH_INSTALL_FAILED',
  DSH_UNINSTALL_FAILED: 'DSH_UNINSTALL_FAILED',
  
  // 配置相关
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_PARSE_ERROR: 'CONFIG_PARSE_ERROR',
  
  // 网络相关
  NETWORK_ERROR: 'NETWORK_ERROR',
  GITHUB_API_ERROR: 'GITHUB_API_ERROR',
  
  // 插件相关
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_INSTALL_FAILED: 'PLUGIN_INSTALL_FAILED',
  PLUGIN_ALREADY_INSTALLED: 'PLUGIN_ALREADY_INSTALLED',
};

export class DSHError extends Error {
  /**
   * @param {string} code - 错误码
   * @param {string} message - 错误描述
   * @param {object} [details] - 附加信息
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DSHError';
    this.code = code;
    this.details = details;
  }

  toString() {
    return `[${this.code}] ${this.message}`;
  }
}