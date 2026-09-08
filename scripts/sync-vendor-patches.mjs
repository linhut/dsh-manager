#!/usr/bin/env node
/**
 * sync-vendor-patches.mjs
 *
 * 将 vendor-patches/ 下固化的第三方包补丁同步到 ~/.dsh profiles 的真实 node_modules。
 * 背景：dsh-mcp-client 的 MCP 握手超时、dsh-web-app 的 announceReady 8s 兜底，
 * 历史上直接改 node_modules 内的文件，重装/升级 @deepseek-ai/dsh 后会被覆盖丢失。
 * 本脚本将已修复的权威文件归档在仓库 vendor-patches/，幂等重放：
 *   - 目标包版本与归档版本一致时才应用（版本不同则告警跳过，提示重新归档）；
 *   - 已包含补丁特征串则跳过（幂等）；
 *   - 应用前自动备份原文件为 index.js.vendor-bak-<ts>。
 *
 * 用法：node scripts/sync-vendor-patches.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PATCHES_DIR = join(REPO_ROOT, 'vendor-patches');
const PROFILES_ROOT = join(homedir(), '.dsh', 'profiles');

const dryRun = process.argv.includes('--dry-run');

// 每个补丁的元信息：归档子目录、目标包名、特征串（存在即视为已应用）
const PATCHES = [
  {
    archive: 'dsh-mcp-client@0.1.2-rc.1',
    pkg: 'dsh-mcp-client',
    marker: 'CONNECT_TIMEOUT_MS = 2e4',
    rel: 'lib/index.js',
    note: 'MCP stdio 握手 20s 超时，防 codegraph 等本地 server 挂起拖死 loader',
  },
  {
    archive: 'dsh-web-app@0.1.2-rc.1',
    pkg: 'dsh-web-app',
    marker: 'announceWhenReady, 8000',
    rel: 'lib/index.js',
    note: 'announceReady 8s 兜底，loader 因 include/UI bundle 挂起时仍打印认证 URL',
  },
  {
    archive: 'dsh-llm@0.1.2-rc.1',
    pkg: 'dsh-llm',
    marker: 'ADAPTER_CONTRACT_MISSING',
    rel: 'lib/index.js',
    note: '插件适配器崩溃隔离信号：prepareCall 契约缺失/执行失败转为带 provider 上下文的 LlmError 并落盘 plugin-quarantine.jsonl，供 dsh-manager 自动暂停问题插件',
  },
];

function collectTargets() {
  const targets = [];
  if (!existsSync(PROFILES_ROOT)) return targets;
  // 各 profile 的 node_modules
  for (const profile of readdirSync(PROFILES_ROOT)) {
    const nm = join(PROFILES_ROOT, profile, 'node_modules', '@deepseek-ai');
    if (!existsSync(nm)) continue;
    for (const p of PATCHES) {
      const pkgDir = join(nm, p.pkg);
      if (existsSync(pkgDir)) targets.push({ profile, ...p, pkgDir });
    }
  }
  // profiles 根共享层 node_modules（若存在）
  const rootNm = join(PROFILES_ROOT, 'node_modules', '@deepseek-ai');
  if (existsSync(rootNm)) {
    for (const p of PATCHES) {
      const pkgDir = join(rootNm, p.pkg);
      if (existsSync(pkgDir)) targets.push({ profile: '<共享层>', ...p, pkgDir });
    }
  }
  return targets;
}

function readVersion(pkgDir) {
  try {
    const raw = readFileSync(join(pkgDir, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '?';
  } catch {
    return '?';
  }
}

let applied = 0, skipped = 0, warned = 0;
const report = [];

for (const t of collectTargets()) {
  const archiveVersion = t.archive.split('@')[1];
  const actualVersion = readVersion(t.pkgDir);
  const dest = join(t.pkgDir, t.rel);
  const src = join(PATCHES_DIR, t.archive, t.rel);

  if (actualVersion !== archiveVersion) {
    warned++;
    report.push(`[跳过-版本不符] ${t.profile}/${t.pkg}@${actualVersion} != 归档 ${archiveVersion}，请重新归档后再同步`);
    continue;
  }
  if (!existsSync(dest)) {
    warned++;
    report.push(`[跳过-目标缺失] ${t.profile}/${t.pkg} 的 ${t.rel} 不存在，可能结构变化，请人工核对`);
    continue;
  }
  const content = readFileSync(dest, 'utf8');
  if (content.includes(t.marker)) {
    skipped++;
    report.push(`[已应用] ${t.profile}/${t.pkg}@${actualVersion}（特征串已存在，跳过）`);
    continue;
  }

  if (dryRun) {
    applied++;
    report.push(`[将应用] ${t.profile}/${t.pkg}@${actualVersion} <- ${t.archive}（${t.note}）`);
    continue;
  }

  const bak = `${dest}.vendor-bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(dest, bak);
  writeFileSync(dest, readFileSync(src));
  applied++;
  report.push(`[已应用] ${t.profile}/${t.pkg}@${actualVersion} <- ${t.archive}（备份: ${bak}）`);
}

console.log(report.length ? report.join('\n') : '（未发现可同步的 profile node_modules）');
console.log(`\n汇总: 应用 ${applied} / 跳过 ${skipped} / 告警 ${warned}${dryRun ? '（dry-run）' : ''}`);
process.exit(warned > 0 ? 2 : 0);
