/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// DSH Manager 依赖环境安装修复回归测试
// 覆盖用户报告的问题：
// 1. 便携版 Node（最小化安装）不在系统 PATH，安装器/检测/命令调用需注入便携版 bin 目录
// 2. 正常安装（winget/brew/apt）后当前进程 PATH 是旧值，需从注册表刷新
// 3. 前端错误分类需区分"命令未找到"vs"权限不足"
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

// ====== dsh-utils buildCommandEnv ======
describe('依赖环境：buildCommandEnv 便携版 PATH 注入', () => {
  it('dsh-utils 定义并导出 buildCommandEnv', () => {
    const src = read('packages/core/src/dsh-utils.js');
    assert.ok(src.includes('export function buildCommandEnv()'), '应导出 buildCommandEnv');
    assert.ok(src.includes('envNodeDir'), '应基于便携版 Node 目录');
    assert.ok(src.includes("process.env.PATH || ''"), '便携版存在时前缀注入 PATH');
  });

  it('buildCommandEnv 在 core/index.js 中导出', () => {
    const src = read('packages/core/src/index.js');
    assert.ok(src.includes('buildCommandEnv'), 'core 入口应导出 buildCommandEnv');
  });

  it('dsh-utils 内所有 npm/pnpm/node/dsh 命令调用均注入运行时环境', () => {
    const src = read('packages/core/src/dsh-utils.js');
    const lines = src.split('\n');
    // 逐行扫描真实 execa 调用（排除注释行与 reg 注册表查询），
    // 单行调用需自带 env，多行调用需在其后 3 行内出现 env
    let cmdCount = 0;
    lines.forEach((line, i) => {
      if (!line.includes("execa('")) return;
      const trimmed = line.trim();
      // 跳过注释（JSDoc * 行与 // 行）与 reg（系统注册表查询，无需便携版 Node）
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      if (trimmed.includes("execa('reg'")) return;
      cmdCount++;
      const window = lines.slice(i, i + 4).join(' ');
      assert.ok(window.includes('env'), '命令调用应注入 env: ' + trimmed);
    });
    assert.ok(cmdCount >= 6, '应有多处命令调用，实际 ' + cmdCount);
  });
});

// ====== refreshSystemPath ======
describe('依赖环境：正常安装后刷新进程 PATH', () => {
  it('dsh-utils 定义并导出 refreshSystemPath', () => {
    const src = read('packages/core/src/dsh-utils.js');
    assert.ok(src.includes('export async function refreshSystemPath()'), '应导出 refreshSystemPath');
    assert.ok(src.includes('reg'), 'Windows 应从注册表读取 PATH');
    assert.ok(src.includes("process.platform !== 'win32'"), '非 Windows 原样返回');
  });

  it('ipc-handlers 在正常安装后刷新 PATH（Node/git）', () => {
    const src = read('electron/ipc-handlers.js');
    assert.ok(src.includes('refreshSystemPath'), '应引用 refreshSystemPath');
    // install-nodejs 和 install-git 成功后都应刷新
    const nodejsBlock = src.slice(src.indexOf("'app:install-nodejs'"), src.indexOf("'app:install-git'"));
    const gitBlock = src.slice(src.indexOf("'app:install-git'"), src.indexOf("'app:install-git'") + 2200);
    assert.ok(nodejsBlock.includes('refreshSystemPath'), 'install-nodejs 应刷新 PATH');
    assert.ok(gitBlock.includes('refreshSystemPath'), 'install-git 应刷新 PATH');
  });
});

