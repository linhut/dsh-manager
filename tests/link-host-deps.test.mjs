/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// link 插件宿主依赖修复回归测试（v1.3.22）
// 复现线上问题：pnpm 严格布局下，link 安装的插件（如 dsh-stock-terminal）
// import @deepseek-ai/schemastery 时，Node 从 link 目标向上找不到 → DSH 启动失败。
// 旧实现只从 profile 顶层 node_modules 找宿主包（npm hoisted 布局才有），
// pnpm 布局下依赖在 .pnpm 虚拟店 → 注入 0 项。
// 新实现：多级来源查找（顶层/.pnpm/宿主嵌套/全局）+ 递归闭包注入。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** 构造一个 pnpm 严格布局的临时 DSH_HOME，返回清理函数 */
function setupPnpmLayout() {
  const home = mkdtempSync(join(tmpdir(), 'dshm-link-')).replace(/\\/g, '/');
  const profiles = join(home, 'profiles', 'web');
  const nmRoot = join(profiles, 'node_modules');
  const pluginCache = join(home, 'manager', 'plugin-cache', 'dsh-stock-terminal');

  // ① profile package.json：dependencies 含 link 插件
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': '0.1.2-rc.1',
      '@linxin666/dsh-client-ui-skin-stock': 'link:' + pluginCache.replace(/\\/g, '/'),
    },
  }, null, 2), 'utf-8');

  // ② link 目标（plugin-cache）：插件包本体，依赖 @deepseek-ai/schemastery
  mkdirSync(join(pluginCache, 'lib'), { recursive: true });
  writeFileSync(join(pluginCache, 'package.json'), JSON.stringify({
    name: '@linxin666/dsh-client-ui-skin-stock',
    version: '1.5.0',
    type: 'module',
    main: 'lib/index.js',
    dependencies: { '@deepseek-ai/schemastery': '^3.18.2' },
    peerDependencies: { react: '^18.2.0' },
  }, null, 2), 'utf-8');
  writeFileSync(join(pluginCache, 'lib', 'index.js'), "import { Schema } from '@deepseek-ai/schemastery';\nexport default { schema: new Schema('string') };\n", 'utf-8');

  // ③ pnpm 虚拟店：schemastery 只在 .pnpm 下（顶层 node_modules/@deepseek-ai/ 不放它）
  const makePkg = (pkgDir, manifest, deps, extra = {}) => {
    mkdirSync(join(pkgDir, 'lib'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(
      Object.assign({ type: 'module', main: 'lib/index.js' }, manifest, { dependencies: deps, ...extra }),
      null, 2
    ), 'utf-8');
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export const ok = true;\n', 'utf-8');
  };

  const pnpmStore = join(nmRoot, '.pnpm');
  const schemPkgDir = join(pnpmStore, '@deepseek-ai+schemastery@3.18.2', 'node_modules', '@deepseek-ai', 'schemastery');
  const cosmokitPkgDir = join(pnpmStore, '@deepseek-ai+cosmokit@1.8.3', 'node_modules', '@deepseek-ai', 'cosmokit');
  const specPkgDir = join(pnpmStore, '@standard-schema+spec@1.1.0', 'node_modules', '@standard-schema', 'spec');
  makePkg(schemPkgDir, { name: '@deepseek-ai/schemastery', version: '3.18.2' }, {
    '@deepseek-ai/cosmokit': '^1.8.3',
    '@standard-schema/spec': '^1.1.0',
  });
  makePkg(cosmokitPkgDir, { name: '@deepseek-ai/cosmokit', version: '1.8.3' }, {});
  makePkg(specPkgDir, { name: '@standard-schema/spec', version: '1.1.0' }, {});

  // ④ 宿主 @deepseek-ai/dsh（顶层符号链接指向虚拟店）
  const dshStore = join(pnpmStore, '@deepseek-ai+dsh@0.1.2-rc.1', 'node_modules', '@deepseek-ai', 'dsh');
  makePkg(dshStore, { name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }, { '@deepseek-ai/schemastery': '^3.18.2' });
  mkdirSync(join(nmRoot, '@deepseek-ai'), { recursive: true });
  symlinkSync(dshStore, join(nmRoot, '@deepseek-ai', 'dsh'), 'junction');

  // ⑤ 顶层 @linxin666 link（junction 指向 plugin-cache —— Windows 目录链接）
  mkdirSync(join(nmRoot, '@linxin666'), { recursive: true });
  symlinkSync(pluginCache, join(nmRoot, '@linxin666', 'dsh-client-ui-skin-stock'), 'junction');

  return { home, profiles, nmRoot, pluginCache };
}

