/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * IPC 契约一致性检查
 *
 * 定位：这不是"源码里必须出现某个符号"的文本守卫，而是**声明与实现的一致性校验**——
 * 清单（channels.cjs）、preload 暴露、主进程注册三方必须描述同一组通道。
 * 它替代的是"改名靠全局搜索"的人工流程，属于可迁移的护栏：
 * 后续 preload 由清单生成后，本脚本可退化为只校验主进程注册。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

const { CHANNELS } = require(join(root, 'electron/contract/channels.cjs'));

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

/** 从 preload 中提取 method → { channel, kind } */
function parsePreload(source) {
  const result = new Map();
  let current = null;
  for (const line of source.split('\n')) {
    const decl = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\(|=>)/);
    if (decl) current = decl[1];
    // preload 统一走 invokeIpc 解包层；保留 ipcRenderer.invoke 以兼容未迁移的写法
    const invoke = line.match(/(?:ipcRenderer\.invoke|invokeIpc)\(\s*'([^']+)'/);
    const send = line.match(/ipcRenderer\.send\(\s*'([^']+)'/);
    const on = line.match(/ipcRenderer\.on\(\s*'([^']+)'/);
    if (invoke && current) result.set(current, { channel: invoke[1], kind: 'invoke' });
    else if (send && current) result.set(current, { channel: send[1], kind: 'send' });
    else if (on && current) result.set(current, { channel: on[1], kind: 'event' });
  }
  return result;
}

function parseHandlers(source) {
  const handles = new Set();
  const listens = new Set();
  for (const m of source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) handles.add(m[1]);
  for (const m of source.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)) listens.add(m[1]);
  return { handles, listens };
}

/** 主进程侧主动推送的通道（webContents.send） */
function parsePushed(mainSource, handlerSource) {
  const pushed = new Set();
  for (const src of [mainSource, handlerSource]) {
    for (const m of src.matchAll(/(?:webContents|contents|mainWindow\.webContents)\.send\(\s*'([^']+)'/g)) pushed.add(m[1]);
  }
  return pushed;
}

const declared = Object.entries(CHANNELS).map(([channel, meta]) => ({ channel, ...meta }));
const preload = parsePreload(read('electron/preload.cjs'));
const { handles, listens } = parseHandlers(read('electron/ipc-handlers.js'));
const pushed = parsePushed(read('electron/main.js'), read('electron/ipc-handlers.js'));

const errors = [];
const warnings = [];

// 1. 清单 → 实现
for (const item of declared) {
  const impl = preload.get(item.method);
  if (!impl) {
    errors.push(`[清单有、preload 无] ${item.channel} → method "${item.method}" 未在 preload 暴露`);
    continue;
  }
  if (impl.channel !== item.channel) {
    errors.push(`[通道不一致] method "${item.method}"：清单=${item.channel}，preload=${impl.channel}`);
  }
  if (impl.kind !== item.kind) {
    errors.push(`[类型不一致] ${item.channel}：清单=${item.kind}，preload=${impl.kind}`);
  }
  if (item.kind === 'invoke' && !handles.has(item.channel)) {
    errors.push(`[清单有、主进程无] ${item.channel} 未注册 ipcMain.handle`);
  }
  if (item.kind === 'send' && !listens.has(item.channel)) {
    errors.push(`[清单有、主进程无] ${item.channel} 未注册 ipcMain.on`);
  }
  if (item.kind === 'event' && !pushed.has(item.channel)) {
    warnings.push(`[事件未观察到推送] ${item.channel} 清单登记为 event，但主进程未出现 webContents.send`);
  }
}

// 2. 实现 → 清单（防止"偷偷加了通道"）
const declaredChannels = new Set(declared.map((d) => d.channel));
for (const [method, impl] of preload) {
  if (!declaredChannels.has(impl.channel)) {
    errors.push(`[未登记] preload.${method} 使用通道 ${impl.channel}，但 channels.cjs 中没有记录`);
  }
}
for (const channel of handles) {
  if (!declaredChannels.has(channel)) {
    errors.push(`[未登记] ipcMain.handle("${channel}") 未在 channels.cjs 中登记`);
  }
}

// 3. 汇总
const kinds = declared.reduce((acc, d) => ((acc[d.kind] = (acc[d.kind] || 0) + 1), acc), {});
console.log('IPC 契约检查');
console.log(`  清单      : ${declared.length} 条 (invoke ${kinds.invoke || 0} / send ${kinds.send || 0} / event ${kinds.event || 0})`);
console.log(`  preload   : ${preload.size} 条`);
console.log(`  主进程    : handle ${handles.size} / on ${listens.size}`);

if (warnings.length) {
  console.log('\n提示:');
  for (const w of warnings) console.log('  - ' + w);
}

if (errors.length) {
  console.log('\n差异:');
  for (const e of errors) console.log('  - ' + e);
  console.log(`\n结果: FAIL（${errors.length} 项不一致）`);
  process.exit(1);
}

console.log('\n结果: PASS（清单、preload、主进程三方一致）');