// ====== installer 注入便携版 PATH ======
describe('依赖环境：installer 命令调用注入便携版 PATH', () => {
  it('installer 导入 buildCommandEnv 并在构造函数缓存', () => {
    const src = read('packages/core/src/installer.js');
    assert.ok(src.includes('buildCommandEnv'), '应导入 buildCommandEnv');
    assert.ok(src.includes('this._commandEnv = buildCommandEnv().env'), '构造函数应缓存 commandEnv');
  });

  it('installer 的 _runStreaming 合并 commandEnv', () => {
    const src = read('packages/core/src/installer.js');
    const streaming = src.slice(src.indexOf('async _runStreaming'), src.indexOf('async _runStreaming') + 1200);
    assert.ok(streaming.includes('commandEnv'), '_runStreaming 应合并 commandEnv');
    assert.ok(streaming.includes('env: commandEnv'), '_runStreaming 应传 env');
  });

  it('installer 直接 execa 调用（corepack/npm uninstall/npm root/pnpm config）注入 env', () => {
    const src = read('packages/core/src/installer.js');
    for (const call of ['corepack', "npm', ['uninstall'", "npm', ['root'", "pnpm', ['config'"]) {
      assert.ok(src.includes(call), '应存在调用: ' + call);
    }
    assert.ok(src.includes('env: this._commandEnv'), '应注入 _commandEnv');
  });
});

// ====== pnpm-check / env-check ======
describe('依赖环境：检测命令注入运行时环境', () => {
  it('pnpm-check checkPnpm 注入 buildCommandEnv', () => {
    const src = read('packages/core/src/pnpm-check.js');
    assert.ok(src.includes('buildCommandEnv'), '应导入 buildCommandEnv');
    const check = src.slice(src.indexOf('export async function checkPnpm'), src.indexOf('export async function checkPnpm') + 500);
    assert.ok(check.includes('env'), 'checkPnpm 应传 env');
  });

  it('env-check checkCommand 支持运行时环境注入（pnpm 检测）', () => {
    const src = read('packages/core/src/env-check.js');
    assert.ok(src.includes('useRuntimeEnv'), '应支持运行时环境选项');
    assert.ok(src.includes("checkCommand('pnpm', 'pnpm', { useRuntimeEnv: true })"), 'pnpm 检测应注入运行时环境');
  });
});

// ====== ipc-handlers install-pnpm ======
describe('依赖环境：install-pnpm 注入运行时环境', () => {
  it('install-pnpm 使用 buildCommandEnv 的 env', () => {
    const src = read('electron/ipc-handlers.js');
    const block = src.slice(src.indexOf("'app:install-pnpm'"), src.indexOf("'app:install-pnpm'") + 1200);
    assert.ok(block.includes('buildCommandEnv'), '应引用 buildCommandEnv');
    assert.ok(block.includes('env: runtimeEnv'), 'npm 安装 pnpm 应传运行时 env');
  });
});

// ====== portable-node buildRuntimeEnv 复用 ======
describe('依赖环境：buildRuntimeEnv 复用统一实现', () => {
  it('portable-node buildRuntimeEnv 委托 buildCommandEnv', () => {
    const src = read('packages/core/src/portable-node.js');
    assert.ok(src.includes('buildCommandEnv'), '应导入 buildCommandEnv');
    const fn = src.slice(src.indexOf('export async function buildRuntimeEnv'), src.indexOf('export async function buildRuntimeEnv') + 300);
    assert.ok(fn.includes('return buildCommandEnv()'), '应委托 buildCommandEnv');
  });
});

