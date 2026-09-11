import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DSH_WEB_URL_LINE_RE,
  isDSHWebAuthUrl,
  extractDSHWebAuthUrl,
  preflightDSHProfile,
} from '../packages/core/src/dsh-web-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 测试临时 profile 目录：指向测试目录外部（真实项目根）的 link: 依赖应被判定为违规
const fakeProfileDir = join(__dirname, 'fixtures', 'profile-web');
const repoRoot = join(__dirname, '..');

test('DSH_WEB_URL_LINE_RE 匹配官方打印格式（含 127.0.0.1/localhost）', () => {
  assert.match('dsh web: http://127.0.0.1:3999/?token=abc', DSH_WEB_URL_LINE_RE);
  assert.match('dsh web: http://localhost:3999/?token=abc', DSH_WEB_URL_LINE_RE);
  assert.match('INFO dsh web: http://[::1]:3999/?token=abc', DSH_WEB_URL_LINE_RE);
  assert.doesNotMatch('dsh web 认证失败', DSH_WEB_URL_LINE_RE);
});

test('isDSHWebAuthUrl：回环主机 + token 才合法（官方鉴权 URL 契约）', () => {
  assert.equal(isDSHWebAuthUrl('http://127.0.0.1:3999/?token=abc123'), true);
  assert.equal(isDSHWebAuthUrl('http://localhost:3999/?token=abc123'), true);
  assert.equal(isDSHWebAuthUrl('http://[::1]:3999/?token=abc123'), true);
  // 裸 URL（无 token）不是鉴权 URL —— 官方会拒绝并提示使用打印的 URL
  assert.equal(isDSHWebAuthUrl('http://127.0.0.1:3999/'), false);
  // 外部主机 / 全接口绑定地址不接受
  assert.equal(isDSHWebAuthUrl('http://192.168.1.10:3999/?token=abc'), false);
  assert.equal(isDSHWebAuthUrl('http://0.0.0.0:3999/?token=abc'), false);
  assert.equal(isDSHWebAuthUrl(''), false);
  assert.equal(isDSHWebAuthUrl(null), false);
});

test('extractDSHWebAuthUrl：从打印行提取鉴权 URL，裸 URL 拒绝', () => {
  assert.equal(extractDSHWebAuthUrl('dsh web: http://127.0.0.1:3999/?token=abc'), 'http://127.0.0.1:3999/?token=abc');
  assert.equal(extractDSHWebAuthUrl('dsh web: http://localhost:3999/?token=xyz'), 'http://localhost:3999/?token=xyz');
  assert.equal(extractDSHWebAuthUrl('dsh web: http://127.0.0.1:3999/'), null);
  assert.equal(extractDSHWebAuthUrl('http://127.0.0.1:3999/?token=abc'), null);
  assert.equal(extractDSHWebAuthUrl(''), null);
});

test('preflightDSHProfile：识别指向 profile 外部的 link:/file: 依赖（官方 layout 要求）', () => {
  const deps = {
    'gongwen-skill': `link:${join(repoRoot, 'Documents', 'document-skills', 'gongwen-skill')}`,
    'normal-dep': '^1.0.0',
  };
  const result = preflightDSHProfile(fakeProfileDir, deps);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].name, 'gongwen-skill');
  assert.match(result.violations[0].reason, /plugin tree failed to load/);
});

test('preflightDSHProfile：profile 内 link 依赖与幂等依赖不违规', () => {
  const deps = {
    'local-workspace': `link:./.workspace`,
    'dsh-web-app': 'npm:@deepseek-ai/dsh-web-app@0.1.2-rc.1',
  };
  const result = preflightDSHProfile(fakeProfileDir, deps);
  assert.equal(result.ok, true);
});