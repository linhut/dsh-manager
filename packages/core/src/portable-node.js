/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_PATHS, getDSHVersion } from './dsh-utils.js';
import { getPortableNodeBin } from './env-check.js';
import { DSHError, DSHErrorCodes } from './errors.js';

/** npmmirror Node 二进制镜像（国内低配机下载提速） */
const NODE_MIRROR = 'https://registry.npmmirror.com/-/binary/node';
/** 下载超时（毫秒），便携版 zip 约 25-30MB，低配机给足 5 分钟 */
const DOWNLOAD_TIMEOUT = 5 * 60_000;

/**
 * 获取最新 LTS 版本号（从 npmmirror index.json 解析，lts 字段非空的最新条目）
 * @returns {Promise<string>} 如 'v22.12.0'
 */
export async function getLatestLTSVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(`${NODE_MIRROR}/index.json`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    if (!Array.isArray(list)) throw new Error('index.json 格式异常');
    // lts 字段非空即为 LTS 版本，取版本号最大者
    const ltsVersions = list
      .filter(v => v && v.lts)
      .map(v => String(v.version || ''))
      .filter(v => /^v?\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const pa = a.replace(/^v/, '').split('.').map(Number);
        const pb = b.replace(/^v/, '').split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        }
        return 0;
      });
    if (ltsVersions.length === 0) throw new Error('未找到 LTS 版本');
    const latest = ltsVersions[ltsVersions.length - 1];
    return latest.startsWith('v') ? latest : `v${latest}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 平台对应的 Node 压缩包文件名
 * @param {string} version - 如 'v22.12.0'
 * @returns {string}
 */
function archiveName(version) {
  const plat = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (plat === 'win32') return `node-${version}-win-${arch}.zip`;
  if (plat === 'darwin') return `node-${version}-darwin-${arch}.tar.gz`;
  return `node-${version}-linux-${arch}.tar.xz`;
}

/**
 * 下载并解压便携版 Node 到 ~/.dsh/env/node/
 * @param {object} [opts]
 * @param {string} [opts.version] - 指定版本（如 'v22.12.0'），默认最新 LTS
 * @param {(msg: string) => void} [opts.onProgress] - 进度回调
 * @returns {Promise<{success: boolean, version: string, bin: string, npmBin: string}>}
 */
export async function installPortableNode(opts = {}) {
  const { version, onProgress } = opts;
  const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };

  const nodeDir = DSH_PATHS.envNodeDir;
  const envDir = DSH_PATHS.envDir;

  // 1. 确定版本
  let ver = version;
  if (!ver) {
    log('正在查询最新 LTS 版本...');
    ver = await getLatestLTSVersion();
  }
  const cleanVer = ver.startsWith('v') ? ver : `v${ver}`;
  const fileName = archiveName(cleanVer);
  const url = `${NODE_MIRROR}/${cleanVer}/${fileName}`;
  const downloadPath = join(envDir, fileName);

  log(`开始下载 ${fileName}（镜像源）...`);

  // 2. 下载（流式，跟随重定向）
  try {
    mkdirSync(envDir, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const fs = await import('node:fs');
      fs.writeFileSync(downloadPath, buf);
      log(`下载完成（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    throw new DSHError(
      DSHErrorCodes.DSH_INSTALL_FAILED,
      `便携版 Node 下载失败: ${error.message}\n请检查网络，或改用系统包管理器安装。`
    );
  }

  // 3. 解压（清空旧目录）
  try {
    if (existsSync(nodeDir)) rmSync(nodeDir, { recursive: true, force: true });
    mkdirSync(nodeDir, { recursive: true });
    log('正在解压...');
    if (process.platform === 'win32') {
      // Windows 用系统 tar.exe（内置 bsdtar >= 10.1803），提取 zip 文件
      const tarPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await execa(tarPath, ['-xf', downloadPath, '-C', nodeDir, '--strip-components=1'], { timeout: 120_000 });
    } else {
      await execa('tar', ['-xf', downloadPath, '-C', nodeDir, '--strip-components=1'], { timeout: 120_000 });
    }
  } catch (error) {
    // 解压失败清理残留
    rmSync(nodeDir, { recursive: true, force: true });
    throw new DSHError(DSHErrorCodes.DSH_INSTALL_FAILED, `便携版 Node 解压失败: ${error.message}`);
  } finally {
    try { rmSync(downloadPath, { force: true }); } catch {}
  }

  // 4. 校验
  const bin = process.platform === 'win32'
    ? join(nodeDir, 'node.exe')
    : join(nodeDir, 'bin', 'node');
  const npmBin = process.platform === 'win32'
    ? join(nodeDir, 'npm.cmd')
    : join(nodeDir, 'bin', 'npm');
  try {
    const { stdout } = await execa(bin, ['--version'], { timeout: 10_000 });
    if (!stdout || !stdout.trim()) throw new Error('node --version 无输出');
    log(`✅ 便携版 Node ${stdout.trim()} 安装成功`);
    return { success: true, version: stdout.trim(), bin, npmBin };
  } catch (error) {
    rmSync(nodeDir, { recursive: true, force: true });
    throw new DSHError(DSHErrorCodes.DSH_INSTALL_FAILED, `便携版 Node 校验失败: ${error.message}`);
  }
}

