// DSH Manager 技能 frontmatter 合规性测试
// 覆盖最新 DSH 版本规则（dsh-skill-filesystem >= 0.1.0-rc.8）：
// - frontmatter 必填 name + description，name 必须 kebab-case
// - invocation 字段必须 kebab-case：disable-model-invocation / user-invocable
// - 旧 camelCase 字段（modelInvocable / userInvocable / disableModelInvocation）
//   会导致整个技能被新版 DSH 忽略 → 导入时需自动迁移
// - whenToUse（camelCase）是 DSH 标准拼写（非 when-to-use）
// - UTF-8 BOM 需剥离（DSH 要求首行严格为 ---）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SkillManager } from '../packages/core/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function makeManager() {
  const base = mkdtempSync(join(tmpdir(), 'skill-fm-'));
  const userSkills = join(base, 'skills');
  mkdirSync(userSkills, { recursive: true });
  const mgr = new SkillManager({ userSkillsDir: userSkills, customDirs: [], bundledDir: '' });
  return { mgr, userSkills, base };
}

// ====== 渲染层：renderSkillFile 输出 DSH 标准 camelCase ======
describe('技能渲染：whenToUse 使用 DSH 标准 camelCase', () => {
  it('renderSkillFile 输出 whenToUse 而非 when-to-use', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes("meta['whenToUse']"), '应写入 whenToUse (camelCase)');
    assert.ok(!src.includes("meta['when-to-use'] = input.whenToUse"), '不应再写 when-to-use (kebab)');
  });

  it('create() 生成的 SKILL.md 使用 whenToUse', () => {
    const { mgr, userSkills, base } = makeManager();
    try {
      mgr.create({ name: 'test-skill', description: '测试技能', whenToUse: '当用户需要测试时', body: '正文' });
      const text = readFileSync(join(userSkills, 'test-skill', 'SKILL.md'), 'utf8');
      assert.ok(text.includes('whenToUse:'), 'SKILL.md 应含 whenToUse');
      assert.ok(!text.includes('when-to-use'), '不应含 when-to-use');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

// ====== 导入层：旧字段自动迁移 + 必填校验 ======
describe('技能导入：frontmatter 按最新 DSH 规则规范化', () => {
  it('旧 modelInvocable:false 迁移为 disable-model-invocation:true', () => {
    const { mgr, userSkills, base } = makeManager();
    try {
      const srcDir = join(base, 'old-src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'SKILL.md'), '---\nname: old-skill\ndescription: 旧字段技能\nmodelInvocable: false\n---\n正文\n', 'utf8');
      const res = mgr.importFromDirectory(srcDir);
      assert.equal(res.success, true);
      const text = readFileSync(join(userSkills, 'old-skill', 'SKILL.md'), 'utf8');
      assert.ok(text.includes('disable-model-invocation: true'), '应迁移为 disable-model-invocation: true');
      assert.ok(!text.includes('modelInvocable'), '不应残留旧字段');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('旧 userInvocable:false 迁移为 user-invocable:false', () => {
    const { mgr, userSkills, base } = makeManager();
    try {
      const srcDir = join(base, 'old2-src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'SKILL.md'), '---\nname: old2-skill\ndescription: 旧字段\nuserInvocable: false\n---\n正文\n', 'utf8');
      mgr.importFromDirectory(srcDir);
      const text = readFileSync(join(userSkills, 'old2-skill', 'SKILL.md'), 'utf8');
      assert.ok(text.includes('user-invocable: false'), '应迁移为 user-invocable: false');
      assert.ok(!text.includes('userInvocable'), '不应残留旧字段');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('缺 description 时抛错（而非静默安装后不生效）', () => {
    const { mgr, base } = makeManager();
    try {
      const srcDir = join(base, 'no-desc');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'SKILL.md'), '---\nname: no-desc-skill\n---\n正文\n', 'utf8');
      assert.throws(() => mgr.importFromDirectory(srcDir), /description/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('旧 when-to-use 迁移为 whenToUse，scan 可读回', () => {
    const { mgr, userSkills, base } = makeManager();
    try {
      const srcDir = join(base, 'kebab-src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'SKILL.md'), '---\nname: kebab-skill\ndescription: kebab 技能\nwhen-to-use: 旧格式\n---\n正文\n', 'utf8');
      mgr.importFromDirectory(srcDir);
      const text = readFileSync(join(userSkills, 'kebab-skill', 'SKILL.md'), 'utf8');
      assert.ok(text.includes('whenToUse:'), '应迁移为 whenToUse');
      assert.ok(!text.includes('when-to-use'), '不应残留 when-to-use');
      const scanned = mgr.scan().find(s => s.name === 'kebab-skill');
      assert.equal(scanned && scanned.whenToUse, '旧格式');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

// ====== BOM 处理 ======
describe('技能 BOM 处理：DSH 要求首行严格 ---', () => {
  it('parseSkillFile 剥离 UTF-8 BOM', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes(".replace(/^\\uFEFF/, '')"), '应剥离 BOM');
  });

  it('带 BOM 的技能导入后 SKILL.md 无 BOM，scan 可见', () => {
    const { mgr, userSkills, base } = makeManager();
    try {
      const srcDir = join(base, 'bom-src');
      mkdirSync(srcDir, { recursive: true });
      const bomText = '\uFEFF---\nname: bom-skill\ndescription: BOM 技能\n---\n正文\n';
      writeFileSync(join(srcDir, 'SKILL.md'), bomText, 'utf8');
      const res = mgr.importFromDirectory(srcDir);
      assert.equal(res.success, true);
      const text = readFileSync(join(userSkills, 'bom-skill', 'SKILL.md'), 'utf8');
      assert.ok(!text.startsWith('\uFEFF'), '导入后应无 BOM');
      assert.ok(mgr.scan().some(s => s.name === 'bom-skill'), 'scan 应能看到');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
