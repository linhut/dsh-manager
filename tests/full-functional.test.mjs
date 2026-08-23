// DSH Manager 全功能测试模块
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

// ====== T1: 启动与初始化 ======
describe('T1: 启动与初始化', () => {
  it('should have valid state.js exports', () => {
    const src = read('src/assets/js/modules/state.js');
    assert.ok(src.includes('class ReactiveState'), 'ReactiveState class');
    assert.ok(src.includes('window.appState = appState'), 'appState exposed');
    assert.ok(src.includes('window.state = stateProxy'), 'state proxy');
    assert.ok(src.includes('dshInstalled: false'), 'default dshInstalled');
    assert.ok(src.includes('dshVersion: null'), 'default dshVersion');
  });

  it('should have init sequence in app.js', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes("DOMContentLoaded"), 'DOMContentLoaded listener exists');
    assert.ok(src.includes('debugLog.log'), 'debugLog initialized');
    assert.ok(src.includes('applyTheme()'), 'theme applied');
  });
});

// ====== T2: 页面渲染与导航 ======
describe('T2: 页面渲染与导航', () => {
  it('should have switchPage function', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('function switchPage('), 'switchPage exists');
  });

  it('should have all required render functions', () => {
    const src = read('src/assets/js/app.js');
    const required = [
      'renderInstallPage', 'renderVersionsPage', 'renderSettingsPage',
      'renderAboutPage', 'renderPluginsPage', 'renderSkillsPage',
      'renderPromptsPage', 'renderSystemManagementTab',
      'renderSettingsManagerTab', 'renderLLMProvidersTab',
      'renderYAMLEditorTab', 'renderPresetsTab',
      'renderProfiles', 'renderDataManagement',
      'renderMarketplaceGrid', 'renderSkillMarketGrid',
    ];
    for (const fn of required) {
      assert.ok(src.includes('function ' + fn + '(') || src.includes('async function ' + fn + '('),
        'Missing function: ' + fn);
    }
  });

  it('should have openSettingsTab handling all 5 tabs', () => {
    const src = read('src/assets/js/app.js');
    const tabs = "'manager', 'llm', 'yaml', 'presets', 'system'";
    assert.ok(src.includes("'manager'") && src.includes("'llm'") &&
      src.includes("'yaml'") && src.includes("'presets'") && src.includes("'system'"),
      'All 5 setting tabs registered');
  });

  it('should have page-manager.js with PageManager class', () => {
    const src = read('src/assets/js/modules/page-manager.js');
    assert.ok(src.includes('class PageManager'), 'PageManager class');
    assert.ok(src.includes('register(id, page'), 'register method');
    assert.ok(src.includes('async navigate(id'), 'navigate method');
  });
});

