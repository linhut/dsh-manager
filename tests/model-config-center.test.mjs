/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 模型配置中心（Model Config Center）回归测试：
// 档案 CRUD / 密钥脱敏 / 三工具适配器写入（AtomCode TOML、Claude Code settings.json、
// WorkBuddy models.json）/ 备份还原 / 当前状态检测
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelConfigCenter, renderTomlUpserts } from '../packages/core/src/model-config-center.js';

/** 构造一个使用临时目录的实例（档案目录 + 三个工具配置文件全部落在临时目录） */
function makeCenter() {
  const root = mkdtempSync(join(tmpdir(), 'dshm-mcc-'));
  const dataDir = join(root, 'data');
  const toolPaths = {
    atomcode: join(root, 'atomcode', 'config.toml'),
    'claude-code': join(root, 'claude', 'settings.json'),
    workbuddy: join(root, 'codebuddy', 'models.json'),
    codex: join(root, 'codex', 'config.toml'),
  };
  return { root, center: new ModelConfigCenter({ dataDir, toolPaths }), toolPaths };
}

const BASE = {
  name: 'Y 网关',
  baseUrl: 'http://192.168.1.9:65002/v1',
  apiKey: 'sk-real-key-1234567890',
  model: 'deepseek-v4-flash',
  contextWindow: 1048576,
  maxTokens: 393216,
  supportsVision: false,
  supportsToolCall: true,
};

