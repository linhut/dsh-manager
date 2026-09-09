/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 内置内容自动安装回归测试
// 覆盖用户诉求"安装 dsh-manager 时自动安装内置技能/插件"：
// - resolveBundledSkillsRoot 解析内置技能源（开发/打包/已装插件多布局）
// - syncBundledSkills 首次安装 / 幂等跳过 / 内置更新覆盖 / 用户本地修改不覆盖
// - installDshSkillsPlugin 把 dsh-skills 插件装进 profile（node_modules + bundles）
// - ensureBundledContent 组合执行技能同步 + 插件安装
// - 打包配置（package.json extraResources）携带 dsh-skills
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  resolveBundledSkillsRoot,
  syncBundledSkills,
  installDshSkillsPlugin,
  ensureBundledContent,
  getBundledContentState,
} from '../packages/core/src/bundled-content.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

/** 构造临时 DSH_HOME */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'bc-test-'));
  process.env.DSH_HOME = home;
  mkdirSync(join(home, 'manager'), { recursive: true });
  return {
    home,
    cleanup() { delete process.env.DSH_HOME; rmSync(home, { recursive: true, force: true }); },
  };
}

// ====== 内置技能源解析 ======
describe('内置技能源：resolveBundledSkillsRoot（开发布局）', () => {
  it('在仓库开发模式下解析到 dsh-skills/skills 且含 9 个技能', () => {
    const h = makeHome();
    try {
      const src = resolveBundledSkillsRoot();
      assert.ok(src, '应解析到内置技能源');
      assert.ok(src.endsWith('dsh-skills' + '\\skills') || src.endsWith('dsh-skills/skills'), '应指向 dsh-skills/skills，实际: ' + src);
      const count = readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(src, e.name, 'SKILL.md'))).length;
      assert.ok(count >= 9, '应含至少 9 个技能，实际: ' + count);
    } finally { h.cleanup(); }
  });
});

// ====== 技能同步：安装/幂等/覆盖策略 ======
describe('内置技能同步：syncBundledSkills', () => {
  it('首次同步安装全部技能到 ~/.dsh/skills', () => {
    const h = makeHome();
    try {
      const r = syncBundledSkills();
      assert.ok(!r.error, '不应报错: ' + (r.error || ''));
      assert.ok(r.synced >= 9, '应安装至少 9 个技能，实际: ' + r.synced);
      for (const name of ['gongwen-skill', 'ppt-studio', 'web-search', 'brainstorming']) {
        assert.ok(existsSync(join(h.home, 'skills', name, 'SKILL.md')), '技能应存在: ' + name);
      }
    } finally { h.cleanup(); }
  });

  it('第二次运行幂等：全部跳过', () => {
    const h = makeHome();
    try {
      syncBundledSkills();
      const r2 = syncBundledSkills();
      assert.equal(r2.synced, 0, '无变化时应全部跳过');
      assert.equal(r2.skipped, 9, '9 个技能均应跳过');
    } finally { h.cleanup(); }
  });

  it('内置与本地不一致时以内置为准覆盖（用户确认的"自动覆盖为最新"策略）', () => {
    const h = makeHome();
    try {
      syncBundledSkills();
      // 用户改本地 → 内置与本地不同 → 按策略重置为内置版
      const userSkill = join(h.home, 'skills', 'brainstorming', 'SKILL.md');
      writeFileSync(userSkill, '---\nname: brainstorming\ndescription: 用户改的\n---\n用户自定义\n');
      const r = syncBundledSkills();
      assert.ok(r.synced >= 1, '内置与本地不同时应覆盖');
      assert.ok(!readFileSync(userSkill, 'utf8').includes('用户自定义'), '按策略用户修改被重置为内置版');
    } finally { h.cleanup(); }
  });

  it('内容一致时幂等跳过（不重复写入）', () => {
    const h = makeHome();
    try {
      syncBundledSkills();
      // 本地与内置一致（未修改）→ 第二次全跳过
      const r = syncBundledSkills();
      assert.equal(r.synced, 0, '内容一致应跳过');
      assert.equal(r.skipped, 9, '9 个技能均应跳过');
    } finally { h.cleanup(); }
  });

  it('内置源更新后覆盖旧副本', () => {
    const h = makeHome();
    try {
      syncBundledSkills();
      // 修改内置源（仓库 dsh-skills/skills/brainstorming/SKILL.md）模拟内置更新
      const srcSkill = join(root, 'dsh-skills', 'skills', 'brainstorming', 'SKILL.md');
      const orig = readFileSync(srcSkill, 'utf8');
      writeFileSync(srcSkill, orig + '\n<!-- 内置源更新标记 -->\n');
      try {
        const r = syncBundledSkills();
        assert.ok(r.synced >= 1, '内置更新后应覆盖对应技能');
        const target = join(h.home, 'skills', 'brainstorming', 'SKILL.md');
        assert.ok(readFileSync(target, 'utf8').includes('内置源更新标记'), '应同步内置新版内容');
      } finally {
        writeFileSync(srcSkill, orig); // 还原源文件
      }
    } finally { h.cleanup(); }
  });

  it('force 模式强制全量覆盖', () => {
    const h = makeHome();
    try {
      syncBundledSkills();
      const userSkill = join(h.home, 'skills', 'brainstorming', 'SKILL.md');
      writeFileSync(userSkill, '---\nname: brainstorming\ndescription: 用户改的\n---\n用户自定义\n');
      const r = syncBundledSkills({ force: true });
      assert.ok(r.synced >= 9, 'force 应全量覆盖');
      assert.ok(!readFileSync(userSkill, 'utf8').includes('用户自定义'), 'force 后应恢复内置版');
    } finally { h.cleanup(); }
  });

  it('状态记录可读（getBundledContentState）', () => {
    const h = makeHome();
    try {
      syncBundledSkills();
      const st = getBundledContentState();
      assert.ok(st.lastSyncAt, '应记录同步时间');
      assert.ok(Object.keys(st.skills || {}).length >= 9, '应记录各技能指纹');
    } finally { h.cleanup(); }
  });
});