describe('link 插件宿主依赖修复（pnpm 严格布局）', () => {
  let env;
  before(() => {
    env = setupPnpmLayout();
    process.env.DSH_HOME = env.home;
  });
  after(() => {
    try { rmSync(env.home, { recursive: true, force: true }); } catch { /* 忽略 */ }
    delete process.env.DSH_HOME;
  });

  it('repairLinkPluginHostDeps 从 .pnpm 虚拟店注入递归闭包', async () => {
    const mod = await import('../packages/core/src/dependency-integrity.js');
    const r = await mod.repairLinkPluginHostDeps('web');
    assert.ok(Array.isArray(r.injected), '应返回 injected 数组');
    const injectedStr = r.injected.join('、');
    // 至少注入 schemastery 本体（第一层缺失依赖）
    assert.ok(injectedStr.includes('@deepseek-ai/schemastery'), '应注入 schemastery，实际: ' + injectedStr);
    // 递归闭包：schemastery 依赖 cosmokit + @standard-schema/spec 也要注入
    assert.ok(injectedStr.includes('@deepseek-ai/cosmokit'), '应递归注入 cosmokit，实际: ' + injectedStr);
    assert.ok(injectedStr.includes('@standard-schema/spec'), '应递归注入 @standard-schema/spec（非 @deepseek-ai 命名空间），实际: ' + injectedStr);
    // 验证物理落盘
    const linkNm = join(env.pluginCache, 'node_modules');
    assert.ok(existsSync(join(linkNm, '@deepseek-ai', 'schemastery', 'package.json')), 'link 目标应含 schemastery');
    assert.ok(existsSync(join(linkNm, '@deepseek-ai', 'cosmokit', 'package.json')), 'link 目标应含 cosmokit');
    assert.ok(existsSync(join(linkNm, '@standard-schema', 'spec', 'package.json')), 'link 目标应含 @standard-schema/spec');
  });

  it('重复调用幂等：已注入的依赖不再重复复制', async () => {
    const mod = await import('../packages/core/src/dependency-integrity.js');
    await mod.repairLinkPluginHostDeps('web');
    const r2 = await mod.repairLinkPluginHostDeps('web');
    // 第二次调用不应再注入（依赖已存在）
    assert.equal(r2.injected.length, 0, '幂等：二次调用应注入 0 项，实际 ' + r2.injected.join('、'));
  });
});

describe('link 插件宿主依赖修复（npm hoisted 布局兼容）', () => {
  it('顶层 node_modules 有宿主包时仍能注入', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dshm-link2-')).replace(/\\/g, '/');
    const profiles = join(home, 'profiles', 'web');
    const nmRoot = join(profiles, 'node_modules');
    const pluginCache = join(home, 'manager', 'plugin-cache', 'plugin-a');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: { 'plugin-a': 'link:' + pluginCache.replace(/\\/g, '/') },
    }, null, 2), 'utf-8');
    mkdirSync(join(pluginCache, 'lib'), { recursive: true });
    writeFileSync(join(pluginCache, 'package.json'), JSON.stringify({
      name: 'plugin-a', version: '1.0.0', type: 'module', main: 'lib/index.js',
      dependencies: { '@deepseek-ai/schemastery': '^3.18.2' },
    }, null, 2), 'utf-8');
    writeFileSync(join(pluginCache, 'lib', 'index.js'), 'export default {};\n', 'utf-8');
    // npm hoisted：宿主包直接放顶层 node_modules/@deepseek-ai/schemastery
    const schemDir = join(nmRoot, '@deepseek-ai', 'schemastery');
    mkdirSync(join(schemDir, 'lib'), { recursive: true });
    writeFileSync(join(schemDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/schemastery', version: '3.18.2', type: 'module', main: 'lib/index.js',
      dependencies: { '@deepseek-ai/cosmokit': '^1.8.3' },
    }, null, 2), 'utf-8');
    writeFileSync(join(schemDir, 'lib', 'index.js'), 'export const ok = true;\n', 'utf-8');
    const cosmokitDir = join(nmRoot, '@deepseek-ai', 'cosmokit');
    mkdirSync(join(cosmokitDir, 'lib'), { recursive: true });
    writeFileSync(join(cosmokitDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/cosmokit', version: '1.8.3', type: 'module', main: 'lib/index.js',
    }, null, 2), 'utf-8');
    writeFileSync(join(cosmokitDir, 'lib', 'index.js'), 'export const ok = true;\n', 'utf-8');
    mkdirSync(nmRoot, { recursive: true });
    symlinkSync(pluginCache, join(nmRoot, 'plugin-a'), 'junction');

    try {
      process.env.DSH_HOME = home;
      const mod = await import('../packages/core/src/dependency-integrity.js');
      const r = await mod.repairLinkPluginHostDeps('web');
      assert.ok(r.injected.some(x => x.includes('@deepseek-ai/schemastery')), 'npm hoisted 布局应注入 schemastery，实际: ' + r.injected.join('、'));
      assert.ok(r.injected.some(x => x.includes('@deepseek-ai/cosmokit')), '应递归注入 cosmokit');
    } finally {
      delete process.env.DSH_HOME;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  });
});
