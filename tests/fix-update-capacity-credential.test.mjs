/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * 三项修复的回归测试（全部基于真实模块真实文件，不做 mock 断言自欺）：
 *  ① 插件更新链路：前置版本校验 → 目标版本精确重装 → 回读磁盘真值 → 未生效抛错 /
 *     无法确认时不谎报成功 / force 真实透传 pnpm `--force`
 *  ② 上下文窗口 & 最大输出 token：前后端白名单字段 + 正整数归一化 + 落盘可被 DSH 消费
 *  ③ 凭据安全：明文不下发渲染层 / config:get-all 只给状态 / 凭据写回保留 records 段
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const coreUrl = pathToFileURL(path.join(root, 'packages/core/src/index.js')).href;
const installerUrl = pathToFileURL(path.join(root, 'packages/marketplace/src/installer.js')).href;

const { DSHConfig } = await import(coreUrl);
const { buildPluginAddArgs, PluginInstaller } = await import(installerUrl);

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

/** 在系统临时目录建一份隔离的 DSHConfig（绝不触碰真实 ~/.dsh） */
function tmpConfig(settingsYaml = '', credYaml = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fix-'));
  const cfg = new DSHConfig();
  cfg.configPath = path.join(dir, 'settings.yaml');
  cfg.credPath = path.join(dir, '.credentials.yaml');
  if (settingsYaml) fs.writeFileSync(cfg.configPath, settingsYaml, 'utf-8');
  if (credYaml) fs.writeFileSync(cfg.credPath, credYaml, 'utf-8');
  return { dir, cfg };
}

const mkPlugin = (version) => ({
  id: 'demo-plugin',
  name: 'demo-plugin',
  version,
  source: 'npm:demo-plugin',
  profile: 'web',
});

/** 构造带假 registry / 假安装器 / 假磁盘的 PluginInstaller，捕获实际安装入参 */
function makeInstaller({ plugins = [], check = null, disk = {} } = {}) {
  const calls = [];
  const registry = {
    getLocalPlugins: () => plugins,
    checkPluginUpdate: async () => {
      if (check instanceof Error) throw check;
      return check;
    },
  };
  const installer = new PluginInstaller({ registry, profile: 'web' });
  installer.install = async (source, options) => {
    calls.push({ source, options });
    return { success: true, id: 'demo-plugin', name: 'demo-plugin', version: '9.9.9' };
  };
  // 只在「模拟磁盘」里存在候选包名时才返回版本，等价于 package.json 存在性
  installer._readInstalledVersion = (profile, name) => disk[name] || null;
  return { installer, calls };
}

