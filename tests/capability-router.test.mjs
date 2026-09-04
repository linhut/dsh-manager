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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('installCapabilityRouter 复制插件并注册 cordis.patch.yml（幂等）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      assert.equal(mod.isCapabilityRouterInstalled('web'), false);
      const r = await mod.installCapabilityRouter('web');
      assert.equal(r.success, true);
      assert.equal(r.installed, true);
      const patch = readFileSync(join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'), 'utf-8');
      assert.ok(patch.includes('capability-router'), 'patch 应含 capability-router 条目');
      assert.ok(patch.includes('@dsh-manager/dsh-capability-router'), 'patch 应含插件包名');
      const pkgFile = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@dsh-manager', 'dsh-capability-router', 'package.json');
      assert.ok(existsSync(pkgFile), '插件包应被复制进 profile node_modules');
      const r2 = await mod.installCapabilityRouter('web');
      assert.equal(r2.success, true);
      assert.equal(r2.installed, true);
    });
  });

  it('旧版本插件残留 → 安装时内容不同则覆盖更新（多次测试升级场景）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      // 预置一个旧版本插件（标记 OLD_VERSION_MARKER），模拟 test.1~6 安装的旧残留
      const pkgDir = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@dsh-manager', 'dsh-capability-router');
      const libDir = join(pkgDir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, 'index.js'), '// OLD_VERSION_MARKER\nexport default class OldPlugin {};\n', 'utf-8');
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@dsh-manager/dsh-capability-router', version: '0.0.1', type: 'module', main: 'lib/index.js' }), 'utf-8');
      // patch 标记为已注册
      const patchFile = join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
      mkdirSync(join(process.env.DSH_HOME, 'profiles', 'web'), { recursive: true });
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
      assert.equal(r.method, 'copied', '内容不同时应重新复制（copied）');
      const updated = readFileSync(join(libDir, 'index.js'), 'utf-8');
      assert.ok(!updated.includes('OLD_VERSION_MARKER'), '旧版本文件应被更新为新版本');
      // 再次安装（内容已一致）→ 幂等不重复复制
      const r2 = await mod.installCapabilityRouter('web');
      assert.equal(r2.method, 'already-exists', '内容一致时应幂等（already-exists）');
    });
  });

  it('uninstallCapabilityRouter 移除 patch 条目', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const patchFile = join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
      mkdirSync(join(process.env.DSH_HOME, 'profiles', 'web'), { recursive: true });
      writeFileSync(patchFile, [
        '# dsh profile patch layer',
        '- insert:',
        '    - id: capability-router',
        "      name: '@dsh-manager/dsh-capability-router'",
        '      config:',
        '        enabled: true',
        ''
      ].join('\n'));
      const r = await mod.uninstallCapabilityRouter('web');
      assert.equal(r.success, true);
      const after = readFileSync(patchFile, 'utf-8');
      assert.ok(!after.includes('capability-router'), '卸载后不应再有 capability-router');
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
});