// ====== 前端错误分类 ======
describe('前端：安装失败错误分类改进', () => {
  it('installDSH 区分"命令未找到"与"权限不足"', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('命令不可用'), '应识别命令不可用');
    assert.ok(src.includes('ENOENT|command not found'), '应匹配 ENOENT/command not found');
    assert.ok(src.includes('未找到命令'), '应有命令未找到提示');
    // 权限分支仍在（作为 else if）
    assert.ok(src.includes("errMsg.includes('EACCES') || errMsg.includes('EPERM') || errMsg.includes('权限') || errMsg.includes('Access')"), '权限分支应保留');
  });
});
// ====== ARM 架构检测与调试日志增强（v1.3.13） ======
describe('ARM 架构检测：detectRealArch / getSystemDiagnostics', () => {
  it('dsh-utils 导出 detectRealArch（注册表+环境变量检测真实硬件）', () => {
    const src = read('packages/core/src/dsh-utils.js');
    assert.ok(src.includes('export async function detectRealArch()'), '应导出 detectRealArch');
    assert.ok(src.includes('CentralProcessor'), '应读取注册表 CentralProcessor（ARM 判定）');
    assert.ok(src.includes('PROCESSOR_ARCHITEW6432'), '应检查 PROCESSOR_ARCHITEW6432');
    assert.ok(src.includes('PROCESSOR_ARCHITECTURE'), '应检查 PROCESSOR_ARCHITECTURE');
  });

  it('dsh-utils 导出 getSystemDiagnostics（完整诊断采集）', () => {
    const src = read('packages/core/src/dsh-utils.js');
    assert.ok(src.includes('export async function getSystemDiagnostics()'), '应导出 getSystemDiagnostics');
    assert.ok(src.includes('realArch'), '诊断应含真实架构');
    assert.ok(src.includes('pathEntries'), '诊断应含 PATH 条目');
    assert.ok(src.includes('npmPrefix'), '诊断应含 npm prefix');
  });

  it('core/index.js 导出 detectRealArch/getSystemDiagnostics', () => {
    const src = read('packages/core/src/index.js');
    assert.ok(src.includes('detectRealArch, getSystemDiagnostics'), '应导出两个新函数');
  });

  it('portable-node 便携版按真实架构下载（ARM64 关键修复）', () => {
    const src = read('packages/core/src/portable-node.js');
    assert.ok(src.includes('detectRealArch'), '应导入 detectRealArch');
    assert.ok(src.includes('await detectRealArch()'), 'archiveName 应调用真实架构检测');
  });
});

describe('调试日志增强：安装详细情况进入 debug.log', () => {
  it('makeEnvPushProgress 双写（前端 + debug.log）', () => {
    const src = read('electron/ipc-handlers.js');
    assert.ok(src.includes('function makeEnvPushProgress(win)'), '应定义共享进度转发');
    assert.ok(src.includes("writeLog(level, '[env-install] ' + message)"), '进度应写 debug.log');
    // 4 个安装 handler 全部使用
    const count = src.split('makeEnvPushProgress(win)').length - 1;
    assert.ok(count >= 5, 'helper 定义 + 4 个 handler 调用，实际 ' + count);
  });

  it('正常安装诊断日志（命令结果/PATH/检测/诊断）', () => {
    const src = read('electron/ipc-handlers.js');
    assert.ok(src.includes('Node 安装命令完成'), '应记录安装命令结果');
    assert.ok(src.includes('PATH 刷新前'), '应记录 PATH 刷新前');
    assert.ok(src.includes('PATH 刷新后'), '应记录 PATH 刷新后');
    assert.ok(src.includes('安装后检测'), '应记录安装后检测');
    assert.ok(src.includes('安装完成后系统诊断'), '应记录系统诊断');
    assert.ok(src.includes('正常安装 Node 失败'), '应记录 catch 错误');
  });

  it('便携版安装诊断日志（架构/解压/校验/安装后）', () => {
    const src = read('electron/ipc-handlers.js');
    assert.ok(src.includes('便携版安装后检测'), '应记录安装后检测');
    assert.ok(src.includes('便携版安装完成后系统诊断'), '应记录系统诊断');
    assert.ok(src.includes('便携版 Node 安装失败'), '应记录 catch 错误');
    const pn = read('packages/core/src/portable-node.js');
    assert.ok(pn.includes('便携版 Node 架构选择'), '应记录架构选择');
    assert.ok(pn.includes('便携版 Node 解压中'), '应记录解压');
    assert.ok(pn.includes('便携版 Node 校验结果'), '应记录校验结果');
  });

  it('env-check 检测失败记录命令/错误详情', () => {
    const src = read('packages/core/src/env-check.js');
    assert.ok(src.includes('命令检测失败'), '应记录检测失败');
    assert.ok(src.includes('便携版兜底'), '应记录便携版兜底尝试');
  });

  it('环境页提供复制调试日志按钮', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('复制调试日志'), '环境页应有复制日志按钮');
    assert.ok(src.includes('debug.log'), '应提示日志路径');
  });
});

