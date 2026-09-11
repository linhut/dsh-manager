#!/usr/bin/env node
/**
 * 打包产物完整性断言（CI 后置兜底）
 *
 * 背景：dsh-skills 是 git 子模块，且通过 package.json 的 build.extraResources 声明
 * 打进 resources/。若构建机未执行 `git submodule update --init --recursive`，
 * electron-builder 会静默打包出**空的** resources/dsh-skills，构建全程无报错，
 * 只在用户机器运行到「未找到内置 dsh-skills 资源」时才暴露。
 *
 * 本脚本在 build 步骤之后执行，做两层校验（逻辑复用 scripts/lib/packaged-resources.mjs，
 * 与 npm run verify 第 9 项检查同源，避免两处实现漂移）：
 *   1) 源码侧：extraResources.from 是否存在、dsh-skills/skills 是否有技能目录
 *   2) 产物侧：dist 下每个打包目录的 resources/<to> 是否真实存在（含 dsh-skills/skills 非空）
 *
 * 退出码：0 = 全部通过；1 = 存在缺失（CI 直接 fail）
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectExtraResourceChecks, readExtraResources } from './lib/packaged-resources.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// 可选参数：--dist <目录名>（默认 dist；用于校验试构建产物，如 dist-check）
const distName = (() => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dist' && argv[i + 1]) return argv[i + 1];
    if (a.startsWith('--dist=')) return a.slice('--dist='.length);
  }
  return 'dist';
})();

// ---------- 读取 package.json 的 extraResources 声明 ----------
let extraResources = [];
try {
  extraResources = readExtraResources(projectRoot);
} catch (e) {
  console.error('❌ 无法读取 package.json:', e.message || e);
  process.exit(1);
}

if (extraResources.length === 0) {
  console.log('ℹ️  package.json 未声明 build.extraResources，跳过产物完整性检查');
  process.exit(0);
}

console.log(`=== 打包产物完整性断言（extraResources 共 ${extraResources.length} 项，产物目录 ${distName}）===\n`);

// ---------- 源码侧 + 产物侧检查（共享逻辑） ----------
const { passes, failures, packagedDirs, notes } = collectExtraResourceChecks(projectRoot, { distName });

// ---------- 汇总 ----------
console.log('--- 汇总 ---');
for (const p of passes) console.log(`  PASS  ${p}`);
for (const f of failures) console.log(`  FAIL  ${f}`);
for (const n of notes) console.log(`  NOTE  ${n}`);
console.log(`\n结果：${passes.length} PASS / ${failures.length} FAIL${packagedDirs.length === 0 ? '（dist 无已解包产物，仅校验源码侧）' : ''}`);

if (failures.length > 0) {
  console.error('\n❌ 打包产物完整性断言失败：extraResources 声明的资源未真实进入产物。');
  console.error('   常见原因：构建机未执行 `git submodule update --init --recursive`（dsh-skills 子模块为空）。');
  console.error('   修复：git submodule update --init --recursive，然后重新构建（npm run build:win / build:linux / build:mac）。');
  process.exit(1);
}

console.log('\n✅ 全部通过：extraResources 声明项在产物中均真实存在。');
process.exit(0);