describe('修复① 插件更新链路', () => {
  it('buildPluginAddArgs: 更新场景固定目标版本（规避 pnpm「已满足即跳过」）', () => {
    assert.deepEqual(
      buildPluginAddArgs('web', 'demo-plugin', { targetVersion: '2.0.0' }),
      ['plugin', '--profile', 'web', 'add', 'demo-plugin@2.0.0']
    );
  });

  it('buildPluginAddArgs: force=true 真实追加 --force（dsh plugin 是 pnpm 直通转发器）', () => {
    const args = buildPluginAddArgs('web', '@scope/demo', { targetVersion: '2.0.0', force: true });
    assert.deepEqual(args, ['plugin', '--profile', 'web', 'add', '@scope/demo@2.0.0', '--force']);
    assert.equal(args.includes('--force'), true);
  });

  it('buildPluginAddArgs: 无目标版本 / latest 时不加版本后缀，也不凭空造 --force', () => {
    assert.deepEqual(buildPluginAddArgs('web', 'demo-plugin', {}), ['plugin', '--profile', 'web', 'add', 'demo-plugin']);
    assert.deepEqual(
      buildPluginAddArgs('web', 'demo-plugin', { targetVersion: 'latest' }),
      ['plugin', '--profile', 'web', 'add', 'demo-plugin']
    );
  });

  it('update: 前置校验无新版本 → 明确「已是最新」，且根本不执行安装', async () => {
    const { installer, calls } = makeInstaller({
      plugins: [mkPlugin('1.0.0')],
      check: { hasUpdate: false, latestVersion: '1.0.0' },
      disk: { 'demo-plugin': '1.0.0' },
    });
    const r = await installer.update('demo-plugin');
    assert.equal(r.updated, false);
    assert.equal(r.alreadyLatest, true);
    assert.equal(r.needsRestart, false);
    assert.equal(calls.length, 0, '无更新时不应空转重装');
  });

  it('update: 有更新且磁盘已落盘新版本 → updated=true 且提示重启', async () => {
    const { installer, calls } = makeInstaller({
      plugins: [mkPlugin('1.0.0')],
      check: { hasUpdate: true, latestVersion: '2.0.0' },
      disk: { 'demo-plugin': '2.0.0' },
    });
    const r = await installer.update('demo-plugin');
    assert.equal(r.updated, true);
    assert.equal(r.needsRestart, true);
    assert.equal(r.verified, true);
    assert.equal(r.verifiedFrom, 'demo-plugin');
    assert.equal(calls[0].options.targetVersion, '2.0.0', '安装必须锁定目标版本');
  });

  it('update: 有更新但磁盘版本未变 → 抛错，绝不谎报成功', async () => {
    const { installer } = makeInstaller({
      plugins: [mkPlugin('1.0.0')],
      check: { hasUpdate: true, latestVersion: '2.0.0' },
      disk: { 'demo-plugin': '1.0.0' },
    });
    await assert.rejects(
      () => installer.update('demo-plugin'),
      (err) => {
        assert.match(err.message, /未生效/);
        assert.match(err.message, /2\.0\.0/);
        return true;
      }
    );
  });

  it('update: 磁盘读不到 package.json → 回报「无法确认」而非成功', async () => {
    const { installer } = makeInstaller({
      plugins: [mkPlugin('1.0.0')],
      check: { hasUpdate: true, latestVersion: '2.0.0' },
      disk: {},
    });
    const r = await installer.update('demo-plugin');
    assert.equal(r.unverified, true);
    assert.equal(r.updated, false);
    assert.equal(r.alreadyLatest, false);
    assert.equal(r.verified, false);
    assert.match(r.warning, /未能/);
  });

  it('update: force=true → 跳过短路、透传 force、同版本重装标记 reinstalled', async () => {
    const { installer, calls } = makeInstaller({
      plugins: [mkPlugin('1.0.0')],
      check: { hasUpdate: false, latestVersion: '1.0.0' },
      disk: { 'demo-plugin': '1.0.0' },
    });
    const r = await installer.update('demo-plugin', { force: true });
    assert.equal(calls.length, 1, 'force 必须真正执行重装');
    assert.equal(calls[0].options.force, true);
    assert.equal(r.reinstalled, true);
    assert.equal(r.updated, false);
    assert.equal(r.needsRestart, true);
  });

  it('update: 前置校验失败 → 降级为磁盘回读校验，不误报成功', async () => {
    const { installer, calls } = makeInstaller({
      plugins: [mkPlugin('1.0.0')],
      check: new Error('registry unreachable'),
      disk: { 'demo-plugin': '1.0.0' },
    });
    const r = await installer.update('demo-plugin');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.targetVersion, '', '校验失败时不应锁死虚假目标版本');
    assert.equal(r.updated, false);
    assert.equal(r.alreadyLatest, true);
  });

  it('update: 插件不存在 → 抛「插件未找到」', async () => {
    const { installer } = makeInstaller({ plugins: [] });
    await assert.rejects(() => installer.update('ghost'), /插件未找到/);
  });

  it('update: git 源 id 与目录名不一致时，按安装结果 id 回读磁盘真值', async () => {
    const { installer } = makeInstaller({
      plugins: [{ ...mkPlugin('1.0.0'), id: '@scope/demo-plugin' }],
      check: { hasUpdate: true, latestVersion: '2.0.0' },
      disk: { 'demo-plugin': '2.0.0' }, // 长名未命中，短名命中
    });
    const r = await installer.update('@scope/demo-plugin');
    assert.equal(r.verified, true);
    assert.equal(r.verifiedFrom, 'demo-plugin');
  });

  it('接线：preload 透传 force，ipc 把 options 交给 installer.update', () => {
    const preload = read('electron/preload.cjs');
    assert.match(preload, /updatePlugin/);
    assert.match(preload, /force/);
    const ipc = read('electron/ipc-handlers.js');
    assert.match(ipc, /installer\.update\(pluginId,\s*options/);
    assert.match(ipc, /marketplace:update-plugin/);
  });
});

