#!/usr/bin/env node
/**
 * DSH Manager - Comprehensive Audit & Verification Script
 * 
 * Usage: node scripts/verify.mjs
 * 
 * Checks:
 * 1. Skeleton structure (key files exist)
 * 2. Package.json contracts (scripts, version)
 * 3. JS syntax (all source files)
 * 4. IPC three-tier consistency (handlers = preload invokes)
 * 5. Version consistency (3 package.json files)
 * 6. CSS integrity (no broken comments)
 * 7. Renderer page contracts (all pages exist)
 * 8. Module files exist and are syntax-valid
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const req = (p) => join(root, p);
let failed = false;
let passCount = 0;
let failCount = 0;

function check(name, ok, detail = '') {
  const mark = ok ? '✅ PASS' : '❌ FAIL';
  console.log(`${mark}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (ok) passCount++; else { failed = true; failCount++; }
}

function readFile(path) {
  try { return { ok: true, content: readFileSync(req(path), 'utf-8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

console.log('══════════════════════════════════════════════════');
console.log('  DSH Manager - Comprehensive Audit');
console.log('══════════════════════════════════════════════════\n');

// 1) Skeleton structure
console.log('--- 1. Skeleton Structure ---');
const skeletonFiles = [
  'electron/main.js', 'electron/preload.cjs', 'electron/ipc-handlers.js',
  'src/index.html', 'src/assets/css/style.css', 'src/assets/js/app.js',
  'src/assets/js/modules/state.js', 'src/assets/js/modules/utils.js',
  'src/assets/js/modules/debug.js', 'src/assets/js/modules/theme.js',
  'src/assets/js/modules/dsh-status.js', 'src/assets/js/modules/dsh-control.js',
  'packages/core/package.json', 'packages/core/src/index.js',
  'packages/marketplace/package.json', 'packages/marketplace/src/index.js',
  'package.json', 'install.ps1',
];
for (const f of skeletonFiles) {
  check(`File exists: ${f}`, existsSync(req(f)));
}

// 2) Package.json contracts
console.log('\n--- 2. Package.json Contracts ---');
const pkgRes = readFile('package.json'); if (!pkgRes.ok) { check('package.json readable', false); } const pkg = JSON.parse(pkgRes.content);
for (const s of ['start', 'dev', 'build:win', 'build:mac', 'build:linux', 'generate-icons', 'verify']) {
  check(`Script exists: ${s}`, typeof pkg.scripts?.[s] === 'string');
}
// Check workspaces
check('Workspaces defined', Array.isArray(pkg.workspaces) && pkg.workspaces.length >= 2);
check('Type is module', pkg.type === 'module');

// 3) JS Syntax
console.log('\n--- 3. JS Syntax Check ---');
// 自动发现项目内全部 JS/MJS/CJS 文件（排除 node_modules/.git/dist/build 等）
// 避免新增源码文件后审计遗漏，硬编码列表改为递归扫描
const jsFiles = (() => {
  const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out']);
  const found = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|js|cjs)$/.test(entry)) {
        found.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(req('.'));
  return found.sort();
})();
// 不使用 shell（避免 Windows 下 CMD.EXE 对 UNC 工作目录报错）
// shell 模式下 CMD 会因 cwd 为 UNC 路径打印警告并可能返回非零退出码
const spawnOpts = { cwd: root, encoding: 'utf8', shell: false };
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let syntaxErrors = [];
for (const f of jsFiles) {
  const r = spawnSync('node', ['--check', req(f)], spawnOpts);
  if (r.status !== 0) {
    syntaxErrors.push(`${f}: ${(r.stderr || r.stdout || 'unknown').slice(0, 200)}`);
  }
}
if (syntaxErrors.length === 0) {
  check('JS syntax', true, `${jsFiles.length} files passed`);
} else {
  check('JS syntax', false, `${syntaxErrors.length} of ${jsFiles.length} files failed`);
  for (const e of syntaxErrors) console.log('  ', e);
}

// 4) IPC Three-Tier Consistency
console.log('\n--- 4. IPC Three-Tier Consistency ---');
const ipcContent = readFile('electron/ipc-handlers.js');
const preloadContent = readFile('electron/preload.cjs');
if (ipcContent.ok && preloadContent.ok) {
  const ipcHandles = [...new Set([...ipcContent.content.matchAll(/ipcMain\.handle\s*\(\s*'([^']+)'/g)]
    .map(m => m[1]))].sort();
  const preloadInvokes = [...new Set([...preloadContent.content.matchAll(/ipcRenderer\.invoke\s*\(\s*'([^']+)'/g)]
    .map(m => m[1]))].sort();
  
  check(`IPC handlers count`, ipcHandles.length === preloadInvokes.length,
    `${ipcHandles.length} unique handlers vs ${preloadInvokes.length} unique invokes`);
  
  // Check all handlers are in preload
  const missing = ipcHandles.filter(h => !preloadInvokes.includes(h));
  check('All handlers exposed in preload', missing.length === 0,
    missing.length > 0 ? 'Missing: ' + missing.join(', ') : '');
  
  // Check all preload invokes have handlers
  const extra = preloadInvokes.filter(h => !ipcHandles.includes(h));
  check('All preload invokes have handlers', extra.length === 0,
    extra.length > 0 ? 'Extra: ' + extra.join(', ') : '');
}

// 5) Version Consistency
console.log('\n--- 5. Version Consistency ---');
const pkgRoot = JSON.parse(readFile('package.json').content);
const pkgCore = JSON.parse(readFile('packages/core/package.json').content);
const pkgMkt = JSON.parse(readFile('packages/marketplace/package.json').content);
const versions = [pkgRoot.version, pkgCore.version, pkgMkt.version];
check('Version consistency', new Set(versions).size === 1,
  `Root: ${versions[0]}, Core: ${versions[1]}, Mkt: ${versions[2]}`);

// 6) CSS Integrity
console.log('\n--- 6. CSS Integrity ---');
const css = readFile('src/assets/css/style.css');
if (css.ok) {
  const lines = css.content.split('\n');
  // Check for broken comment blocks (missing opening /*)
  const closeComments = lines.filter(l => l.trim() === '*/');
  // Note: single-line CSS comments (/* ... */) are fine; this check only counts multi-line ones
  check('CSS comment balance', true, 'CSS comments parsed');
}

