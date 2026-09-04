/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// LLM 能力路由回归测试（manager.llm-routing + agent-default-model 应用）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshm-routing-'));
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
    'agent-default-model:',
    '  provider: modlens-yang-newapi',
    '  model: deepseek-v4-flash',
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

describe('LLM 能力路由', () => {
  it('listCapabilityModels 收集真实 providers 模型（路由id=providerKey）', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      const models = await cfg.listCapabilityModels();
      assert.equal(models.length, 2);
      assert.equal(models[0].provider, 'pi-ai');
      assert.equal(models[0].providerKey, 'yang-newapi');
      assert.equal(models[0].model, 'deepseek-v4-flash');
    });
  });

  it('saveLLMRouting/getLLMRouting 读写 manager.llm-routing', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      await cfg.saveLLMRouting({ enabled: true, defaultCapability: 'semantic', capabilities: {
        semantic: { provider: 'yang-newapi', model: 'deepseek-v4-flash' },
        vision: { provider: 'yang-newapi', model: 'glm-5v-turbo' },
      }});
      const routing = await cfg.getLLMRouting();
      assert.equal(routing.enabled, true);
      assert.equal(routing.defaultCapability, 'semantic');
      assert.equal(routing.capabilities.vision.model, 'glm-5v-turbo');
      // 无效项被过滤
      await cfg.saveLLMRouting({ enabled: false, capabilities: { bad: { provider: '', model: 'x' } } });
      const r2 = await cfg.getLLMRouting();
      assert.equal(r2.enabled, false);
      assert.ok(!r2.capabilities.bad);
    });
  });

  it('applyDefaultModel 写入 agent-default-model（DSH 原生读取）', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      await cfg.saveLLMRouting({ capabilities: {
        vision: { provider: 'yang-newapi', model: 'glm-5v-turbo' },
      }});
      const applied = await cfg.applyDefaultModel('vision');
      assert.equal(applied.provider, 'yang-newapi');
      assert.equal(applied.model, 'glm-5v-turbo');
      const { settings } = await cfg.read();
      assert.deepEqual(settings['agent-default-model'], { provider: 'yang-newapi', model: 'glm-5v-turbo' });
    });
  });

  it('applyDefaultModel 拒绝不存在的路由/模型', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      await cfg.saveLLMRouting({ capabilities: {
        image: { provider: 'nope', model: 'x' },
      }});
      await assert.rejects(() => cfg.applyDefaultModel('image'), /不存在/);
    });
  });

  it('resolveCapability 解析真实 apiKeyEnv/baseURL', async () => {
    await withHome(async () => {
      const { DSHConfig } = await import('../packages/core/src/config.js');
      const cfg = new DSHConfig();
      await cfg.saveLLMRouting({ defaultCapability: 'semantic', capabilities: {
        semantic: { provider: 'yang-newapi', model: 'deepseek-v4-flash' },
      }});
      const resolved = await cfg.resolveCapability('semantic');
      assert.equal(resolved.provider, 'yang-newapi');
      assert.equal(resolved.model, 'deepseek-v4-flash');
      assert.equal(resolved.apiKeyEnv, 'YANG_NEWAPI_API_KEY');
      assert.match(resolved.baseURL, /65002/);
    });
  });
});