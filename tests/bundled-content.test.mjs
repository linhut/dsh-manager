/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 内置内容自动安装回归测试
// 覆盖用户诉求"安装 dsh-manager 时自动安装内置技能/插件"：
// - resolveBundledSkillsRoot 解析内置技能源（在线克隆缓存/开发/打包/已装多布局）
// - syncBundledSkills 首次安装 / 幂等跳过 / 内置更新覆盖 / 用户本地修改不覆盖
// - installDshSkillsPlugin：纯技能集形态——在线 git clone 拉取到 pluginCache
//   （远端有版本 tag → 检测比对已记录版本 → 判断是否拉取/更新；无 tag 已拉取即已装；
//   24h 失败冷却；净迁移清理旧插件形态残留），技能由 syncBundledSkills 同步，无插件注册
// - ensureBundledContent 组合执行（先拉取 dsh-skills / 装插件，再同步技能）
// - 打包配置（package.json extraResources）不再携带 dsh-skills（已改安装时在线拉取）
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

/** 构造结构有效的克隆产物（skills/demo-skill/SKILL.md）——fake git 与断言共用 */
function makeFakeCloneContents(dest) {
  mkdirSync(join(dest, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(join(dest, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n', 'utf8');
}

/** 注入式 fake git：lsRemoteTags 可配置 tag 列表；clone 构造产物或由 cloneImpl 接管（可统计调用与收到的 tag） */
function makeFakeGit(tags = [], opts = {}) {
  let cloneCalls = 0;
  let lastCloneOpts = null;
  return {
    get cloneCalls() { return cloneCalls; },
    get lastCloneOpts() { return lastCloneOpts; },
    async lsRemoteTags() { return tags; },
    async headHash() { return opts.headHash || 'deadbeef1234'; },
    async clone(dest, cloneOpts) {
      cloneCalls++;
      lastCloneOpts = cloneOpts || null;
      if (opts.cloneImpl) return opts.cloneImpl(dest);
      makeFakeCloneContents(dest);
    },
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

// ====== dsh-skills 技能集部署 ======
describe('内置技能集：installDshSkillsPlugin（纯技能集形态）', () => {
  it('非法 profile 名拒绝', async () => {
    const h = makeHome();
    try {
      const r = await installDshSkillsPlugin('../evil');
      assert.equal(r.success, false, '非法 profile 应拒绝');
    } finally { h.cleanup(); }
  });

  it('净迁移：清理旧插件形态残留（file: 依赖 + bundles 登记 + node_modules 副本）', async () => {
    const h = makeHome();
    try {
      const profileDir = join(h.home, 'profiles', 'web');
      mkdirSync(join(profileDir, 'node_modules', 'dsh-skills'), { recursive: true });
      writeFileSync(join(profileDir, 'node_modules', 'dsh-skills', 'package.json'), '{"name":"dsh-skills","version":"0.2.0"}', 'utf8');
      writeFileSync(join(profileDir, 'node_modules', 'dsh-skills', 'index.js'), 'export default {}', 'utf8');
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'dsh-skills': 'file:C:/old/node_modules/dsh-skills' },
        dsh: { profile: { bundles: ['dsh-skills'] } },
      }, null, 2), 'utf8');
      const r = await installDshSkillsPlugin('web', { git: makeFakeGit([]) });
      assert.equal(r.success, true, '拉取应成功: ' + (r.error || ''));
      const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      assert.ok(!pkg.dependencies || !('dsh-skills' in pkg.dependencies), '应清理 file: 依赖');
      assert.ok(!(pkg.dsh?.profile?.bundles || []).includes('dsh-skills'), '应清理 bundles 登记');
      assert.ok(!existsSync(join(profileDir, 'node_modules', 'dsh-skills')), '应删除旧插件副本');
    } finally { h.cleanup(); }
  });
});

// ====== 组合执行 ======
describe('内置内容组合：ensureBundledContent', () => {
  it('一次调用：先拉取 dsh-skills（clone 落位）→ 再同步技能', async () => {
    const h = makeHome();
    try {
      let skillsBeforeClone = null;
      const git = {
        lsRemoteTags: async () => [],
        headHash: async () => 'abc123',
        clone: async (dest) => {
          skillsBeforeClone = existsSync(join(h.home, 'skills'));
          makeFakeCloneContents(dest);
        },
      };
      const r = await ensureBundledContent({ profile: 'web', git });
      assert.equal(skillsBeforeClone, false, '拉取时技能尚未同步（应先拉取后同步）');
      assert.ok(r.plugins?.dshSkills?.success, 'dsh-skills 应拉取成功');
      assert.ok(r.skills.synced >= 1, '拉取落地后应同轮同步技能，实际: ' + r.skills.synced);
    } finally { h.cleanup(); }
  });
});

// ====== 在线拉取路径（注入 fake git，不联网） ======
describe('内置技能集在线拉取（默认 source=online，注入 fake git）', () => {
  it('resolveBundledSkillsRoot 优先解析在线克隆落点（pluginCache/dsh-skills/skills）', () => {
    const h = makeHome();
    try {
      makeFakeCloneContents(join(h.home, 'manager', 'plugin-cache', 'dsh-skills'));
      const src = resolveBundledSkillsRoot();
      assert.ok(src, '应解析到技能源');
      assert.ok(src.replace(/\\/g, '/').endsWith('plugin-cache/dsh-skills/skills'), '应指向在线克隆落点，实际: ' + src);
    } finally { h.cleanup(); }
  });

  it('首次拉取成功（远端无 tag）→ online-git-clone，记录 commit 版本，clone 不 pin tag', async () => {
    const h = makeHome();
    try {
      const git = makeFakeGit([]);
      const r = await installDshSkillsPlugin('web', { git });
      assert.equal(r.success, true, '应拉取成功: ' + (r.error || ''));
      assert.equal(r.method, 'online-git-clone');
      assert.equal(r.version, 'deadbeef1234');
      assert.ok(!git.lastCloneOpts || !git.lastCloneOpts.tag, '无 tag 时不应 pin 分支');
      assert.ok(existsSync(join(h.home, 'manager', 'plugin-cache', 'dsh-skills', 'skills', 'demo-skill', 'SKILL.md')), '克隆产物应落地');
    } finally { h.cleanup(); }
  });

  it('已拉取 + 远端无 tag（未发版）→ 无版本可比，判定已装', async () => {
    const h = makeHome();
    try {
      makeFakeCloneContents(join(h.home, 'manager', 'plugin-cache', 'dsh-skills'));
      const r = await installDshSkillsPlugin('web', { git: makeFakeGit([]) });
      assert.equal(r.already, true, '应判定已装');
      assert.equal(r.method, 'already-installed');
    } finally { h.cleanup(); }
  });

  it('版本检测「有版本→检测→判断」：记录版本 >= 线上最新 tag → already-version-satisfied，不重复拉取', async () => {
    const h = makeHome();
    try {
      const git1 = makeFakeGit(['v0.1.0', 'v0.2.1']);
      const r1 = await installDshSkillsPlugin('web', { git: git1 });
      assert.equal(r1.success, true, '首次应拉取成功: ' + (r1.error || ''));
      assert.equal(r1.method, 'online-git-updated');
      assert.equal(r1.version, 'v0.2.1');
      const git2 = makeFakeGit(['v0.1.0', 'v0.2.1']);
      const r2 = await installDshSkillsPlugin('web', { git: git2 });
      assert.equal(r2.already, true, '版本满足应跳过');
      assert.equal(r2.method, 'already-version-satisfied');
      assert.equal(r2.version, 'v0.2.1');
      assert.equal(git2.cloneCalls, 0, '不应再触发 clone');
    } finally { h.cleanup(); }
  });

  it('版本检测：线上发布新 tag → 检测到落后 → 重新拉取更新（online-git-updated）', async () => {
    const h = makeHome();
    try {
      const git1 = makeFakeGit(['v0.2.1']);
      const r1 = await installDshSkillsPlugin('web', { git: git1 });
      assert.equal(r1.success, true, '首次应拉取成功: ' + (r1.error || ''));
      const git2 = makeFakeGit(['v0.2.2']);
      const r2 = await installDshSkillsPlugin('web', { git: git2 });
      assert.equal(r2.already, false, '版本落后不应判定已装');
      assert.equal(r2.method, 'online-git-updated');
      assert.equal(r2.version, 'v0.2.2');
      assert.equal(git2.cloneCalls, 1, '应重新拉取一次更新');
      assert.equal(git2.lastCloneOpts && git2.lastCloneOpts.tag, 'v0.2.2', '更新应 pin 到线上新 tag');
    } finally { h.cleanup(); }
  });

  it('拉取产物结构无效（缺 skills）→ 拒绝并报错', async () => {
    const h = makeHome();
    try {
      const git = makeFakeGit([], { cloneImpl: d => mkdirSync(d, { recursive: true }) });
      const r = await installDshSkillsPlugin('web', { git });
      assert.equal(r.success, false, '结构无效应拒绝');
      assert.ok((r.error || '').includes('拉取产物缺少 skills'), '应说明结构校验失败: ' + r.error);
    } finally { h.cleanup(); }
  });

  it('拉取失败：返回错误并记录状态；冷却期内自动跳过不重试', async () => {
    const h = makeHome();
    try {
      const r1 = await installDshSkillsPlugin('web', { git: makeFakeGit([], { cloneImpl: () => { throw new Error('network unreachable'); } }) });
      assert.equal(r1.success, false, '首次失败应返回错误');
      assert.ok((r1.error || '').includes('在线获取 dsh-skills 失败'), '应携带失败原因');
      const git2 = makeFakeGit([], { cloneImpl: () => { throw new Error('should not be called'); } });
      const r2 = await installDshSkillsPlugin('web', { git: git2 });
      assert.equal(r2.success, false, '冷却期内应跳过');
      assert.equal(r2.skipped, true, '应标记 skipped');
      assert.equal(git2.cloneCalls, 0, '冷却期内不应触发网络');
    } finally { h.cleanup(); }
  });

  it('force 重装无视冷却，重新拉取', async () => {
    const h = makeHome();
    try {
      await installDshSkillsPlugin('web', { git: makeFakeGit([], { cloneImpl: () => { throw new Error('first fail'); } }) });
      const gitOk = makeFakeGit(['v0.2.1']);
      const r = await installDshSkillsPlugin('web', { force: true, git: gitOk });
      assert.equal(r.success, true, 'force 应重新拉取成功: ' + (r.error || ''));
      assert.equal(gitOk.cloneCalls, 1, 'force 应触发拉取');
    } finally { h.cleanup(); }
  });
});

// ====== 打包配置 ======
describe('打包配置：内置内容不再随包嵌入（改在线安装）', () => {
  it('package.json extraResources 不再包含 dsh-skills（已改安装时在线拉取）', () => {
    const pkg = JSON.parse(read('package.json'));
    const er = pkg.build?.extraResources || [];
    const hit = er.find(e => e.from === 'dsh-skills' && e.to === 'dsh-skills');
    assert.ok(!hit, 'extraResources 不应再携带 dsh-skills（已改安装时在线拉取）');
  });

  it('bundled-content 声明 dsh-skills 在线源仓库地址', () => {
    const src = read('packages/core/src/bundled-content.js');
    assert.ok(src.includes('DSH_SKILLS_GIT_URL'), '应声明在线源常量');
    assert.ok(src.includes('github.com/linhut/dsh-skills.git'), '在线源应为官方仓库');
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
