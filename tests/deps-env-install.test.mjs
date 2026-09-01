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
