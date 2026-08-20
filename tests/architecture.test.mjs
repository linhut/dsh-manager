/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
