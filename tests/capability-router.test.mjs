/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 能力路由端到端回归测试：settings.capability-router 双写 + 迁移读取 + 内置插件安装
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshm-cap-')).replace(/\\/g, '/');
  mkdirSync(join(home, '.dsh'), { recursive: true });
  writeFileSync(join(home, '.dsh', 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    yang-newapi:',
    '      apiKeyEnv: YANG_NEWAPI_API_KEY',
    '      api: openai-completions',
    '      baseURL: "http://192.168.1.9:65002/v1"',
    '      models:',
    '        - id: deepseek-v4-flash',
    '        - id: glm-5v-turbo',
    ''
  ].join('\n'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(home, '.dsh');
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

describe('能力路由端到端', () => {
  it('saveLLMRouting 双写 settings.capability-router（DSH 插件可读）', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      await cfg.saveLLMRouting({ enabled: true, defaultCapability: 'semantic', capabilities: {
        semantic: { provider: 'yang-newapi', model: 'deepseek-v4-flash' },
        vision: { provider: 'yang-newapi', model: 'glm-5v-turbo' },
      }});
      const { settings } = await cfg.read();
      assert.ok(settings['capability-router'], 'capability-router 段应被写入');
      assert.equal(settings['capability-router'].enabled, true);
      assert.equal(settings['capability-router'].capabilities.vision.model, 'glm-5v-turbo');
      assert.ok(settings.manager && settings.manager['llm-routing']);
    });
  });

  it('getLLMRouting 优先读 capability-router，缺失回退 manager.llm-routing', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      const { settings } = await cfg.read();
      settings.manager = { 'llm-routing': { enabled: true, defaultCapability: 'semantic', capabilities: { semantic: { provider: 'yang-newapi', model: 'deepseek-v4-flash' } } } };
      await cfg.write(settings);
      const r1 = await cfg.getLLMRouting();
      assert.equal(r1.enabled, true);
      assert.equal(r1.capabilities.semantic.model, 'deepseek-v4-flash');
      const { settings: s2 } = await cfg.read();
      s2['capability-router'] = { enabled: true, defaultCapability: 'vision', capabilities: { vision: { provider: 'yang-newapi', model: 'glm-5v-turbo' } } };
      await cfg.write(s2);
      const r2 = await cfg.getLLMRouting();
      assert.equal(r2.defaultCapability, 'vision');
      assert.equal(r2.capabilities.vision.model, 'glm-5v-turbo');
    });
  });

  it('resolveBundledPluginDir 能找到随包插件（开发布局）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const dir = mod.resolveBundledPluginDir();
      assert.ok(dir, '应能解析内置插件目录');
      assert.ok(existsSync(join(dir, 'package.json')), '插件目录应有 package.json');
      assert.ok(existsSync(join(dir, 'lib', 'index.js')), '插件目录应有 lib/index.js');
    });
  });

  it('installCapabilityRouter 复制插件并登记 profile bundles（官方机制，幂等）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      assert.equal(mod.isCapabilityRouterInstalled('web'), false);
      const r = await mod.installCapabilityRouter('web');
      assert.equal(r.success, true);
      assert.equal(r.installed, true);
      // 官方机制：profile 清单 dsh.profile.bundles 应含插件包名
      const pkgFile = join(process.env.DSH_HOME, 'profiles', 'web', 'package.json');
      const manifest = JSON.parse(readFileSync(pkgFile, 'utf-8'));
      assert.ok(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles.includes('@dsh-manager/dsh-capability-router'), 'bundles 应含插件包名');
      // 插件包应被复制进 profile node_modules
      const targetPkg = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@dsh-manager', 'dsh-capability-router', 'package.json');
      assert.ok(existsSync(targetPkg), '插件包应被复制进 profile node_modules');
      // 回归：cordis.patch.yml 必须一并拷贝（bundles 登记后 DSH boot loadOverlayPatches 依赖它，缺失导致启动 ENOENT）
      const targetPatch = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@dsh-manager', 'dsh-capability-router', 'cordis.patch.yml');
      assert.ok(existsSync(targetPatch), 'cordis.patch.yml 应被复制进 profile node_modules');
      const srcDir = mod.resolveBundledPluginDir();
      assert.ok(readFileSync(join(srcDir, 'cordis.patch.yml'), 'utf-8') === readFileSync(targetPatch, 'utf-8'), '拷贝的 cordis.patch.yml 应与源一致');
      const r2 = await mod.installCapabilityRouter('web');
      assert.equal(r2.success, true);
      assert.equal(r2.installed, true);
    });
  });

  it('旧版本插件残留（cordis.patch.yml insert 方式）→ 安装时迁移为官方 bundles 并覆盖更新', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      // 预置一个旧版本插件（标记 OLD_VERSION_MARKER），模拟 test.1~6 安装的旧残留
      const pkgDir = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@dsh-manager', 'dsh-capability-router');
      const libDir = join(pkgDir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, 'index.js'), '// OLD_VERSION_MARKER\nexport default class OldPlugin {};\n', 'utf-8');
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@dsh-manager/dsh-capability-router', version: '0.0.1', type: 'module', main: 'lib/index.js' }), 'utf-8');
      // 旧安装方式：cordis.patch.yml 已有 insert 条目
      const profileDir = join(process.env.DSH_HOME, 'profiles', 'web');
      mkdirSync(profileDir, { recursive: true });
      const patchFile = join(profileDir, 'cordis.patch.yml');
      writeFileSync(patchFile, [
        '# dsh profile patch layer',
        '- insert:',
        '    - id: capability-router',
        "      name: '@dsh-manager/dsh-capability-router'",
        '      config:',
        '        enabled: true',
        ''
      ].join('\n'));
      const r = await mod.installCapabilityRouter('web');
      assert.equal(r.success, true);
      assert.equal(r.installed, true);
      assert.equal(r.method, 'copied+bundle+migrated', '旧残留应复制新文件、登记 bundles 并迁移旧 patch');
      const updated = readFileSync(join(libDir, 'index.js'), 'utf-8');
      assert.ok(!updated.includes('OLD_VERSION_MARKER'), '旧版本文件应被更新为新版本');
      // 回归：旧安装若缺 cordis.patch.yml（曾导致 DSH 启动 ENOENT），重装应补齐
      const patchCopy = join(pkgDir, 'cordis.patch.yml');
      assert.ok(existsSync(patchCopy), '重装应补齐缺失的 cordis.patch.yml');
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8'));
      assert.ok(manifest.dsh.profile.bundles.includes('@dsh-manager/dsh-capability-router'), 'bundles 应含插件包名');
      const patchAfter = readFileSync(patchFile, 'utf-8');
      assert.ok(!patchAfter.includes('capability-router'), '迁移后旧 insert 条目应被移除（避免 loader 重复注册）');
      // 再次安装（内容已一致且已登记）→ 幂等不重复复制/登记
      const r2 = await mod.installCapabilityRouter('web');
      assert.equal(r2.method, 'already-exists', '内容一致且已登记时应幂等（already-exists）');
    });
  });

  it('uninstallCapabilityRouter 从 bundles 移除并清理旧 patch 条目', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const profileDir = join(process.env.DSH_HOME, 'profiles', 'web');
      mkdirSync(profileDir, { recursive: true });
      // 预置官方 bundles 登记
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web', private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-manager/dsh-capability-router'] } },
      }, null, 2), 'utf-8');
      // 预置 node_modules 包文件（isCapabilityRouterInstalled 要求包已复制）
      const pkgDir = join(profileDir, 'node_modules', '@dsh-manager', 'dsh-capability-router');
      mkdirSync(join(pkgDir, 'lib'), { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@dsh-manager/dsh-capability-router', version: '1.0.1', type: 'module', main: 'lib/index.js' }), 'utf-8');
      writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export default class CapabilityRouter {}\n', 'utf-8');
      // 同时预置旧 patch 残留
      const patchFile = join(profileDir, 'cordis.patch.yml');
      writeFileSync(patchFile, [
        '# dsh profile patch layer',
        '- insert:',
        '    - id: capability-router',
        "      name: '@dsh-manager/dsh-capability-router'",
        '      config:',
        '        enabled: true',
        ''
      ].join('\n'));
      assert.equal(mod.isCapabilityRouterInstalled('web'), true, '卸载前应视为已安装');
      const r = await mod.uninstallCapabilityRouter('web');
      assert.equal(r.success, true);
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8'));
      assert.ok(!manifest.dsh.profile.bundles.includes('@dsh-manager/dsh-capability-router'), 'bundles 不应再含插件包名');
      assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), '其它 bundle 应保留');
      const after = readFileSync(patchFile, 'utf-8');
      assert.ok(!after.includes('capability-router'), '卸载后旧 patch 不应再有 capability-router');
    });
  });

  it('detectNodeRuntime 返回 Node 版本与门槛判定', async () => {
    const mod = await import('../packages/core/src/capability-router.js');
    assert.equal(typeof mod.detectNodeRuntime, 'function', '应导出 detectNodeRuntime');
    const info = await mod.detectNodeRuntime();
    assert.ok(info, '应返回运行时信息');
    assert.equal(typeof info.meetsRequirement, 'boolean', '应包含 meetsRequirement 布尔');
    assert.ok(['portable', 'system', ''].includes(info.source || ''), 'source 应为 portable/system');
    // 本机 Node（开发环境）应满足门槛
    if (info.version) {
      const major = parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
      assert.ok(major >= 22, '本机 Node ' + process.version + ' 应满足 Node >= 22（否则 DSH 无法解析 profile 插件）');
    }
    assert.equal(mod.CAPABILITY_ROUTER_MIN_NODE_MAJOR, 22, '最低 Node 门槛应为 22');
  });

  it('installCapabilityRouter 返回值包含 node 信息', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const r = await mod.installCapabilityRouter('web');
      assert.equal(r.success, true);
      assert.ok('node' in r, '返回值应包含 node 字段');
      // node 信息可为 null（极端环境），但字段必须存在
      assert.ok(r.node === null || typeof r.node === 'object');
      assert.ok('warning' in r, '返回值应包含 warning 字段');
      // 本机满足门槛时不应有 warning
      assert.equal(r.warning, undefined, '本机 Node 满足门槛不应有 warning');
    });
  });

  it('插件包清单符合官方 dsh.bundle.patch 规范（exportsPatch 语义）', async () => {
    const root = join(__dirname, '..');
    const pkg = JSON.parse(readFileSync(join(root, 'packages', 'plugins', 'dsh-capability-router', 'package.json'), 'utf-8'));
    // 官方 @deepseek-ai/dsh plugin 模块：exportsPatch = manifest.dsh?.bundle?.patch !== undefined
    assert.ok(pkg.dsh && typeof pkg.dsh.bundle === 'object' && pkg.dsh.bundle.patch, '应声明 dsh.bundle.patch（官方插件清单字段）');
    assert.equal(pkg.dsh.profile, undefined, '不应再使用 profile 清单格式 dsh.profile.bundles（那是整个 profile 的 package.json 用的）');
    const patchFile = join(root, 'packages', 'plugins', 'dsh-capability-router', pkg.dsh.bundle.patch);
    assert.ok(existsSync(patchFile), 'dsh.bundle.patch 指向的补丁文件应存在');
    const patch = readFileSync(patchFile, 'utf-8');
    assert.ok(patch.includes('@dsh-manager/dsh-capability-router'), '补丁应声明插件包名');
    assert.ok(pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh'], '应声明 @deepseek-ai/dsh peer 依赖');
    assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'], '应声明 @deepseek-ai/cordis peer 依赖');
    assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery'], '应声明 @deepseek-ai/schemastery peer 依赖');
    assert.ok(pkg.files && pkg.files.includes('lib'), 'files 应包含 lib（随 npm/pnpm 发布）');
    assert.ok(pkg.keywords && pkg.keywords.includes('dsh-plugin'), 'keywords 应含 dsh-plugin（插件市场检索）');
  });

  it('迁移旧 insert 条目后 cordis.patch.yml 必须仍为顶层 YAML 数组（回归 v1.3.20 启动失败）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const profileDir = join(process.env.DSH_HOME, 'profiles', 'web');
      const pkgDir = join(profileDir, 'node_modules', '@dsh-manager', 'dsh-capability-router');
      mkdirSync(join(pkgDir, 'lib'), { recursive: true });
      // 最典型旧残留：只有注释 + 一个 insert 块（无其它条目）
      const patchFile = join(profileDir, 'cordis.patch.yml');
      writeFileSync(patchFile, [
        '# dsh profile patch layer',
        '- insert:',
        '    - id: capability-router',
        "      name: '@dsh-manager/dsh-capability-router'",
        '      config:',
        '        enabled: true',
        ''
      ].join('\n'), 'utf-8');
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@dsh-manager/dsh-capability-router', version: '0.0.1', main: 'lib/index.js' }), 'utf-8');
      writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export default class OldPlugin {};\n', 'utf-8');

      const r = await mod.installCapabilityRouter('web');
      assert.equal(r.method, 'copied+bundle+migrated', '旧残留应迁移');
      const after = readFileSync(patchFile, 'utf-8');
      // DSH 要求顶层 YAML 数组：非注释首行必须是 `- ` 条目或 `[]`
      const lines = after.split(/\r?\n/).filter((l) => l.trim() !== '');
      const firstContent = lines.find((l) => !l.trim().startsWith('#'));
      assert.ok(
        firstContent === '[]' || (firstContent && firstContent.startsWith('- ')),
        '迁移后应为顶层数组，实际首条非注释行: ' + JSON.stringify(firstContent)
      );
    });
  });

  it('已损坏（非数组）的 cordis.patch.yml 在安装能力路由时被自愈为合法数组', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const profileDir = join(process.env.DSH_HOME, 'profiles', 'web');
      const pkgDir = join(profileDir, 'node_modules', '@dsh-manager', 'dsh-capability-router');
      mkdirSync(join(pkgDir, 'lib'), { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@dsh-manager/dsh-capability-router', version: '1.0.1', main: 'lib/index.js' }), 'utf-8');
      writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export default class CapabilityRouter {}\n', 'utf-8');
      // v1.3.20 曾把 patch 写坏：只剩注释，无数组条目（DSH 报 must be a top-level YAML array）
      const patchFile = join(profileDir, 'cordis.patch.yml');
      writeFileSync(patchFile, '# dsh profile patch layer\n\n', 'utf-8');
      const r = await mod.installCapabilityRouter('web');
      assert.equal(r.success, true);
      const after = readFileSync(patchFile, 'utf-8');
      assert.ok(after.trim().includes('[]') || /(^|\n)\s*-\s/.test(after), '损坏的 patch 应被自愈为顶层数组，实际: ' + JSON.stringify(after));
    });
  });
});
