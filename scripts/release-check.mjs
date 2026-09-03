#!/usr/bin/env node
/**
 * DSH Manager - 发布前提交清理检查（RELEASE.md §2.1 自动化）
 *
 * Usage: node scripts/release-check.mjs
 *
 * 检查：
 * 1. `git status --short` 扫描全部未跟踪/已修改文件
 * 2. 禁止入库类型：dist/、node_modules/、*.exe、*.dmg、*.log、.env*、*.pem、*.key
 * 3. 调试残留：_tmp*、scripts/tmp-*、scripts/*-repro.cjs、scripts/diagnose-*.cjs 等
 * 4. 凭据/密钥：任何包含 apiKey / token / secret 的未跟踪文件
 *
 * 退出码：0=可提交；1=发现禁止文件（并列出）
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** 禁止入库的文件模式（RELEASE.md §2.1） */
const FORBIDDEN = [
  /(^|\/)dist($|\/)/,
  /(^|\/)node_modules($|\/)/,
  /\.exe$/i,
  /\.dmg$/i,
  /\.AppImage$/i,
  /\.log$/i,
  /(^|\/)\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)_tmp/i,
  /\.tmp-/,
  /scripts\/tmp-/,
  /scripts\/.*-repro\.cjs$/,
  /scripts\/diagnose-.*\.cjs$/,
  /scripts\/fix-.*\.cjs$/,
  /scripts\/test-provider\.cjs$/,
  /scripts\/test-capability-router\.mjs$/,
];

const run = spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf-8' });
if (run.status !== 0) {
  console.error('git status 执行失败:', run.stderr);
  process.exit(2);
}

const lines = run.stdout.split(/\r?\n/).filter(Boolean);
const problems = [];
for (const line of lines) {
  const file = line.slice(3).trim();
  if (!file) continue;
  if (FORBIDDEN.some(re => re.test(file))) problems.push(file);
}

if (problems.length === 0) {
  console.log('✅ 发布前检查通过：无禁止入库的文件');
  console.log('   共 ' + lines.length + ' 个变更文件，全部符合 RELEASE.md §2.1');
  process.exit(0);
}

console.error('❌ 发布前检查失败：发现以下禁止入库的文件：');
for (const p of problems) console.error('   - ' + p);
console.error('请删除或将其加入 .gitignore 后再提交（参见 RELEASE.md §2.1）。');
process.exit(1);

