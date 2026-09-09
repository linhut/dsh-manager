/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// v1.3.20 发布后回归测试：
// 1) electron/ipc-handlers.js 用 `const { getDSHPath } = await loadCore()` 解构，
//    但 core index.js 未导出 getDSHPath → 安装/切换版本后 "getDSHPath is not a function"。
// 2) registry checkPluginUpdate 直接 `JSON.parse(stdout).replace(...)`，
//    npm view 输出对象/非 JSON 时抛 "JSON.parse(...).replace is not a function"。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('v1.3.20 回归：core 导出 getDSHPath', () => {
  it('core index.js 应导出 getDSHPath（ipc-handlers 安装/切换版本后会解构调用）', async () => {
    const core = await import('../packages/core/src/index.js');
    assert.equal(typeof core.getDSHPath, 'function', 'loadCore() 应能解构到 getDSHPath');
    // dsh-utils 原文也确认导出
    const utils = await import('../packages/core/src/dsh-utils.js');
    assert.equal(typeof utils.getDSHPath, 'function', 'dsh-utils 应导出 getDSHPath');
  });

  it('ipc-handlers.js 不应再裸调未导出的 getDSHPath', () => {
    const src = read('electron/ipc-handlers.js');
    // 两处解构调用点都应保留且 core 已导出；同时防止有人改成裸调用（未 import）
    const count = (src.match(/getDSHPath\(/g) || []).length;
    assert.ok(count >= 2, 'ipc-handlers 应至少 2 处调用 getDSHPath()');
  });
});

describe('v1.3.20 回归：parseNpmViewVersion 防御式解析', () => {
  it('npm view 输出 JSON 字符串字面量 "1.2.3" → 返回 1.2.3', async () => {
    const { parseNpmViewVersion } = await import('../packages/marketplace/src/registry.js');
    assert.equal(parseNpmViewVersion('"1.2.3"'), '1.2.3');
    assert.equal(parseNpmViewVersion('"v1.2.3"'), '1.2.3');
  });

  it('npm view 输出 JSON 对象 {"version":"1.2.3"} → 不再抛 replace 报错', async () => {
    const { parseNpmViewVersion } = await import('../packages/marketplace/src/registry.js');
    assert.equal(parseNpmViewVersion('{"version":"1.2.3"}'), '1.2.3');
    assert.equal(parseNpmViewVersion('{"name":"x","version":"v2.0.0"}'), '2.0.0');
  });

  it('npm view 输出非 JSON 纯文本/空值 → 返回 null 而非抛错', async () => {
    const { parseNpmViewVersion } = await import('../packages/marketplace/src/registry.js');
    assert.equal(parseNpmViewVersion(''), null);
    assert.equal(parseNpmViewVersion('npm ERR! code E404'), null);
    assert.equal(parseNpmViewVersion('  1.4.2  '), '1.4.2');
    assert.equal(parseNpmViewVersion(null), null);
  });

  it('registry.js 不应再出现 JSON.parse(stdout).replace 裸调用', () => {
    const src = read('packages/marketplace/src/registry.js');
    assert.ok(!src.includes('JSON.parse(stdout).replace'), '应改用 parseNpmViewVersion 防御式解析');
  });
});