describe('模型配置中心（ModelConfigCenter）', () => {
  let ctx;
  beforeEach(() => { ctx = makeCenter(); });

  // ====== 档案 CRUD ======

  it('saveProfile 创建档案，list/get 返回脱敏值（不泄露明文密钥）', () => {
    const { center } = ctx;
    const saved = center.saveProfile({ ...BASE });
    assert.ok(saved.id);
    assert.equal(saved.apiKey, '', '渲染层不应拿到明文密钥');
    assert.ok(saved.apiKeyMasked.includes('****'));
    assert.equal(saved.hasApiKey, true);

    const list = center.listProfiles();
    assert.equal(list.length, 1);
    assert.equal(list[0].apiKey, '');
    assert.equal(list[0].baseUrl, BASE.baseUrl);

    const got = center.getProfile(saved.id);
    assert.equal(got.model, BASE.model);
    assert.equal(got.apiKey, '');
  });

  it('saveProfile 必填校验：名称/地址/模型缺失抛错', () => {
    const { center } = ctx;
    assert.throws(() => center.saveProfile({ name: '', baseUrl: 'x', model: 'm' }), /名称/);
    assert.throws(() => center.saveProfile({ name: 'n', baseUrl: '', model: 'm' }), /地址/);
    assert.throws(() => center.saveProfile({ name: 'n', baseUrl: 'x', model: '' }), /模型/);
  });

  it('saveProfile 更新时传入空/脱敏密钥保留原密钥，传入新值覆盖', () => {
    const { center } = ctx;
    const saved = center.saveProfile({ ...BASE });
    // 空字符串 → 保留
    center.saveProfile({ id: saved.id, name: 'Y 网关', baseUrl: BASE.baseUrl, model: BASE.model, apiKey: '' });
    assert.equal(center._findProfile(saved.id).apiKey, BASE.apiKey);
    // 脱敏占位 → 保留
    center.saveProfile({ id: saved.id, name: 'Y 网关', baseUrl: BASE.baseUrl, model: BASE.model, apiKey: 'sk-r****7890' });
    assert.equal(center._findProfile(saved.id).apiKey, BASE.apiKey);
    // 新值 → 覆盖
    center.saveProfile({ id: saved.id, name: 'Y 网关', baseUrl: BASE.baseUrl, model: BASE.model, apiKey: 'sk-new' });
    assert.equal(center._findProfile(saved.id).apiKey, 'sk-new');
  });

  it('saveProfile 支持 apiKeyEnv 环境变量引用（不存明文）', () => {
    const { center } = ctx;
    const saved = center.saveProfile({ ...BASE, apiKey: '', apiKeyEnv: 'YANG_KEY' });
    assert.equal(center._findProfile(saved.id).apiKeyEnv, 'YANG_KEY');
    assert.equal(center._findProfile(saved.id).apiKey, '');
  });

  it('deleteProfile 删除指定档案', () => {
    const { center } = ctx;
    const a = center.saveProfile({ ...BASE, name: 'A' });
    center.saveProfile({ ...BASE, name: 'B', model: 'glm-5.2' });
    assert.equal(center.deleteProfile(a.id), true);
    assert.equal(center.listProfiles().length, 1);
    assert.equal(center.deleteProfile('nope'), false);
  });

  it('exportProfiles/importProfiles 往返', () => {
    const { center } = ctx;
    center.saveProfile({ ...BASE });
    const json = center.exportProfiles();
    assert.ok(json.includes(BASE.apiKey), '导出包含明文密钥（本地数据导出）');
    const center2 = new ModelConfigCenter({ dataDir: mkdtempSync(join(tmpdir(), 'dshm-mcc2-')), toolPaths: ctx.toolPaths });
    assert.equal(center2.importProfiles(json), 1);
    assert.equal(center2.listProfiles().length, 1);
    assert.throws(() => center2.importProfiles('{"bad":1}'), /格式/);
  });

  // ====== AtomCode 适配器 ======

  it('apply→atomcode：写入 provider_accounts + models 段落，保留无关段落', () => {
    const { center, toolPaths } = ctx;
    mkdirSync(join(toolPaths.atomcode, '..'), { recursive: true });
    writeFileSync(toolPaths.atomcode, [
      'default_provider = "old"',
      '',
      '[lsp]',
      'enabled = true',
      '',
    ].join('\n'));
    const p = center.saveProfile({ ...BASE });
    const r = center.apply(p.id, ['atomcode']);
    assert.equal(r.results[0].ok, true);
    const out = readFileSync(toolPaths.atomcode, 'utf-8');
    assert.ok(out.includes('[lsp]') && out.includes('enabled = true'), '无关段落应保留');
    assert.ok(out.includes('[provider_accounts.' + p.id + ']'));
    assert.ok(out.includes('[models."' + p.id + '/deepseek-v4-flash"]'));
    assert.ok(out.includes('api_key = "sk-real-key-1234567890"'));
    assert.ok(out.includes('base_url = "http://192.168.1.9:65002/v1"'));
    assert.ok(out.includes('context_window = 1048576'));
    assert.ok(out.includes('max_tokens = 393216'));
    assert.ok(!out.includes('default_model ='), '未开启 setDefault 时不应改默认模型');
  });

  it('apply→atomcode：再次应用同档案就地更新（不产生重复段落）', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE });
    center.apply(p.id, ['atomcode']);
    center.apply(p.id, ['atomcode']);
    const out = readFileSync(toolPaths.atomcode, 'utf-8');
    const count = out.split('[models."').length - 1;
    assert.equal(count, 1, '同一档案重复应用不应产生重复段落');
  });

  it('apply→atomcode：setDefault 时更新 default_provider/default_model', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE, setDefault: true });
    center.apply(p.id, ['atomcode']);
    const out = readFileSync(toolPaths.atomcode, 'utf-8');
    assert.ok(out.includes(`default_provider = "${p.id}"`));
    assert.ok(out.includes(`default_model = "${p.id}/deepseek-v4-flash"`));
  });

  it('apply→atomcode：apiKeyEnv 写为 $ENV 引用', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE, apiKey: '', apiKeyEnv: 'YANG_KEY' });
    center.apply(p.id, ['atomcode']);
    const out = readFileSync(toolPaths.atomcode, 'utf-8');
    assert.ok(out.includes('api_key = "$YANG_KEY"'));
  });

  // ====== Claude Code 适配器 ======

  it('apply→claude-code：env 块合并写入，保留 settings.json 其他键', () => {
    const { center, toolPaths } = ctx;
    mkdirSync(join(toolPaths['claude-code'], '..'), { recursive: true });
    writeFileSync(toolPaths['claude-code'], JSON.stringify({ permissions: { allow: ['Bash'] }, env: { SOME_OTHER: 'x' } }, null, 2));
    const p = center.saveProfile({ ...BASE, smallModel: 'deepseek-v4-lite' });
    center.apply(p.id, ['claude-code']);
    const out = JSON.parse(readFileSync(toolPaths['claude-code'], 'utf-8'));
    assert.deepEqual(out.permissions, { allow: ['Bash'] }, '其他键保留');
    assert.equal(out.env.SOME_OTHER, 'x');
    assert.equal(out.env.ANTHROPIC_BASE_URL, BASE.baseUrl);
    assert.equal(out.env.ANTHROPIC_AUTH_TOKEN, BASE.apiKey);
    assert.equal(out.env.ANTHROPIC_MODEL, BASE.model);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v4-lite');
    assert.equal(out.env.ANTHROPIC_CUSTOM_MODEL_OPTION, BASE.model);
  });

  it('apply→claude-code：无 apiKey 时不写入认证变量（保留原值）', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE, apiKey: '', apiKeyEnv: '' });
    center.apply(p.id, ['claude-code']);
    const out = JSON.parse(readFileSync(toolPaths['claude-code'], 'utf-8'));
    assert.equal(out.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(out.env.ANTHROPIC_BASE_URL, BASE.baseUrl);
  });

  // ====== WorkBuddy 适配器 ======

  it('apply→workbuddy：models 按 id 合并 + availableModels 更新 + URL 补全', () => {
    const { center, toolPaths } = ctx;
    mkdirSync(join(toolPaths.workbuddy, '..'), { recursive: true });
    writeFileSync(toolPaths.workbuddy, JSON.stringify({
      models: [{ id: 'other-model', name: '旧模型', url: 'https://a.example.com/v1/chat/completions' }],
      availableModels: ['other-model'],
    }, null, 2));
    const p = center.saveProfile({ ...BASE });
    center.apply(p.id, ['workbuddy']);
    const out = JSON.parse(readFileSync(toolPaths.workbuddy, 'utf-8'));
    assert.equal(out.models.length, 2, '旧模型保留');
    const entry = out.models.find((m) => m.id === BASE.model);
    assert.ok(entry);
    assert.equal(entry.url, 'http://192.168.1.9:65002/v1/chat/completions');
    assert.equal(entry.apiKey, BASE.apiKey);
    assert.equal(entry.maxInputTokens, 1048576);
    assert.equal(entry.maxOutputTokens, 393216);
    assert.equal(entry.supportsToolCall, true);
    assert.equal(entry.supportsImages, false);
    assert.ok(out.availableModels.includes(BASE.model));
    assert.ok(out.availableModels.includes('other-model'));
  });

  it('apply→workbuddy：setDefault 时 availableModels 仅保留应用模型', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE, setDefault: true });
    center.apply(p.id, ['workbuddy']);
    const out = JSON.parse(readFileSync(toolPaths.workbuddy, 'utf-8'));
    assert.deepEqual(out.availableModels, [BASE.model]);
  });

  // ====== Codex CLI 适配器 ======

  it('apply→codex：写入 model/model_provider/[model_providers] 段 + auth.json 密钥，保留无关段落', () => {
    const { center, toolPaths } = ctx;
    mkdirSync(join(toolPaths.codex, '..'), { recursive: true });
    writeFileSync(toolPaths.codex, '[lsp]\nenabled = true\n');
    const p = center.saveProfile({ ...BASE });
    const r = center.apply(p.id, ['codex']);
    assert.equal(r.results[0].ok, true);
    const out = readFileSync(toolPaths.codex, 'utf-8');
    assert.ok(out.includes('[lsp]') && out.includes('enabled = true'), '无关段落保留');
    assert.ok(out.includes(`model = "${BASE.model}"`));
    assert.ok(out.includes(`model_provider = "${p.id}"`));
    assert.ok(out.includes(`[model_providers.${p.id}]`));
    assert.ok(out.includes(`name = "${BASE.name}"`));
    assert.ok(out.includes(`base_url = "${BASE.baseUrl}"`));
    assert.ok(out.includes('env_key = "OPENAI_API_KEY"'));
    assert.ok(out.includes('wire_api = "chat"'));
    const auth = JSON.parse(readFileSync(join(toolPaths.codex, '..', 'auth.json'), 'utf-8'));
    assert.equal(auth.OPENAI_API_KEY, BASE.apiKey);
  });

  it('apply→codex：baseUrl 末尾 /chat/completions 去除', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE, baseUrl: 'https://gw.example.com/v1/chat/completions' });
    center.apply(p.id, ['codex']);
    const out = readFileSync(toolPaths.codex, 'utf-8');
    assert.ok(out.includes('base_url = "https://gw.example.com/v1"'));
  });

  it('apply→codex：无明文 apiKey 时不写 auth.json（保留既有认证）', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE, apiKey: '', apiKeyEnv: 'CODE_KEY' });
    center.apply(p.id, ['codex']);
    assert.equal(existsSync(join(toolPaths.codex, '..', 'auth.json')), false, '不应创建 auth.json');
    const out = readFileSync(toolPaths.codex, 'utf-8');
    assert.ok(out.includes('env_key = "OPENAI_API_KEY"'));
  });

  it('revert codex 还原 config.toml 到应用前内容', () => {
    const { center, toolPaths } = ctx;
    mkdirSync(join(toolPaths.codex, '..'), { recursive: true });
    const original = '[lsp]\nenabled = true\n';
    writeFileSync(toolPaths.codex, original);
    const p = center.saveProfile({ ...BASE });
    center.apply(p.id, ['codex']);
    center.revert('codex');
    assert.equal(readFileSync(toolPaths.codex, 'utf-8'), original);
  });

  // ====== 备份 / 还原 ======

  it('apply 前自动备份，revert 还原到应用前内容', () => {
    const { center, toolPaths } = ctx;
    mkdirSync(join(toolPaths['claude-code'], '..'), { recursive: true });
    const original = JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-original' } }, null, 2);
    writeFileSync(toolPaths['claude-code'], original);
    const p = center.saveProfile({ ...BASE });
    center.apply(p.id, ['claude-code']);
    assert.ok(center.listBackups('claude-code').length >= 1);

    center.revert('claude-code');
    assert.deepEqual(JSON.parse(readFileSync(toolPaths['claude-code'], 'utf-8')), JSON.parse(original));
    // 无备份工具 → 报错
    assert.equal(center.revert('atomcode').ok, false);
  });

  it('apply 对不存在的工具返回失败结果而非抛错', () => {
    const { center } = ctx;
    const p = center.saveProfile({ ...BASE });
    const r = center.apply(p.id, ['no-such-tool']);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /不支持/);
    assert.throws(() => center.apply('missing', ['atomcode']), /不存在/);
  });

  // ====== 状态检测 ======

  it('listTools 能识别当前应用了哪个档案', () => {
    const { center, toolPaths } = ctx;
    const p = center.saveProfile({ ...BASE });
    center.apply(p.id, ['atomcode', 'claude-code', 'workbuddy', 'codex']);
    const tools = center.listTools();
    for (const t of tools) {
      assert.equal(t.exists, true, t.id + ' 配置文件应已生成');
      assert.equal(t.current.appliedProfileId, p.id, t.id + ' 应识别为已应用 ' + p.name);
      assert.equal(t.current.appliedName, p.name);
    }
  });

  it('listTools 对未配置工具返回 null/未应用状态', () => {
    const { center } = ctx;
    const tools = center.listTools();
    for (const t of tools) {
      assert.equal(t.exists, false);
      assert.equal(t.current, null);
    }
  });

  // ====== TOML 段落编辑工具 ======

  it('renderTomlUpserts 顶层键替换与新增', () => {
    const out = renderTomlUpserts('default_model = "old"\n[x]\ny = 1\n', [
      { topLevel: true, header: 'default_model', value: '"new"' },
      { header: 'z', text: 'w = 2' },
    ]);
    assert.ok(out.startsWith('default_model = "new"'));
    assert.ok(out.includes('[z]') && out.includes('w = 2'));
    assert.ok(out.includes('[x]') && out.includes('y = 1'));
  });
});
