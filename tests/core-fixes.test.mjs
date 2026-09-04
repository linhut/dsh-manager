/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// DSH Manager 核心修复回归测试
// 覆盖代码评审中修复的问题：流式下载、zip64、YAML 下划线键、IPC 超时层等
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

// ====== T9: 核心修复回归 ======
describe('T9: 核心修复回归', () => {
  // 14.1: portable-node 流式下载（避免 OOM）
  it('portable-node 使用流式下载而非 arrayBuffer', () => {
    const src = read('packages/core/src/portable-node.js');
    assert.ok(!src.includes('await resp.arrayBuffer()'), '不应再使用 arrayBuffer 整个载入内存');
    assert.ok(src.includes('resp.body.getReader()'), '应使用流式读取');
    assert.ok(src.includes('createWriteStream'), '应写入文件流');
    assert.ok(src.includes('content-length') || src.includes('contentLength'), '应有 Content-Length 校验');
  });

  // 16.2: AbortSignal.timeout → AbortController（Node 17.3- 兼容）
  it('skill-manager 不再使用 AbortSignal.timeout', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(!src.includes('AbortSignal.timeout('), '不应依赖 Node 17.3+ 的 AbortSignal.timeout');
  });

  // 16.3: zip64 检测
  it('skill-manager 检测 zip64', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes('0x06064b50'), '应检测 zip64 结束记录签名');
    assert.ok(src.includes('不支持 zip64'), '应抛出明确的 zip64 错误');
  });

  // 16.1: zip 截断校验
  it('skill-manager 校验 zip 中央目录条目数', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes('totalEntries'), '应读取中央目录总条目数');
    assert.ok(src.includes('zip 文件不完整'), '应有截断检测错误');
  });

  // 16.4: importFromDirectory 排除 .git/node_modules
  it('skill-manager 导入目录时排除无关目录', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes("'node_modules'"), '应排除 node_modules');
    assert.ok(src.includes('.DS_Store'), '应排除 .DS_Store');
    assert.ok(src.includes('filter'), '应使用 cpSync filter');
  });

  // 7.3: YAML 下划线键不静默丢失
  it('yaml-utils 保留 _ 开头的键（除 _comment）', () => {
    const src = read('packages/core/src/yaml-utils.js');
    // 不应再无条件跳过所有 _ 前缀键
    assert.ok(!src.includes("if (key.startsWith('_')) continue;"), '不应跳过所有 _ 前缀键');
    assert.ok(src.includes("key.startsWith('_comment')"), '应只跳过 _comment 元键');
  });

  // 8.1/12.1: PNPM_NOT_FOUND 错误码
  it('errors.js 提供 PNPM_NOT_FOUND 错误码', () => {
    const src = read('packages/core/src/errors.js');
    assert.ok(src.includes("PNPM_NOT_FOUND: 'PNPM_NOT_FOUND'"), '应有 PNPM_NOT_FOUND 错误码');
    assert.ok(src.includes('INVALID_PARAMS'), '应有 INVALID_PARAMS 错误码');
  });

  // 8.2: DSHError 携带 cause
  it('DSHError 设置 error.cause', () => {
    const src = read('packages/core/src/errors.js');
    assert.ok(src.includes('cause'), '应设置 cause 链');
  });

  // 11.3: MCP 对称引号剥离
  it('mcp-manager 对称引号剥离', () => {
    const src = read('packages/core/src/mcp-manager.js');
    assert.ok(src.includes('value.slice(1, -1)'), '应使用对称切片剥离引号');
    assert.ok(!src.includes("replace(/^['\"]*|['\"]*$/g, '')"), '不应使用非对称正则剥离');
  });

  // 6.2: netstat 缓存（findAvailablePort 性能优化）
  it('process-manager 有 netstat 缓存', () => {
    const src = read('packages/core/src/process-manager.js');
    assert.ok(src.includes('_netstatCache'), '应有 netstat 缓存');
    assert.ok(src.includes('PORT_CACHE_TTL'), '应有缓存 TTL');
  });

  // 9.2: dirSize 异步化
  it('data-manager dirSize 异步且有深度限制', () => {
    const src = read('packages/core/src/data-manager.js');
    assert.ok(src.includes('async function dirSize'), 'dirSize 应为异步');
    assert.ok(src.includes('depth > 12'), '应有深度限制');
  });

  // 10.1: profile list 返回 entryCount
  it('profile-manager list 返回 entryCount', () => {
    const src = read('packages/core/src/profile-manager.js');
    assert.ok(src.includes('entryCount'), '应返回 entryCount 字段');
  });

  // 10.2: profile backup 排除 node_modules/.git
  it('profile-manager backup 排除大目录', () => {
    const src = read('packages/core/src/profile-manager.js');
    assert.ok(src.includes("'node_modules'"), '应排除 node_modules');
    assert.ok(src.includes(".git"), '应排除 .git');
    assert.ok(src.includes('filter'), '应使用 cpSync filter');
  });

  // 5.1: checkCommand 识别 stderr 版本输出
  it('env-check 识别 stderr 版本输出', () => {
    const src = read('packages/core/src/env-check.js');
    assert.ok(src.includes('if (stderrVersion)'), '应从 stderr 提取版本号');
  });

  // 5.2: Node 最低版本校验
  it('env-check 校验 Node 最低版本 >= 20.1', () => {
    const src = read('packages/core/src/env-check.js');
    assert.ok(src.includes('nodeVer[0] < 20'), '应校验主版本');
    assert.ok(src.includes('nodeVer[0] === 20 && nodeVer[1] < 1'), '应校验次版本');
  });

  // 3.3: readdirSync recursive 替代
  it('installer 不再使用 readdirSync recursive', () => {
    const src = read('packages/core/src/installer.js');
    // 检查 readdirSync 不使用 recursive 选项（仅检查 readdirSync 调用，不是 rmSync/mkdirSync）
    const lines = src.split('\n');
    for (const line of lines) {
      if (line.includes('readdirSync') && line.includes('recursive')) {
        assert.fail('readdirSync 不应使用 recursive: ' + line.trim());
      }
    }
    assert.ok(src.includes('_hasDeleteMarker'), '应有手动遍历辅助函数');
  });

  // 15.1: reply-language AGENTS.md 写入失败包装
  it('reply-language 包装 AGENTS.md 写入错误', () => {
    const src = read('packages/core/src/reply-language.js');
    assert.ok(src.includes('写入 AGENTS.md 失败'), '应包装为 DSHError');
  });

  // 1.4: isDSHInPath 语义修正
  it('dsh-utils isDSHInPath 检查 PATH 而非安装', () => {
    const src = read('packages/core/src/dsh-utils.js');
    assert.ok(src.includes("cmd !== 'dsh'"), '应排除兜底字符串');
  });

  // utils.js: IPC 统一通信层
  it('utils.js 提供 callIPC 通信层', () => {
    const src = read('src/assets/js/modules/utils.js');
    assert.ok(src.includes('async function callIPC'), '应有 callIPC 函数');
    assert.ok(src.includes('window.callIPC'), '应暴露 callIPC');
    assert.ok(src.includes('timeoutPromise'), '应复用超时管理');
  });
});
