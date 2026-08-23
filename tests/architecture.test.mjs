/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

const RENDERER_FILES = [
  'src/assets/js/app.js',
  'src/assets/js/modules/state.js',
  'src/assets/js/modules/utils.js',
  'src/assets/js/modules/debug.js',
  'src/assets/js/modules/theme.js',
  'src/assets/js/modules/dsh-status.js',
  'src/assets/js/modules/dsh-control.js',
];

describe('Renderer Architecture', () => {
  it('should not declare the same global function twice', () => {
    const seen = new Map();
    for (const f of RENDERER_FILES) {
      const lines = read(f).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
        if (m) {
          if (!seen.has(m[1])) seen.set(m[1], []);
          seen.get(m[1]).push({ file: f.replace('src/assets/js/', ''), line: i + 1 });
        }
      }
    }
    const dupes = [...seen.entries()]
      .filter(([, locs]) => locs.length > 1)
      .map(([name, locs]) => name + ' (' + locs.map(l => l.file + ':' + l.line).join(', ') + ')');
    assert.deepEqual(dupes, [], 'Duplicate function declarations: ' + dupes.join('; '));
  });

  it('should load modules in dependency order in index.html', () => {
    const html = read('src/index.html');
    const mods = ['state.js', 'utils.js', 'debug.js', 'theme.js', 'dsh-status.js', 'dsh-control.js'];
    const positions = mods.map((m, i) => ({ m, p: html.indexOf('modules/' + m) }));
    for (const pos of positions) {
      assert.ok(pos.p >= 0, 'Module not loaded in index.html: ' + pos.m);
    }
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i].p > positions[i - 1].p,
        'Order wrong: ' + positions[i - 1].m + ' must load before ' + positions[i].m);
    }
  });
});

describe('IPC Consistency', () => {
  it('should expose every ipcMain.handle in preload', () => {
    const ipc = read('electron/ipc-handlers.js');
    const preload = read('electron/preload.cjs');
    const handlers = [...ipc.matchAll(/ipcMain\.handle\s*\(\s*'([^']+)'/g)].map(m => m[1]).sort();
    const invokes = [...preload.matchAll(/ipcRenderer\.invoke\s*\(\s*'([^']+)'/g)].map(m => m[1]).sort();
    assert.equal(handlers.length, invokes.length, 'Handler count mismatch');
    const missing = handlers.filter(h => !invokes.includes(h));
    const extra = invokes.filter(h => !handlers.includes(h));
    assert.deepEqual(missing, [], 'Handlers not exposed in preload: ' + missing.join(', '));
    assert.deepEqual(extra, [], 'Preload invokes without handlers: ' + extra.join(', '));
  });

  it('should expose a rich dshManager API through preload', () => {
    const preload = read('electron/preload.cjs');
    const apis = [...preload.matchAll(/^\s{2}(\w+):\s*(?:\(|function|async)/gm)].map(m => m[1]);
    assert.ok(apis.length >= 80, 'Expected a rich dshManager API surface, got ' + apis.length);
  });
});

describe('Version Consistency', () => {
  it('should keep one version across root/core/marketplace package.json', () => {
    const rootPkg = JSON.parse(read('package.json'));
    const corePkg = JSON.parse(read('packages/core/package.json'));
    const mktPkg = JSON.parse(read('packages/marketplace/package.json'));
    const versions = [rootPkg.version, corePkg.version, mktPkg.version];
    assert.equal(new Set(versions).size, 1, 'Versions differ: ' + versions.join(', '));
  });
});


describe('T7: 新增架构检查', () => {
  it('should have IPC event consistency (send ↔ on)', () => {
    const ipc = read('electron/ipc-handlers.js');
    const main = read('electron/main.js');
    const preload = read('electron/preload.cjs');
    const sendEvents = [...ipc.matchAll(/\.send\s*\(\s*'([^']+)'/g), ...main.matchAll(/\.send\s*\(\s*'([^']+)'/g)].map(m => m[1]);
    const onEvents = [...preload.matchAll(/ipcRenderer\.on\s*\(\s*'([^']+)'/g)].map(m => m[1]);
    const uniqueSends = [...new Set(sendEvents)];
    const uniqueOns = [...new Set(onEvents)];
    const missingOns = uniqueSends.filter(e => !uniqueOns.includes(e));
    const missingSends = uniqueOns.filter(e => !uniqueSends.includes(e));
    assert.equal(missingOns.length, 0, 'Send events without listeners: ' + missingOns.join(', '));
    assert.equal(missingSends.length, 0, 'Listeners without send events: ' + missingSends.join(', '));
  });

  it('should load new module files', () => {
    for (const m of ['constants.js', 'shortcuts.js', 'page-manager.js']) {
      assert.ok(existsSync(join(root, 'src/assets/js/modules/' + m)), m + ' exists');
    }
  });

  it('should have no native confirm() calls in renderer', () => {
    const app = read('src/assets/js/app.js');
    const mods = readdirSync(join(root, 'src/assets/js/modules')).filter(f => f.endsWith('.js'));
    const allJS = [app, ...mods.map(f => read('src/assets/js/modules/' + f))].join('\n');
    // 排除 showConfirm()，只查原生 confirm()
    const native = [...allJS.matchAll(/(?:^|[^.\w])(confirm|alert)\s*\(/g)];
    const real = native.filter(m => {
      const before = allJS.slice(Math.max(0, m.index - 20), m.index);
      return !before.includes('show') && !before.includes('.confirming');
    });
    assert.equal(real.length, 0, 'Native confirm()/alert() found: ' + real.length);
  });

  it('should have no eval() or new Function() calls', () => {
    const app = read('src/assets/js/app.js');
    const mods = readdirSync(join(root, 'src/assets/js/modules')).filter(f => f.endsWith('.js'));
    const allJS = [app, ...mods.map(f => read('src/assets/js/modules/' + f))].join('\n');
    assert.equal((allJS.match(/[^.\w]eval\s*\(/g) || []).length, 0, 'No eval() allowed');
    assert.equal((allJS.match(/[^.\w]Function\s*\(/g) || []).length, 0, 'No new Function() allowed');
  });

  it('should have package-lock.json version matching root', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const rootPkg = JSON.parse(read('package.json'));
    assert.equal(lock.version, rootPkg.version, 'Lock ' + lock.version + ' vs root ' + rootPkg.version);
  });

  it('should use timeoutManager.timeoutPromise in app.js', () => {
    assert.ok(read('src/assets/js/app.js').includes('timeoutManager.timeoutPromise'), 'timeoutManager used');
  });

  it('should call initKeyboardShortcuts in app.js', () => {
    assert.ok(read('src/assets/js/app.js').includes('initKeyboardShortcuts()'), 'shortcuts initialized');
  });
});
