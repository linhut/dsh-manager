/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 插件/技能管理显示与 Agent Preset 应用回归测试
// 覆盖本次修复：
// - getLocalPlugins 合并不刷新已存在条目（版本/来源永不更新）→ 用 profile 实际版本刷新
// - _buildProfilePluginEntry 把 link:/file: 源误显示为 npm: → 正确识别
// - --mcp 幽灵条目（历史非法 id）→ isGhostPluginId 过滤 + cleanupGhostEntries 物理清理
// - Agent Presets 管理只读 → listAgentPresetDirs / setDefaultAgentPreset / getAgentPresetDetail
// - 技能更新链路断裂 → listPluginSkills / importFromPlugin / listPluginSkillSyncStatus
// - installer 对 "--mcp" 这类 CLI flag 误当包名的输入做拦截
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { PluginRegistry } from '../packages/marketplace/src/registry.js';
import { PluginInstaller } from '../packages/marketplace/src/installer.js';
import { DSHConfig } from '../packages/core/src/config.js';
import { SkillManager } from '../packages/core/src/skill-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

/** 构造临时 DSH_HOME 布局（profiles/web + manager），返回清理函数 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pps-test-'));
  process.env.DSH_HOME = home;
  const web = join(home, 'profiles', 'web');
  const nm = join(web, 'node_modules');
  mkdirSync(join(nm, 'gongwen-skill'), { recursive: true });
  mkdirSync(join(home, 'manager'), { recursive: true });
  writeFileSync(join(nm, 'gongwen-skill', 'package.json'), JSON.stringify({
    name: 'gongwen-skill', version: '2.12.0', description: '公文技能（新版）',
  }));
  writeFileSync(join(web, 'package.json'), JSON.stringify({
    dependencies: { 'gongwen-skill': 'link:C:/x/document-skills/gongwen-skill' },
    dsh: { profile: { bundles: ['gongwen-skill'] } },
  }));
  writeFileSync(join(web, 'cordis.patch.yml'), '# test patch\n[]\n');
  return {
    home, web, nm,
    cleanup() { delete process.env.DSH_HOME; rmSync(home, { recursive: true, force: true }); },
  };
}

// ====== P0-1：getLocalPlugins 版本/来源刷新 ======
describe('插件列表：已存在条目用 profile 实际状态刷新（P0-1）', () => {
  it('版本/来源/类型刷新，enabled 以 patch 真实禁用状态为准', () => {
    const h = makeHome();
    try {
      // patch 中无 gongwen-skill 的 disabled override → 真实状态为启用
      writeFileSync(join(h.web, 'cordis.patch.yml'), '# test patch\n[]\n');
      writeFileSync(join(h.home, 'manager', 'plugins.json'), JSON.stringify([
        { id: 'gongwen-skill', name: 'gongwen-skill', version: '1.12.55', source: 'github:linhut/gongwen-skill', profile: 'web', type: 'github', enabled: false, disabledAt: '2026-09-07T00:16:31' },
      ]));
      const r = new PluginRegistry();
      const list = r.getLocalPlugins(true);
      const gw = list.find(p => p.id === 'gongwen-skill');
      assert.ok(gw, 'gongwen-skill 应存在');
      assert.equal(gw.version, '2.12.0', '版本应刷新为 profile 实际版本');
      assert.equal(gw.source, 'link:C:/x/document-skills/gongwen-skill', '来源应识别为 link:');
      assert.equal(gw.type, 'link', '类型应为 link');
      // 对账：patch 无禁用块而本地悬空 enabled:false → 纠正为 true
      assert.equal(gw.enabled, true, 'patch 未禁用时应纠正为启用');
      assert.equal(gw.disabledAt, undefined, '悬空的 disabledAt 应清除');
    } finally { h.cleanup(); }
  });

  it('patch 含 disabled override 时 enabled=false 保留', () => {
    const h = makeHome();
    try {
      writeFileSync(join(h.web, 'cordis.patch.yml'), '- id: gongwen-skill\n  disabled: true\n');
      writeFileSync(join(h.home, 'manager', 'plugins.json'), JSON.stringify([
        { id: 'gongwen-skill', name: 'gongwen-skill', version: '1.12.55', source: 'github:linhut/gongwen-skill', profile: 'web', type: 'github', enabled: false, disabledAt: '2026-09-07T00:16:31' },
      ]));
      const r = new PluginRegistry();
      const list = r.getLocalPlugins(true);
      const gw = list.find(p => p.id === 'gongwen-skill');
      assert.equal(gw.enabled, false, 'patch 显式禁用时应保持禁用');
    } finally { h.cleanup(); }
  });

  it('profile 扫描的新插件会被加入列表', () => {
    const h = makeHome();
    try {
      writeFileSync(join(h.home, 'manager', 'plugins.json'), JSON.stringify([]));
      const r = new PluginRegistry();
      const list = r.getLocalPlugins(true);
      assert.ok(list.some(p => p.id === 'gongwen-skill'), 'profile 扫描的新插件应进入列表');
    } finally { h.cleanup(); }
  });
});

// ====== P1-3：link/file 来源识别 ======
describe('插件来源：link:/file: 源不再误显示为 npm:（P1-3）', () => {
  it('_buildProfilePluginEntry 对 link 源返回 type=link', () => {
    const h = makeHome();
    try {
      const r = new PluginRegistry();
      const entry = r._buildProfilePluginEntry('web', 'gongwen-skill', 'link:C:/x/gongwen-skill');
      assert.equal(entry.type, 'link');
      assert.equal(entry.source, 'link:C:/x/gongwen-skill');
    } finally { h.cleanup(); }
  });

  it('_buildProfilePluginEntry 对 file 源返回 type=file', () => {
    const h = makeHome();
    try {
      const r = new PluginRegistry();
      const entry = r._buildProfilePluginEntry('web', 'some-plugin', 'file:C:/tmp/some-plugin');
      assert.equal(entry.type, 'file');
      assert.equal(entry.source, 'file:C:/tmp/some-plugin');
    } finally { h.cleanup(); }
  });

  it('_buildProfilePluginEntry 对 github 源保持 github 类型', () => {
    const h = makeHome();
    try {
      const r = new PluginRegistry();
      const entry = r._buildProfilePluginEntry('web', 'dsh-skills', 'github:linhut/dsh-skills');
      assert.equal(entry.type, 'github');
      assert.equal(entry.source, 'github:linhut/dsh-skills');
    } finally { h.cleanup(); }
  });
});

// ====== P1-5：幽灵条目 ======
describe('幽灵条目：--mcp 类非法 id 过滤与清理（P1-5）', () => {
  it('isGhostPluginId 识别 --mcp 与非法 id，放行合法 npm 名', () => {
    const h = makeHome();
    try {
      const r = new PluginRegistry();
      assert.equal(r.isGhostPluginId('--mcp'), true, '--mcp 应为幽灵');
      assert.equal(r.isGhostPluginId('..evil'), true);
      assert.equal(r.isGhostPluginId('gongwen-skill'), false);
      assert.equal(r.isGhostPluginId('@linxin666/dsh-web-ui-all'), false);
      assert.equal(r.isGhostPluginId('shiki'), false);
    } finally { h.cleanup(); }
  });

  it('getLocalPlugins 过滤幽灵条目，cleanupGhostEntries 物理清理', () => {
    const h = makeHome();
    try {
      writeFileSync(join(h.home, 'manager', 'plugins.json'), JSON.stringify([
        { id: 'gongwen-skill', name: 'gongwen-skill', version: '2.12.0', source: 'link:C:/x/gongwen-skill', profile: 'web', type: 'link' },
        { id: '--mcp', name: '--mcp', source: 'npm:--mcp', profile: 'web', type: 'dsh' },
      ]));
      const r = new PluginRegistry();
      const list = r.getLocalPlugins(true);
      assert.ok(!list.some(p => p.id === '--mcp'), '幽灵条目不应显示');
      const removed = r.cleanupGhostEntries();
      assert.equal(removed.length, 1);
      assert.equal(removed[0].id, '--mcp');
      const after = JSON.parse(readFileSync(join(h.home, 'manager', 'plugins.json'), 'utf8'));
      assert.ok(!after.some(p => p.id === '--mcp'), '幽灵条目应从注册表移除');
    } finally { h.cleanup(); }
  });

  it('registerLocalPlugin 拒绝幽灵 id，不写入注册表', () => {
    const h = makeHome();
    try {
      writeFileSync(join(h.home, 'manager', 'plugins.json'), JSON.stringify([]));
      const r = new PluginRegistry();
      const res = r.registerLocalPlugin({ id: '--mcp', name: '--mcp', source: 'npm:--mcp', profile: 'web' });
      assert.equal(res.success, false);
      const after = JSON.parse(readFileSync(join(h.home, 'manager', 'plugins.json'), 'utf8'));
      assert.equal(after.length, 0, '不应写入幽灵条目');
    } finally { h.cleanup(); }
  });
});

// ====== P1-5b：installer 源头拦截 ======
describe('插件安装：CLI flag 误当包名的输入被拦截（P1-5b）', () => {
  it('install("--mcp") 抛错而非执行 dsh plugin add', async () => {
    const h = makeHome();
    try {
      const installer = new PluginInstaller({ profile: 'web' });
      await assert.rejects(
        () => installer.install('--mcp'),
        /非法的 npm 包名|非法的/,
        '--mcp 应被拦截'
      );
    } finally { h.cleanup(); }
  });

  it('_isValidNpmPackageName 校验边界', () => {
    const h = makeHome();
    try {
      const installer = new PluginInstaller({ profile: 'web' });
      assert.equal(installer._isValidNpmPackageName('--mcp'), false);
      assert.equal(installer._isValidNpmPackageName('shiki'), true);
      assert.equal(installer._isValidNpmPackageName('@linxin666/dsh-web-ui-all'), true);
      assert.equal(installer._isValidNpmPackageName('../evil'), false);
    } finally { h.cleanup(); }
  });
});

// ====== P1-6：Agent Presets ======
describe('Agent Presets：目录扫描 / 查看 / 设为默认（P1-6）', () => {
  function makePresetHome() {
    const home = mkdtempSync(join(tmpdir(), 'pps-ap-'));
    process.env.DSH_HOME = home;
    const apRoot = join(home, '.agent-presets');
    mkdirSync(join(apRoot, 'gongwen-skill'), { recursive: true });
    mkdirSync(join(apRoot, 'liangshen'), { recursive: true });
    writeFileSync(join(apRoot, 'gongwen-skill', 'agent.cordis.yml'), '# gongwen composition\n- id: persona\n');
    writeFileSync(join(apRoot, 'gongwen-skill', 'preset.yml'), 'name: 公文专家\ndescription: 公文处理\n');
    writeFileSync(join(apRoot, 'liangshen', 'agent.cordis.yml'), '# liangshen composition\n');
    writeFileSync(join(home, 'settings.yaml'), 'agent-presets:\n  default: cordis\n');
    return {
      home, apRoot,
      cleanup() { delete process.env.DSH_HOME; rmSync(home, { recursive: true, force: true }); },
    };
  }

  it('listAgentPresetDirs 扫描磁盘预设目录并读取元数据', async () => {
    const h = makePresetHome();
    try {
      const cfg = new DSHConfig();
      const dirs = await cfg.listAgentPresetDirs();
      assert.ok(dirs.length >= 2, '应扫描到至少两个预设');
      const gw = dirs.find(d => d.id === 'gongwen-skill');
      assert.ok(gw, '应包含 gongwen-skill');
      assert.equal(gw.name, '公文专家');
      assert.equal(gw.kind, 'user');
      assert.ok(gw.path.endsWith('agent.cordis.yml'));
    } finally { h.cleanup(); }
  });

  it('setDefaultAgentPreset 写入 settings 的 agent-presets.default', async () => {
    const h = makePresetHome();
    try {
      const cfg = new DSHConfig();
      const res = await cfg.setDefaultAgentPreset('gongwen-skill');
      assert.equal(res.success, true);
      const text = readFileSync(join(h.home, 'settings.yaml'), 'utf8');
      assert.match(text, /default: gongwen-skill/, 'settings 应写入默认预设');
    } finally { h.cleanup(); }
  });

  it('getAgentPresetDetail 读取组合文件内容', async () => {
    const h = makePresetHome();
    try {
      const cfg = new DSHConfig();
      const detail = await cfg.getAgentPresetDetail('gongwen-skill');
      assert.ok(detail.content.includes('persona'));
    } finally { h.cleanup(); }
  });

  it('不存在的预设 setDefault 抛错', async () => {
    const h = makePresetHome();
    try {
      const cfg = new DSHConfig();
      await assert.rejects(() => cfg.setDefaultAgentPreset('nope'), /预设不存在/);
    } finally { h.cleanup(); }
  });
});

// ====== P2-7：技能插件同步 ======
describe('技能同步：从已安装插件导入最新技能（P2-7）', () => {
  function makeSkillHome() {
    const home = mkdtempSync(join(tmpdir(), 'pps-sk-'));
    process.env.DSH_HOME = home;
    const profiles = join(home, 'profiles', 'web', 'node_modules');
    mkdirSync(join(profiles, 'gongwen-skill'), { recursive: true });
    writeFileSync(join(profiles, 'gongwen-skill', 'package.json'), JSON.stringify({ name: 'gongwen-skill', version: '2.12.0' }));
    writeFileSync(join(profiles, 'gongwen-skill', 'SKILL.md'), '---\nname: gongwen-skill\ndescription: 新版公文技能\n---\n新版技能正文\n');
    return {
      home, profiles,
      cleanup() { delete process.env.DSH_HOME; rmSync(home, { recursive: true, force: true }); },
    };
  }

  it('listPluginSkills 扫描已安装插件中的 SKILL.md', () => {
    const h = makeSkillHome();
    try {
      const mgr = new SkillManager({ userSkillsDir: join(h.home, 'skills'), customDirs: [], bundledDir: '' });
      const list = mgr.listPluginSkills();
      const gw = list.find(s => s.plugin === 'gongwen-skill');
      assert.ok(gw, '应扫描到 gongwen-skill');
      assert.equal(gw.version, '2.12.0');
    } finally { h.cleanup(); }
  });

  it('importFromPlugin 将插件技能复制到用户技能目录', () => {
    const h = makeSkillHome();
    try {
      const mgr = new SkillManager({ userSkillsDir: join(h.home, 'skills'), customDirs: [], bundledDir: '' });
      const r = mgr.importFromPlugin('gongwen-skill', { overwrite: true });
      assert.equal(r.name, 'gongwen-skill');
      const text = readFileSync(join(h.home, 'skills', 'gongwen-skill', 'SKILL.md'), 'utf8');
      assert.ok(text.includes('新版技能正文'), '应导入新版技能内容');
    } finally { h.cleanup(); }
  });

  it('listPluginSkillSyncStatus 标记用户副本过期', () => {
    const h = makeSkillHome();
    try {
      const mgr = new SkillManager({ userSkillsDir: join(h.home, 'skills'), customDirs: [], bundledDir: '' });
      const before = mgr.listPluginSkillSyncStatus().find(s => s.plugin === 'gongwen-skill');
      assert.equal(before.installed, false, '初始未安装');
      assert.equal(before.outdated, true, '未安装 → 需要同步');
      mgr.importFromPlugin('gongwen-skill', { overwrite: true });
      const after = mgr.listPluginSkillSyncStatus().find(s => s.plugin === 'gongwen-skill');
      assert.equal(after.installed, true, '同步后已安装');
      assert.equal(after.outdated, false, '同步后不再过期');
    } finally { h.cleanup(); }
  });
});

// ====== 前端入口存在性（静态断言） ======
describe('前端：管理页入口（更新按钮/幽灵清理/预设操作/技能同步）', () => {
  it('checkPluginUpdates 有可更新列表与一键更新', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('updateSinglePlugin'), '应有单插件更新函数');
    assert.ok(src.includes('updateAllPlugins'), '应有一键更新全部');
    assert.ok(src.includes("data-update-id"), '更新按钮应携带 data-update-id');
  });

  it('插件页有清理幽灵条目入口', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('cleanupGhostPluginsUI'), '应有幽灵条目清理函数');
    assert.ok(src.includes('🧹 清理幽灵条目'), '工具栏应有清理按钮');
  });

  it('Agent Presets 页支持设为默认与查看', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('setDefaultAgentPreset('), '应有设为默认函数');
    assert.ok(src.includes('viewAgentPreset('), '应有查看预设函数');
    assert.ok(src.includes('listAgentPresetDirs'), '应调用预设目录扫描');
  });

  it('技能页有插件同步入口', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('showPluginSkillSync'), '应有插件同步函数');
    assert.ok(src.includes('importPluginSkillUI'), '应有技能同步执行函数');
  });

  it('preload 暴露更新/幽灵清理/预设/技能同步 API', () => {
    const src = read('electron/preload.cjs');
    for (const api of ['updatePlugin', 'cleanupGhostPlugins', 'listAgentPresetDirs', 'setDefaultAgentPreset', 'getAgentPresetDetail', 'skillsListPluginSkills', 'skillsPluginSyncStatus', 'skillsImportPluginSkill']) {
      assert.ok(src.includes(api + ':'), 'preload 应暴露 ' + api);
    }
  });
});
