/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { DSHInstaller } from './installer.js';
export { DSHConfig } from './config.js';
export { DSHUtils, getDSHInfo, getDSHDetectionDetail, DSH_PATHS, resolveDSHCommand, compareDSHVersions, buildCommandEnv, refreshSystemPath } from './dsh-utils.js';
export { DSHVersionManager } from './version-manager.js';
export { MCPServerManager } from './mcp-manager.js';
export { checkPnpm, requirePnpm, getPnpmInstallGuide } from './pnpm-check.js';
export { checkNode, checkNpm, checkGit, checkEnvironment, getNodeInstallGuide, getGitInstallGuide, requireNodeAndNpm, checkPortableNode, getPortableNodeBin } from './env-check.js';
export { installPortableNode, uninstallPortableNode, getPortableNodeInfo, getLatestLTSVersion, buildRuntimeEnv, getRuntimeConfig } from './portable-node.js';
export { DSHError, DSHErrorCodes } from './errors.js';
export { getDSHStorageInfo, cleanDSHData } from './data-manager.js';
export { getDSHProcessInfo, stopProcessByPort, DSH_WEB_PORT, findAvailablePort, isPortFree, testDSHHealth, diagnoseDSHProcess } from './process-manager.js';
export { DSHProfileManager } from './profile-manager.js';
export { SkillManager } from './skill-manager.js';
export { isSystemComponent, isExternalPlugin, classifyPackage, checkProfileIntegrity, repairProfileFromGlobal, repairAllProfiles, getDependencyHealth, getGlobalDSHNodeModules, getProfileNodeModules, checkGlobalDSHIntegrity, repairGlobalDSHInstall, copyModuleToProfile, repairProfileDependencies } from './dependency-integrity.js';
export { MasterPromptManager } from './master-prompt-manager.js';
export { setReplyLanguage, getReplyLanguage, clearReplyLanguage } from './reply-language.js';

/**
 * 获取 DSH Manager 版本信息（从 package.json 读取，避免硬编码漂移）
 */
export function getVersion() {
  let version = '0.0.0';
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version || version;
  } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
  return {
    name: 'dsh-manager',
    version,
    description: 'DeepSeek Harness 安装与管理工具'
  };
}