// ====== dsh-skills 插件安装 ======
describe('内置插件：installDshSkillsPlugin', () => {
  it('把 dsh-skills 插件装进 profile（node_modules + bundles 登记）', async () => {
    const h = makeHome();
    try {
      const r = await installDshSkillsPlugin('web');
      assert.equal(r.success, true, '应安装成功: ' + (r.error || ''));
      const nmIndex = join(h.home, 'profiles', 'web', 'node_modules', 'dsh-skills', 'index.js');
      assert.ok(existsSync(nmIndex), 'node_modules 应有 index.js');
      const pkg = JSON.parse(readFileSync(join(h.home, 'profiles', 'web', 'package.json'), 'utf8'));
      assert.ok((pkg.dsh?.profile?.bundles || []).includes('dsh-skills'), 'bundles 应登记 dsh-skills');
    } finally { h.cleanup(); }
  });

  it('幂等：第二次调用返回 already', async () => {
    const h = makeHome();
    try {
      await installDshSkillsPlugin('web');
      const r2 = await installDshSkillsPlugin('web');
      assert.equal(r2.already, true, '第二次应识别为已安装');
    } finally { h.cleanup(); }
  });

  it('非法 profile 名拒绝', async () => {
    const h = makeHome();
    try {
      const r = await installDshSkillsPlugin('../evil');
      assert.equal(r.success, false, '非法 profile 应拒绝');
    } finally { h.cleanup(); }
  });
});

// ====== 组合执行 ======
describe('内置内容组合：ensureBundledContent', () => {
  it('同时同步技能 + 安装插件', async () => {
    const h = makeHome();
    try {
      const r = await ensureBundledContent({ profile: 'web' });
      assert.ok(r.skills.synced >= 9, '技能应同步');
      assert.ok(r.plugins, '应返回插件结果');
      assert.ok(r.plugins.dshSkills?.success || r.plugins.dshSkills?.already, 'dsh-skills 插件应安装');
    } finally { h.cleanup(); }
  });
});

// ====== 打包配置 ======
describe('打包配置：内置技能随包携带', () => {
  it('package.json extraResources 包含 dsh-skills', () => {
    const pkg = JSON.parse(read('package.json'));
    const er = pkg.build?.extraResources || [];
    const hit = er.find(e => e.from === 'dsh-skills' && e.to === 'dsh-skills');
    assert.ok(hit, 'extraResources 应包含 dsh-skills 条目');
  });

  it('main.js 启动时调用 ensureBundledContent', () => {
    const src = read('electron/main.js');
    assert.ok(src.includes('ensureBundledContentOnStartup'), '应存在启动同步函数');
    assert.ok(src.includes('ensureBundledContent('), '应调用内置内容同步');
  });

  it('preload 暴露内置内容 API', () => {
    const src = read('electron/preload.cjs');
    for (const api of ['getBundledContentStatus', 'syncBundledSkills', 'installBundledPlugins']) {
      assert.ok(src.includes(api + ':'), 'preload 应暴露 ' + api);
    }
  });

  it('设置页有内置内容 tab 入口', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes("openSettingsTab('bundled')"), '应有内置内容 tab');
    assert.ok(src.includes('renderBundledContentTab'), '应有内置内容渲染函数');
  });
});
