/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 凭据文件版本化布局迁移回归测试
// 覆盖：纯扁平迁移 / 混搭布局修复（version + 顶层残留键）/ 合法版本化跳过 / 非法行拒绝
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const coreUrl = pathToFileURL(path.join(root, 'packages/core/src/index.js')).href;
const { DSHConfig } = await import(coreUrl);

async function withTempCred(initial) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-mig-'));
  const credFile = path.join(tmp, '.credentials.yaml');
  if (initial) fs.writeFileSync(credFile, initial);
  const cfg = new DSHConfig();
  cfg.credPath = credFile;
  return { tmp, credFile, cfg };
}

describe('凭据文件版本化布局迁移', () => {
  it('纯扁平布局 → 迁移为版本化布局（备份+缩进）', async () => {
    const { tmp, credFile, cfg } = await withTempCred('MY_CPA_API_KEY: sk-xxx\nOTHER: v2\n');
    const r = await cfg.migrateCredentialsToVersioned();
    const content = fs.readFileSync(credFile, 'utf8');
    assert.equal(r.migrated, true);
    assert.ok(r.backup && fs.existsSync(r.backup), '应生成备份文件');
    assert.match(content, /^version: 1$/m);
    assert.match(content, /^refs:$/m);
    assert.ok(content.includes('  MY_CPA_API_KEY: sk-xxx'), '键应缩进到 refs 下');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('混搭布局（version + 顶层残留扁平键）→ 将残留键移入 refs（修复 DSH 崩溃根因）', async () => {
    const { tmp, credFile, cfg } = await withTempCred('version: 1\nMY_CPA_API_KEY: sk-xxx\nOTHER: v2\n');
    const r = await cfg.migrateCredentialsToVersioned();
    const content = fs.readFileSync(credFile, 'utf8');
    assert.equal(r.migrated, true);
    assert.equal(r.reason, 'mixed-layout');
    assert.ok(content.includes('  MY_CPA_API_KEY: sk-xxx'), '残留键应缩进到 refs 下');
    assert.ok(content.includes('  OTHER: v2'), '其余残留键也应缩进');
    assert.ok(!/^MY_CPA_API_KEY:/m.test(content), '顶层不应再残留 MY_CPA_API_KEY');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('合法版本化布局 → 跳过不迁移', async () => {
    const { tmp, credFile, cfg } = await withTempCred('version: 1\nrefs:\n  K1: v1\n');
    const r = await cfg.migrateCredentialsToVersioned();
    assert.equal(r.migrated, false);
    assert.equal(r.reason, 'already-versioned');
    assert.equal(fs.readFileSync(credFile, 'utf8'), 'version: 1\nrefs:\n  K1: v1\n', '文件不应被改动');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('非法行（YAML 列表）→ 拒绝迁移且不改文件', async () => {
    const { tmp, credFile, cfg } = await withTempCred('KEY1: v1\n- item\n');
    const r = await cfg.migrateCredentialsToVersioned();
    assert.equal(r.migrated, false);
    assert.equal(r.reason, 'not-flat-layout');
    assert.ok(fs.readFileSync(credFile, 'utf8').includes('- item'), '文件不应被改动');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('混搭 + 已有 refs 内容 → 合并保留', async () => {
    const { tmp, credFile, cfg } = await withTempCred('version: 1\nrefs:\n  ALREADY: ok\nMY_KEY: x\n');
    const r = await cfg.migrateCredentialsToVersioned();
    const content = fs.readFileSync(credFile, 'utf8');
    assert.equal(r.migrated, true);
    assert.ok(content.includes('  ALREADY: ok'), '原有 refs 内容应保留');
    assert.ok(content.includes('  MY_KEY: x'), '残留键应合并进 refs');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});