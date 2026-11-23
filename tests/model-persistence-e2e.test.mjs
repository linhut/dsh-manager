/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 模型配置端到端落盘回归（临时 DSH_HOME 隔离环境）
// 覆盖：migrateLLMProviders 错误段搬迁 + 小写 baseUrl 兼容、saveLLMProvider 密钥迁移、
//       saveLLMRouting 双写、ModelConfigCenter 档案应用 4 工具 + 备份/还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

async function withEnv(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshm-persist-'));
  const dshHome = join(home, '.dsh');
  mkdirSync(join(dshHome, 'manager'), { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    await fn({ home, dshHome });
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('端到端：迁移 + 密钥迁移 + 路由双写 + 工具应用 + 备份还原', async () => {
  await withEnv(async ({ home, dshHome }) => {
    const settingsFile = join(dshHome, 'settings.yaml');
    const credFile = join(dshHome, '.credentials.yaml');
    // 模拟用户遗留：错误命名空间（含小写 baseUrl）+ llm-pi-ai 脏数据（provider 字段）+ 空 apiKeyEnv
    writeFileSync(settingsFile, [
      'llm-openai-compatible:',
      '  providers:',
      '    my-gw:',
      '      provider: openai-compatible',
      '      model: deepseek-v4-flash',
      '      apiKey: sk-legacy-plain-1234567890',
      '      baseUrl: "https://gw.example.com/v1"',
      'llm-pi-ai:',
      '  providers:',
      '    yang-newapi:',
      '      provider: pi-ai',
      '      apiKeyEnv: ""',
      '      api: openai-completions',
      '      baseURL: "http://192.168.1.9:65002/v1"',
      '      models:',
      '        - id: deepseek-v4-flash',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(credFile, 'YANG_KEY: sk-yang-123456\n', 'utf-8');

    const { DSHConfig } = await import('../packages/core/src/config.js');
    const { ModelConfigCenter } = await import('../packages/core/src/model-config-center.js');
    const cfg = new DSHConfig();

    // 1) 迁移
    const mig = await cfg.migrateLLMProviders();
    assert.equal(mig.moved, 1, '错误段 llm-openai-compatible 应搬迁到 llm-pi-ai');
    assert.ok(mig.normalized >= 1, 'llm-pi-ai 内 provider 字段/空 apiKeyEnv 应被清洗');
    const s1 = readFileSync(settingsFile, 'utf-8');
    assert.ok(!s1.includes('llm-openai-compatible'), 'settings 不应残留错误段');
    assert.ok(!s1.includes('sk-legacy-plain'), 'settings 不应残留明文密钥');
    assert.ok(s1.includes('my-gw:'), '小写 baseUrl 的条目应被成功迁移保留');

    // 2) 保存提供商（明文 key → 凭据文件）
    await cfg.saveLLMProvider('deepseek-official', {
      provider: 'deepseek', model: 'deepseek-v4-flash',
      apiKey: 'sk-new-plain-abcdef', baseUrl: 'https://api.deepseek.com/v1',
    });
    const s2 = readFileSync(settingsFile, 'utf-8');
    const c2 = readFileSync(credFile, 'utf-8');
    assert.ok(s2.includes('deepseek-official:'), '提供商应写入 llm-pi-ai');
    assert.ok(!s2.includes('sk-new-plain-abcdef'), 'settings 内不应有明文');
    assert.ok(c2.includes('sk-new-plain-abcdef'), '明文应迁移进 .credentials.yaml');

    // 3) 能力路由双写 + 默认模型
    await cfg.saveLLMRouting({
      enabled: true, defaultCapability: 'semantic',
      capabilities: { semantic: { provider: 'yang-newapi', model: 'deepseek-v4-flash' } },
    });
    const s3 = readFileSync(settingsFile, 'utf-8');
    assert.ok(s3.includes('capability-router:'), 'capability-router 段应写入');
    await cfg.applyDefaultModel('semantic');
    assert.ok(readFileSync(settingsFile, 'utf-8').includes('agent-default-model:'), 'agent-default-model 应写入');

    // 4) 档案 → 4 工具 + 备份/还原
    const toolPaths = {
      atomcode: join(home, 'atomcode', 'config.toml'),
      'claude-code': join(home, 'claude', 'settings.json'),
      workbuddy: join(home, 'codebuddy', 'models.json'),
      codex: join(home, 'codex', 'config.toml'),
    };
    const mcc = new ModelConfigCenter({ dataDir: join(dshHome, 'manager'), toolPaths });
    const prof = mcc.saveProfile({
      name: 'Y 网关', baseUrl: 'http://192.168.1.9:65002/v1', apiKey: 'sk-arch-abcdefgh1234',
      model: 'deepseek-v4-flash', vendor: 'DeepSeek', contextWindow: 1048576, maxTokens: 393216,
      supportsVision: true, temperature: 0.3, setDefault: true,
    });
    const listed = mcc.listProfiles()[0];
    assert.equal(listed.apiKey, '', 'list 应脱敏');
    assert.equal(listed.hasApiKey, true, 'hasApiKey 状态应保留');

    // 预置旧配置以验证备份（注意先建目录）
    mkdirSync(dirname(toolPaths.atomcode), { recursive: true });
    writeFileSync(toolPaths.atomcode, '[old]\nfoo = "bar"\n', 'utf-8');
    const r = mcc.apply(prof.id, ['atomcode', 'claude-code', 'workbuddy', 'codex']);
    assert.ok(r.results.every((x) => x.ok), '4 工具应用应全部成功');

    const wb = JSON.parse(readFileSync(toolPaths.workbuddy, 'utf-8'));
    assert.equal(wb.models[0].maxInputTokens, 1048576, '容量应写入档案显式值');
    assert.equal(wb.models[0].temperature, 0.3, 'temperature 应写入 WorkBuddy');
    assert.equal(wb.models[0].supportsImages, true, '视觉标志应写入');

    assert.ok(mcc.listBackups('atomcode').length >= 1, '写入前应有备份');
    const det = mcc.listTools().find((t) => t.id === 'atomcode');
    assert.equal(det.current.appliedProfileId, prof.id, '状态检测应反查档案');
    writeFileSync(toolPaths.atomcode, '[broken]\n', 'utf-8');
    const rev = mcc.revert('atomcode');
    assert.equal(rev.ok, true, '还原应成功');
    assert.ok(readFileSync(toolPaths.atomcode, 'utf-8').includes('foo = "bar"'), '还原应恢复备份内容');

    // 5) 规格表三级回退：档案未填容量 → lookupModelSpec
    const prof2 = mcc.saveProfile({ name: '最小档案', baseUrl: 'https://x.example.com/v1', apiKey: 'k1', model: 'deepseek-v4-flash' });
    mcc.apply(prof2.id, ['workbuddy']);
    const wb2 = JSON.parse(readFileSync(toolPaths.workbuddy, 'utf-8'));
    const entry2 = wb2.models.find((m) => m.id === 'deepseek-v4-flash');
    assert.equal(entry2.maxInputTokens, 1048576, '未填容量应回退知名规格表 1M');
    assert.equal(entry2.maxOutputTokens, 393216, '未填容量应回退知名规格表 384K');
  });
});

test('端到端：能力路由 listCapabilityModels 收集已配置模型', async () => {
  await withEnv(async ({ home, dshHome }) => {
    writeFileSync(join(dshHome, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    yang-newapi:',
      '      apiKeyEnv: YANG_KEY',
      '      api: openai-completions',
      '      baseURL: "http://192.168.1.9:65002/v1"',
      '      models:',
      '        - id: deepseek-v4-flash',
      '        - id: glm-5v-turbo',
      '',
    ].join('\n'), 'utf-8');
    const { DSHConfig } = await import('../packages/core/src/config.js');
    const cfg = new DSHConfig();
    const models = await cfg.listCapabilityModels();
    assert.equal(models.length, 2);
    assert.ok(models.every((m) => m.providerKey === 'yang-newapi'));
  });
});