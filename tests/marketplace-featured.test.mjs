/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// DSH Manager 插件/技能市场"标星推荐"回归测试
// 覆盖：
// - 后端 registry.js _injectFeaturedPlugins featured 数组包含股市行情 + 朋友 DSH 插件
// - 前端插件市场 FALLBACK_PLUGINS 包含朋友插件（且均为插件类型，不混入技能市场）
// - 前端技能市场 FALLBACK_SKILLS 保持纯技能（不混入插件）
// - 技能市场成功路径注入精选逻辑存在（让 gongwen-skill 等即使 GitHub API 正常也置顶⭐推荐）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

// ====== 后端插件市场精选（_injectFeaturedPlugins featured） ======
describe('插件市场精选：后端 featured 数组', () => {
  it('包含股市行情插件（linhut/dsh-stock-terminal）且 recommended=true', () => {
    const src = read('packages/marketplace/src/registry.js');
    const featuredBlock = src.slice(src.indexOf('const featured = ['), src.indexOf('];', src.indexOf('const featured = [')));
    assert.ok(featuredBlock.includes("'linhut/dsh-stock-terminal'"), '应包含股市行情插件');
    // 该条目应是 recommended 插件
    const entry = featuredBlock.slice(featuredBlock.indexOf("'linhut/dsh-stock-terminal'"));
    assert.ok(entry.includes('recommended: true'), '股市行情应为推荐插件');
  });

  it('包含朋友 DSH 插件（z953218350 组织）', () => {
    const src = read('packages/marketplace/src/registry.js');
    const featuredBlock = src.slice(src.indexOf('const featured = ['), src.indexOf('];', src.indexOf('const featured = [')));
    for (const repo of ['z953218350/dsh-history-tree', 'z953218350/dsh-archive-manager', 'z953218350/dsh-np-ppt']) {
      assert.ok(featuredBlock.includes("'" + repo + "'"), '应包含 ' + repo);
    }
  });

  it('featured 条目全部为插件类型（dsh-plugin 标签）而非技能', () => {
    const src = read('packages/marketplace/src/registry.js');
    const featuredBlock = src.slice(src.indexOf('const featured = ['), src.indexOf('];', src.indexOf('const featured = [')));
    // 统计每个条目的 topics 是否含 dsh-plugin（插件标志）
    const entries = featuredBlock.split(/\n      \{\n/).slice(1);
    for (const e of entries) {
      // 跳过不完整片段
      if (!e.includes('fullName:')) continue;
      assert.ok(e.includes("'dsh-plugin'"), '精选条目应带 dsh-plugin 插件标签: ' + (e.match(/fullName: '([^']+)'/) || ['', '?'])[1]);
    }
  });
});

// ====== 前端插件市场 FALLBACK_PLUGINS ======
describe('插件市场精选：前端 FALLBACK_PLUGINS', () => {
  it('包含股市行情 + 朋友 3 个插件，均 recommended=true', () => {
    const src = read('src/assets/js/app.js');
    const block = src.slice(src.indexOf('const FALLBACK_PLUGINS = ['), src.indexOf('];', src.indexOf('const FALLBACK_PLUGINS = [')));
    for (const repo of ['linhut/dsh-stock-terminal', 'z953218350/dsh-history-tree', 'z953218350/dsh-archive-manager', 'z953218350/dsh-np-ppt']) {
      const idx = block.indexOf("'" + repo + "'");
      assert.ok(idx >= 0, 'FALLBACK_PLUGINS 应包含 ' + repo);
      const tail = block.slice(idx);
      const end = tail.indexOf('},');
      assert.ok(tail.slice(0, end).includes('recommended: true'), repo + ' 应为推荐插件');
    }
  });
});

// ====== 前端技能市场 FALLBACK_SKILLS（保持纯技能） ======
describe('技能市场精选：前端 FALLBACK_SKILLS 保持纯技能', () => {
  it('包含 gongwen-skill 等技能且 recommended=true', () => {
    const src = read('src/assets/js/app.js');
    const block = src.slice(src.indexOf('const FALLBACK_SKILLS = ['), src.indexOf('];', src.indexOf('const FALLBACK_SKILLS = [')));
    for (const repo of ['linhut/gongwen-skill', 'linhut/dsh-skills']) {
      const idx = block.indexOf("'" + repo + "'");
      assert.ok(idx >= 0, 'FALLBACK_SKILLS 应包含 ' + repo);
      const tail = block.slice(idx);
      const end = tail.indexOf('},');
      assert.ok(tail.slice(0, end).includes('recommended: true'), repo + ' 应为推荐技能');
    }
  });

  it('不混入插件（股市行情/朋友插件不在技能市场）', () => {
    const src = read('src/assets/js/app.js');
    const block = src.slice(src.indexOf('const FALLBACK_SKILLS = ['), src.indexOf('];', src.indexOf('const FALLBACK_SKILLS = [')));
    for (const repo of ['dsh-stock-terminal', 'dsh-history-tree', 'dsh-archive-manager', 'dsh-np-ppt']) {
      assert.ok(!block.includes(repo), '技能市场不应混入插件: ' + repo);
    }
  });
});

// ====== 技能市场成功路径精选注入 ======
describe('技能市场：成功路径注入精选（标星推荐真正生效）', () => {
  it('loadSkillMarketplace 在 GitHub API 正常时也注入精选技能', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('const featuredInject = FALLBACK_SKILLS.filter'), '应存在精选注入逻辑');
    assert.ok(src.includes('featuredExisting'), '应有去重逻辑（避免与真实搜索结果重复）');
  });
});