describe('修复② 上下文窗口 / 最大输出 token', () => {
  it('normalizeModelCapacity: 正整数、容量字符串、非法值一律拦截', () => {
    assert.equal(DSHConfig.normalizeModelCapacity(8192), 8192);
    assert.equal(DSHConfig.normalizeModelCapacity('8192'), 8192);
    assert.equal(DSHConfig.normalizeModelCapacity('128K'), 131072);
    assert.equal(DSHConfig.normalizeModelCapacity('1M'), 1048576);
    assert.equal(DSHConfig.normalizeModelCapacity('1.5m'), 1572864);
    assert.equal(DSHConfig.normalizeModelCapacity('abc'), null);
    assert.equal(DSHConfig.normalizeModelCapacity(0), null);
    assert.equal(DSHConfig.normalizeModelCapacity(-1), null);
    assert.equal(DSHConfig.normalizeModelCapacity(''), null);
    assert.equal(DSHConfig.normalizeModelCapacity(undefined), null);
  });

  it('saveLLMProvider: models 数组的容量字段落库为正整数', async () => {
    const { cfg } = tmpConfig();
    await cfg.saveLLMProvider('prov-a', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-aaa',
      models: [
        { id: 'model-a', contextWindow: '128K', maxTokens: '8192' },
        { id: 'model-b', contextWindow: 200000, maxTokens: 4096 },
      ],
    }, 'openai-compatible');

    const { settings } = await cfg.read();
    const models = settings['llm-pi-ai'].providers['prov-a'].models;
    assert.equal(models[0].contextWindow, 131072);
    assert.equal(models[0].maxTokens, 8192);
    assert.equal(models[1].contextWindow, 200000);
    assert.equal(models[1].maxTokens, 4096);
    for (const m of models) {
      assert.equal(Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0, true);
      assert.equal(Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0, true);
    }
  });

  it('saveLLMProvider: 非法容量值直接丢弃，避免 DSH 拒绝整个模型', async () => {
    const { cfg } = tmpConfig();
    await cfg.saveLLMProvider('prov-b', {
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1', contextWindow: 'not-a-number', maxTokens: -5 }],
    }, 'openai-compatible');
    const { settings } = await cfg.read();
    const model = settings['llm-pi-ai'].providers['prov-b'].models[0];
    assert.equal('contextWindow' in model, false);
    assert.equal('maxTokens' in model, false);
  });

  it('saveLLMProvider: 单模型（无 models 数组）时容量字段跟随顶层', async () => {
    const { cfg } = tmpConfig();
    await cfg.saveLLMProvider('prov-c', {
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      contextWindow: '128K',
      maxTokens: 4096,
    }, 'openai-compatible');
    const { settings } = await cfg.read();
    const model = settings['llm-pi-ai'].providers['prov-c'].models[0];
    assert.equal(model.id, 'gpt-4o');
    assert.equal(model.contextWindow, 131072);
    assert.equal(model.maxTokens, 4096);
  });

  it('接线：渲染层表单字段与 config 白名单字段同名', () => {
    const appJs = read('src/assets/js/app.js');
    assert.match(appJs, /contextWindow/);
    assert.match(appJs, /maxTokens/);
    const configJs = read('packages/core/src/config.js');
    assert.match(configJs, /_extractModelCapacity/);
    assert.match(configJs, /contextWindow/);
    assert.match(configJs, /maxTokens/);
  });
});