// ====== T3: IPC 全链路一致性 ======
describe('T3: IPC 全链路一致性', () => {
  it('should expose every ipcMain.handle in preload.cjs', () => {
    const ipc = read('electron/ipc-handlers.js');
    const preload = read('electron/preload.cjs');
    const handlers = [...ipc.matchAll(/ipcMain\.handle\s*\(\s*'([^']+)'/g)].map(m => m[1]).sort();
    const invokes = [...preload.matchAll(/ipcRenderer\.invoke\s*\(\s*'([^']+)'/g)].map(m => m[1]).sort();
    const missing = handlers.filter(h => !invokes.includes(h));
    const extra = invokes.filter(h => !handlers.includes(h));
    assert.equal(missing.length, 0, 'Handlers not in preload: ' + missing.join(', '));
    assert.equal(extra.length, 0, 'Preload invokes without handlers: ' + extra.join(', '));
  });

  it('should have key preload APIs', () => {
    const preload = read('electron/preload.cjs');
    const apis = [...preload.matchAll(/^\s{2}(\w+):\s*(?:\(|function|async)/gm)].map(m => m[1]);
    assert.ok(apis.length >= 80, 'Expected 80+ APIs, got ' + apis.length);
    const keyAPIs = ['installDSH', 'getDSHVersions', 'switchDSHVersion', 'getAllConfig',
      'checkDSHUpdate', 'createConfigBackup', 'listConfigBackups', 'restoreConfigBackup',
      'validateConfig'];
    for (const api of keyAPIs) {
      assert.ok(apis.includes(api), 'Missing API: ' + api);
    }
  });

  it('should have all IPC events in preload', () => {
    const ipc = read('electron/ipc-handlers.js');
    const preload = read('electron/preload.cjs');
    const ipcSends = [...ipc.matchAll(/webContents\.send\s*\(\s*'([^']+)'/g)].map(m => m[1]);
    const preloadOns = [...preload.matchAll(/ipcRenderer\.on\s*\(\s*'([^']+)'/g)].map(m => m[1]);
    const missing = ipcSends.filter(h => !preloadOns.includes(h));
    assert.equal(missing.length, 0, 'IPC events not in preload: ' + missing.join(', '));
  });
});

// ====== T4: 核心业务逻辑 ======
describe('T4: 核心业务逻辑', () => {
  it('should parseYAML correctly handle objects', async () => {
    const yaml = await import('../packages/core/src/yaml-utils.js');
    const result = yaml.parseYAML('- id: gpt-4\n  name: GPT-4\n- id: claude-3\n');
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'gpt-4');
    assert.equal(result[0].name, 'GPT-4');
    assert.equal(result[1].id, 'claude-3');
  });

  it('should round-trip YAML correctly', async () => {
    const yaml = await import('../packages/core/src/yaml-utils.js');
    const obj = { items: [{ id: 'a', val: 1 }, { id: 'b', val: true }], desc: 'hello' };
    const y = yaml.toYAML(obj);
    const parsed = yaml.parseYAML(y);
    assert.deepEqual(parsed, obj);
  });

  it('should compareDSHVersions correctly', async () => {
    const mod = await import('../packages/core/src/dsh-utils.js');
    assert.equal(mod.compareDSHVersions('0.1.0-rc.7', '0.1.0-rc.8'), -1, 'rc.7 < rc.8');
    assert.equal(mod.compareDSHVersions('0.1.0-rc.8', '0.1.0-rc.7'), 1, 'rc.8 > rc.7');
    assert.equal(mod.compareDSHVersions('0.1.0', '0.1.0-rc.9'), 1, 'release > pre-release');
    assert.equal(mod.compareDSHVersions('0.1.0-rc.10', '0.1.0-rc.9'), 1, 'rc.10 > rc.9');
    assert.equal(mod.compareDSHVersions('0.1.0-rc.7', '0.1.0-rc.7'), 0, 'equal');
  });

  it('should sortDSHVersionsDesc correctly', async () => {
    const mod = await import('../packages/core/src/dsh-utils.js');
    const versions = ['0.1.0-rc.9', '0.1.0-rc.10', '0.1.0-rc.7', '0.1.0'];
    const sorted = mod.sortDSHVersionsDesc(versions);
    assert.deepEqual(sorted, ['0.1.0', '0.1.0-rc.10', '0.1.0-rc.9', '0.1.0-rc.7']);
  });

  it('should have config backup/restore/validate methods', async () => {
    const mod = await import('../packages/core/src/config.js');
    const cfg = new mod.DSHConfig();
    assert.ok(typeof cfg.createBackup === 'function', 'createBackup');
    assert.ok(typeof cfg.listBackups === 'function', 'listBackups');
    assert.ok(typeof cfg.restoreBackup === 'function', 'restoreBackup');
    assert.ok(typeof cfg.checkConfig === 'function', 'checkConfig');
    assert.ok(typeof cfg.write === 'function', 'write');
    assert.ok(typeof cfg.validateSettings === 'function', 'validateSettings');
  });

  it('should have version-manager methods', async () => {
    const mod = await import('../packages/core/src/version-manager.js');
    const vm = new mod.DSHVersionManager();
    assert.ok(typeof vm.getInstalledVersions === 'function', 'getInstalledVersions');
    assert.ok(typeof vm.checkForUpdate === 'function', 'checkForUpdate');
    assert.ok(typeof vm.getLatestVersion === 'function', 'getLatestVersion');
  });
});

// ====== T5: UI 交互函数完整性 ======
describe('T5: UI 交互函数完整性', () => {
  it('should have all onclick handlers defined', () => {
    const app = read('src/assets/js/app.js');
    const modules = readdirSync(join(root, 'src/assets/js/modules'))
      .filter(f => f.endsWith('.js')).map(f => read('src/assets/js/modules/' + f));
    const allJS = [app, ...modules].join('\n');

    const onclickRefs = [...allJS.matchAll(/onclick="([^"]+)"/g)].map(m => m[1]);
    const onclickRefs2 = [...allJS.matchAll(/onclick='([^']+)'/g)].map(m => m[1]);
    const allRefs = [...onclickRefs, ...onclickRefs2].filter(Boolean);

    const definedFunctions = new Set();
    const funcDefs = [...allJS.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
    funcDefs.forEach(f => definedFunctions.add(f));

    // Also collect preload API names (window.dshManager.xxx)
    const preload = read('electron/preload.cjs');
    const preloadAPIs = [...preload.matchAll(/^\s{2}(\w+):\s*(?:\(|function|async)/gm)].map(m => m[1]);
    preloadAPIs.forEach(f => definedFunctions.add(f));

    const issues = [];
    for (const ref of allRefs) {
      // Complex onclick expressions: parse each statement separated by ;
      const stmts = ref.split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        // Handle: window.dshManager.openExternal(...)
        const windowMatch = stmt.match(/^window\.dshManager\.(\w+)\s*\(/);
        if (windowMatch) {
          if (!preloadAPIs.includes(windowMatch[1])) {
            issues.push('window.dshManager.' + windowMatch[1] + ' not in preload');
          }
          continue;
        }
        // Handle: this.closest(...) or this.parentElement... - skip DOM operations
        if (stmt.match(/^this\.(closest|parentElement|style|classList|dataset|innerHTML)/)) continue;
        // Handle: event.stopPropagation() - skip event operations
        if (stmt.match(/^event\.(stopPropagation|preventDefault)/)) continue;
        // Handle: document.querySelector(...) - skip DOM API
        if (stmt.match(/^document\.(querySelector|getElementById|createElement)/)) continue;
        // Handle: simple function calls like backupProfile(name), switchVersion(ver)
        const simpleFn = stmt.match(/^([A-Za-z_$][\w$]*)\s*\(/);
        if (simpleFn) {
          if (!definedFunctions.has(simpleFn[1])) {
            issues.push(simpleFn[1] + ' (from onclick="' + ref + '")');
          }
        }
      }
    }
    assert.equal(issues.length, 0, 'Undefined onclick handlers: ' + issues.join('; '));
  });

  it('should have all window.dshManager.xxx calls matched in preload', () => {
    const app = read('src/assets/js/app.js');
    const modules = readdirSync(join(root, 'src/assets/js/modules'))
      .filter(f => f.endsWith('.js')).map(f => read('src/assets/js/modules/' + f));
    const allJS = [app, ...modules].join('\n');
    const preload = read('electron/preload.cjs');

    const calls = [...allJS.matchAll(/window\.dshManager\.(\w+)/g)].map(m => m[1]);
    const uniqueCalls = [...new Set(calls)];

    const apis = [...preload.matchAll(/^\s{2}(\w+):\s*(?:\(|function|async)/gm)].map(m => m[1]);

    const missing = uniqueCalls.filter(c => !apis.includes(c));
    assert.equal(missing.length, 0, 'window.dshManager calls without preload: ' + missing.join(', '));
  });

  it('should have all navbar pages handled in app.js', () => {
    const html = read('src/index.html');
    const app = read('src/assets/js/app.js');
    const navPages = [...html.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]);
    for (const page of navPages) {
      assert.ok(app.includes("'" + page + "'") || app.includes('"' + page + '"'),
        'Nav page "' + page + '" not handled in app.js');
    }
  });
});

// ====== T6: 安全审计 ======
describe('T6: 安全审计', () => {
  it('should have escapeHtml function in utils.js', () => {
    const utils = read('src/assets/js/modules/utils.js');
    assert.ok(utils.includes('function escapeHtml('), 'escapeHtml function exists in utils.js');
  });

  it('should have no eval() or Function() calls', () => {
    const app = read('src/assets/js/app.js');
    const modules = readdirSync(join(root, 'src/assets/js/modules'))
      .filter(f => f.endsWith('.js')).map(f => read('src/assets/js/modules/' + f));
    const allJS = [app, ...modules].join('\n');
    const evalCalls = allJS.match(/[^.\w]eval\s*\(/g);
    const funcCalls = allJS.match(/[^.\w]Function\s*\(/g);
    assert.equal(evalCalls ? evalCalls.length : 0, 0, 'No eval() allowed');
    assert.equal(funcCalls ? funcCalls.length : 0, 0, 'No Function() allowed');
  });
});