/**
 * 卸载便携版 Node（整体删除目录）
 * @returns {Promise<{success: boolean}>}
 */
export async function uninstallPortableNode() {
  const nodeDir = DSH_PATHS.envNodeDir;
  if (existsSync(nodeDir)) rmSync(nodeDir, { recursive: true, force: true });
  return { success: true };
}

/**
 * 便携版 Node 信息（供 UI 展示）
 * @returns {Promise<{installed: boolean, version: string|null, bin: string|null}>}
 */
export async function getPortableNodeInfo() {
  const bin = process.platform === 'win32'
    ? join(DSH_PATHS.envNodeDir, 'node.exe')
    : join(DSH_PATHS.envNodeDir, 'bin', 'node');
  if (!existsSync(bin)) return { installed: false, version: null, bin: null };
  try {
    const { stdout } = await execa(bin, ['--version'], { reject: false, timeout: 10_000 });
    return { installed: true, version: (stdout || '').trim() || null, bin };
  } catch {
    return { installed: false, version: null, bin: null };
  }
}

export { getDSHVersion };

/**
 * 构建运行时环境变量（低配置运行配置选择通道）
 * 
 * 若便携版 Node 已安装，则将其 bin 目录注入 PATH 前缀，
 * 供 dsh 启动/安装等子进程使用（不污染系统 PATH）。
 * @returns {Promise<{env: object, nodeBin: string|null}>}
 */
export async function buildRuntimeEnv() {
  const nodeBin = getPortableNodeBin();
  if (!nodeBin) return { env: { ...process.env }, nodeBin: null };
  const nodeDir = DSH_PATHS.envNodeDir;
  // Windows: node.exe 在 node 目录；npm.cmd 同目录。POSIX: bin/ 子目录
  const binDir = process.platform === 'win32' ? nodeDir : join(nodeDir, 'bin');
  const sep = process.platform === 'win32' ? ';' : ':';
  const oldPath = process.env.PATH || '';
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${oldPath}`,
  };
  return { env, nodeBin };
}

/**
 * 读取 DSH 运行配置（manager.runtime 键，低配置运行选择通道）
 * @returns {Promise<{node: string, lowMemory: boolean, maxOldSpace: number, port: number}>}
 */
export async function getRuntimeConfig() {
  const { DSHConfig } = await import('./config.js');
  const config = new DSHConfig();
  const rt = (await config.get('manager.runtime')) || {};
  return {
    node: rt.node || 'auto',       // 'auto' | 'portable' | 'system'
    lowMemory: rt.lowMemory !== false,
    maxOldSpace: Number(rt.maxOldSpace) || 512,
    port: Number(rt.port) || 3080,
    retryCount: Number(rt.retryCount) || 3,
  };
}