describe('修复③ 密钥不落渲染层 / 凭据写回不丢 records', () => {
  it('sanitizeSettingsForRenderer: 两类历史明文路径都替换为状态位，明文不出主进程', () => {
    const settings = {
      llm: { legacyprov: { apiKey: 'sk-legacy-secret', model: 'x' }, clean: { model: 'y' } },
      'llm-pi-ai': { providers: { p1: { apiKey: 'sk-p1-secret', api: 'openai-completions' }, p2: { api: 'x' } } },
    };
    const safe = DSHConfig.sanitizeSettingsForRenderer(settings);
    assert.equal(safe.llm.legacyprov.apiKeyConfigured, true);
    assert.equal('apiKey' in safe.llm.legacyprov, false);
    assert.equal('apiKeyConfigured' in safe.llm.clean, false);
    assert.equal(safe['llm-pi-ai'].providers.p1.apiKeyConfigured, true);
    assert.equal('apiKey' in safe['llm-pi-ai'].providers.p1, false);
    assert.equal(JSON.stringify(safe).includes('sk-'), false, '下发副本不得含任何明文密钥');
    assert.equal(settings.llm.legacyprov.apiKey, 'sk-legacy-secret', '不得改动入参');
  });

  it('describeCredentials: 只返回 configured 状态，且 records 段键归 records', async () => {
    const credYaml = 'version: 1\nrefs:\n  K1: sk-1\nrecords:\n  R1: rv1\n  ROBJ:\n    a: 1\n';
    const { cfg } = tmpConfig('', credYaml);
    const desc = await cfg.describeCredentials();
    assert.deepEqual(desc.refs, { K1: { configured: true } });
    assert.deepEqual(desc.records, { R1: { configured: true } });
    assert.equal(desc.count, 2);
    assert.equal(JSON.stringify(desc).includes('sk-1'), false);
    assert.equal(JSON.stringify(desc).includes('rv1'), false);
  });

  it('凭据写回保留 records 段（含非字符串条目）', async () => {
    const credYaml = 'version: 1\nrefs:\n  K1: sk-1\nrecords:\n  R1: rv1\n  ROBJ:\n    a: 1\n';
    const { cfg } = tmpConfig('', credYaml);
    const { credentials } = await cfg.read();
    credentials.NEW_KEY = 'sk-new';
    await cfg.write(credentials, 'credentials');

    const text = fs.readFileSync(cfg.credPath, 'utf-8');
    assert.match(text, /records:/);
    assert.match(text, /ROBJ/);
    const after = await cfg.read();
    assert.equal(after.credentials.K1, 'sk-1');
    assert.equal(after.credentials.R1, 'rv1', 'records 段的键不得被搬去 refs 或丢弃');
    assert.equal(after.credentials.NEW_KEY, 'sk-new');
  });

  it('saveLLMProvider: 历史明文密钥迁移进凭据文件，settings 不再残留明文', async () => {
    const settingsYaml = [
      'llm:',
      '  legacyprov:',
      '    model: gpt-4o',
      '    apiKey: sk-legacy-123',
      '    baseUrl: https://old.example.com/v1',
      '',
    ].join('\n');
    const { cfg } = tmpConfig(settingsYaml);
    const r = await cfg.saveLLMProvider('legacyprov', {
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'gpt-4o' }],
    }, 'openai');

    assert.equal(fs.readFileSync(cfg.configPath, 'utf-8').includes('sk-legacy-123'), false);
    assert.equal(fs.readFileSync(cfg.credPath, 'utf-8').includes('sk-legacy-123'), true);
    const { settings, credentials } = await cfg.read();
    assert.equal(settings.llm, undefined, '旧 llm.<name> 明文段应被清理');
    assert.equal(credentials[r.apiKeyEnv], 'sk-legacy-123');
  });

  it('read(): settings.yaml 缺失时仍能读到磁盘凭据（防止写空凭据文件）', async () => {
    const credYaml = 'version: 1\nrefs:\n  K1: sk-1\nrecords:\n  R1: rv1\n';
    const { cfg } = tmpConfig('', credYaml); // 只有凭据文件，没有 settings.yaml
    const { settings, credentials } = await cfg.read();
    assert.deepEqual(settings, {});
    assert.equal(credentials.K1, 'sk-1');
    assert.equal(credentials.R1, 'rv1');

    credentials.K2 = 'sk-2';
    await cfg.write(credentials, 'credentials');
    const after = await cfg.read();
    assert.equal(after.credentials.K1, 'sk-1', '已有凭据不得被写空');
    assert.equal(after.credentials.R1, 'rv1');
    assert.equal(after.credentials.K2, 'sk-2');
  });

  it('saveLLMProvider: 重输新 key → 复用引用名并覆盖为最新值（保存即生效）', async () => {
    const { cfg } = tmpConfig();
    const first = await cfg.saveLLMProvider('my-prov', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-first',
      models: [{ id: 'm' }],
    }, 'openai');
    const second = await cfg.saveLLMProvider('my-prov', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-second',
      apiKeyEnv: first.apiKeyEnv, // 编辑态表单会带回旧引用名
      models: [{ id: 'm' }],
    }, 'openai');

    assert.equal(second.apiKeyEnv, first.apiKeyEnv, '应复用同一引用名');
    const { credentials, settings } = await cfg.read();
    assert.equal(credentials[second.apiKeyEnv], 'sk-second', '新 key 必须覆盖旧值');
    assert.equal(settings['llm-pi-ai'].providers['my-prov'].apiKeyEnv, second.apiKeyEnv);
    assert.equal(JSON.stringify(settings).includes('sk-second'), false, 'settings 永不含明文');
  });

  it('write(settings): 回写渲染层脱敏副本不丢历史明文，且状态位不落盘', async () => {
    const { cfg } = tmpConfig('llm:\n  keepme:\n    apiKey: sk-keep-me\n    model: gpt-4o\n');
    const { settings } = await cfg.read();
    const safe = DSHConfig.sanitizeSettingsForRenderer(settings);
    assert.equal(JSON.stringify(safe).includes('sk-keep-me'), false);
    safe.ui = { theme: 'dark' }; // 用户只改了别的配置
    await cfg.write(safe);

    const text = fs.readFileSync(cfg.configPath, 'utf-8');
    assert.equal(text.includes('sk-keep-me'), true, '保存其它配置不得静默删除历史密钥');
    assert.equal(text.includes('apiKeyConfigured'), false, '渲染层状态位不得污染 settings.yaml');
  });

  it('接线：config:get-all 走脱敏 + 状态接口，不下发明文', () => {
    const ipc = read('electron/ipc-handlers.js');
    assert.match(ipc, /sanitizeSettingsForRenderer/);
    assert.match(ipc, /describeCredentials/);
    assert.match(ipc, /config:get-all/);
  });
});