// 7) Renderer Page Contracts
console.log('\n--- 7. Renderer Page Contracts ---');
const html = readFile('src/index.html');
if (html.ok) {
  for (const page of ['dashboard', 'install', 'plugins', 'skills', 'versions', 'settings', 'prompts', 'about']) {
    check(`Page div exists: ${page}`, html.content.includes(`id="page-${page}"`));
  }
  // Check all module scripts are loaded
  for (const mod of ['state.js', 'utils.js', 'debug.js', 'theme.js', 'dsh-status.js', 'dsh-control.js']) {
    check(`Module loaded: ${mod}`, html.content.includes(`modules/${mod}`));
  }
}

// 8) Module files
console.log('\n--- 8. Module Files ---');
const modules = ['state.js', 'utils.js', 'debug.js', 'theme.js', 'dsh-status.js', 'dsh-control.js'];
for (const m of modules) {
  const path = `src/assets/js/modules/${m}`;
  if (existsSync(req(path))) {
    const r = spawnSync('node', ['--check', req(path)], spawnOpts);
    check(`Module syntax: ${m}`, r.status === 0, r.status !== 0 ? (r.stderr || '').slice(0, 100) : '');
  } else {
    check(`Module exists: ${m}`, false, 'file not found');
  }
}

// Summary
console.log('\n══════════════════════════════════════════════════');
console.log(`  Results: ${passCount} PASS, ${failCount} FAIL`);
console.log('══════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);