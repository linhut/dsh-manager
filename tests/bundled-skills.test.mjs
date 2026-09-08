/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 内置技能完整性测试：dsh-skills/skills 作为 Manager 的 bundledDir 内置技能根，
// 必须包含 web-search（DuckDuckGo）与 gongwen-skill，且 SKILL.md 符合 DSH 官方格式
// （name kebab-case 与目录一致、description 必填、whenToUse camelCase、无 BOM）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const skillsRoot = join(root, 'dsh-skills', 'skills');

function read(rel) {
  return readFileSync(join(skillsRoot, rel), 'utf8');
}

describe('内置技能：web-search（DuckDuckGo）', () => {
  it('SKILL.md 存在且 frontmatter 合规', () => {
    const text = read('web-search/SKILL.md');
    assert.ok(text.startsWith('---'), '应以前置 frontmatter 开头（无 BOM）');
    assert.ok(/^name: web-search$/m.test(text), 'name 应为 web-search');
    assert.ok(/^description: .+/m.test(text), 'description 必填');
    assert.ok(/^user-invocable: true$/m.test(text), '应允许用户显式调用');
  });

  it('脚本齐全（search.py / fetch.py）且为纯标准库实现', () => {
    assert.ok(existsSync(join(skillsRoot, 'web-search', 'scripts', 'search.py')), 'search.py 应存在');
    assert.ok(existsSync(join(skillsRoot, 'web-search', 'scripts', 'fetch.py')), 'fetch.py 应存在');
    const search = read('web-search/scripts/search.py');
    const fetch = read('web-search/scripts/fetch.py');
    assert.ok(search.includes('lite.duckduckgo.com'), 'search.py 应基于 DuckDuckGo lite');
    assert.ok(search.includes('urllib.request'), 'search.py 应只依赖标准库（urllib）');
    assert.ok(fetch.includes('urllib.request'), 'fetch.py 应只依赖标准库（urllib）');
    assert.ok(!search.includes('import requests'), '不应依赖第三方 requests');
  });
});

describe('内置技能：gongwen-skill（公文）', () => {
  it('SKILL.md 存在且 frontmatter 合规', () => {
    const text = read('gongwen-skill/SKILL.md');
    assert.ok(text.startsWith('---'), '应以前置 frontmatter 开头（无 BOM）');
    assert.ok(/^name: gongwen-skill$/m.test(text), 'name 应为 gongwen-skill');
    assert.ok(/^description: .+/m.test(text), 'description 必填');
    assert.ok(/^whenToUse: .+/m.test(text), 'whenToUse 应为 DSH 标准 camelCase');
    assert.ok(!/^when-to-use: /m.test(text), '不应使用旧 kebab-case when-to-use');
  });

  it('运行时实现齐全（engine / gongwen / rules / prompts / dsh）', () => {
    for (const dir of ['engine', 'gongwen', 'rules', 'prompts', 'dsh']) {
      assert.ok(existsSync(join(skillsRoot, 'gongwen-skill', dir)), dir + ' 目录应存在');
    }
    assert.ok(existsSync(join(skillsRoot, 'gongwen-skill', 'engine', 'core')), 'engine/core 应存在');
    assert.ok(existsSync(join(skillsRoot, 'gongwen-skill', 'requirements.txt')), 'requirements.txt 应存在');
    assert.ok(existsSync(join(skillsRoot, 'gongwen-skill', 'pyproject.toml')), 'pyproject.toml 应存在');
  });
});

describe('内置技能：ppt-studio（PPT 全能工坊）', () => {
  it('SKILL.md 存在且 frontmatter 合规', () => {
    const text = read('ppt-studio/SKILL.md');
    assert.ok(text.startsWith('---'), '应以前置 frontmatter 开头（无 BOM）');
    assert.ok(/^name: ppt-studio$/m.test(text), 'name 应为 ppt-studio');
    assert.ok(/^description: .+/m.test(text), 'description 必填');
    assert.ok(/^whenToUse: .+/m.test(text), 'whenToUse 应为 DSH 标准 camelCase');
    assert.ok(!/^when-to-use: /m.test(text), '不应使用旧 kebab-case when-to-use');
  });

  it('运行时实现齐全（scripts / references / templates）且不携带二进制预览产物', () => {
    assert.ok(existsSync(join(skillsRoot, 'ppt-studio', 'scripts', 'export_pptx.py')), 'export_pptx.py 应存在');
    assert.ok(existsSync(join(skillsRoot, 'ppt-studio', 'scripts', 'json2pptx.py')), 'json2pptx.py 应存在');
    assert.ok(existsSync(join(skillsRoot, 'ppt-studio', 'references')), 'references 应存在');
    assert.ok(existsSync(join(skillsRoot, 'ppt-studio', 'templates', 'themes', 'all-themes.yaml')), '20 套配色模板应存在');
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
    const files = walk(join(skillsRoot, 'ppt-studio'));
    assert.ok(files.length > 0, '不应为空目录');
    for (const f of files) {
      assert.ok(!/\.(png|jpe?g|gif|webp|pptx)$/i.test(f), '不应携带二进制产物: ' + f);
    }
  });
});

describe('内置技能目录整体合规', () => {
  it('skills/ 下每个目录的 SKILL.md name 与目录名一致且 description 非空', () => {
    const entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    assert.ok(entries.length >= 9, '内置技能应不少于 9 个，实际 ' + entries.length);
    for (const e of entries) {
      const file = join(skillsRoot, e.name, 'SKILL.md');
      assert.ok(existsSync(file), e.name + '/SKILL.md 应存在');
      const text = readFileSync(file, 'utf8');
      assert.ok(text.charCodeAt(0) !== 0xFEFF, e.name + ' 不应带 UTF-8 BOM');
      assert.ok(new RegExp('^name: ' + e.name + '$', 'm').test(text), e.name + ' 的 name 应与目录一致');
      assert.ok(/^description: .+/m.test(text), e.name + ' 的 description 必填');
    }
  });
});
