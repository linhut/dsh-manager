// AI 生图功能回归测试（imagegen：provider 解析 + API Key 解析 + /images/generations 调用与本地保存）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshm-img-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(home, '.dsh');
  const imgDir = join(home, 'images');
  const prevImgDir = process.env.DSH_MANAGER_IMAGE_DIR;
  process.env.DSH_MANAGER_IMAGE_DIR = imgDir;
  try {
    await fn(home, imgDir);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    if (prevImgDir === undefined) delete process.env.DSH_MANAGER_IMAGE_DIR; else process.env.DSH_MANAGER_IMAGE_DIR = prevImgDir;
  }
}

describe('AI 生图（imagegen）', () => {
  it('findProviderConfig 解析 providerKey → baseURL/apiKeyEnv/models', async () => {
    const { findProviderConfig } = await import('../packages/core/src/imagegen.js');
    const settings = {
      'llm-pi-ai': { providers: { 'yang-newapi': { baseURL: 'http://192.168.1.9:65002/v1', apiKeyEnv: 'env:YANG_KEY', models: [{ id: 'glm-image' }] } } },
    };
    const found = findProviderConfig(settings, 'yang-newapi');
    assert.ok(found);
    assert.equal(found.baseURL, 'http://192.168.1.9:65002/v1');
    assert.equal(found.apiKeyEnv, 'YANG_KEY');
    assert.equal(found.adapter, 'pi-ai');
    assert.equal(found.models[0].id, 'glm-image');
    assert.equal(findProviderConfig(settings, 'nope'), null);
  });

  it('resolveApiKey 优先 credential 引用，回退环境变量', async () => {
    const { resolveApiKey } = await import('../packages/core/src/imagegen.js');
    assert.equal(resolveApiKey({ K1: 'sk-real' }, 'K1'), 'sk-real');
    process.env.K2_ENV = 'sk-env';
    try {
      assert.equal(resolveApiKey({}, 'K2_ENV'), 'sk-env');
    } finally { delete process.env.K2_ENV; }
    assert.equal(resolveApiKey({}, 'MISSING'), '');
  });

  it('generateImage 完整链路：调用 /images/generations 并保存 b64_json 到本地', async () => {
    await withHome(async (_home, imgDir) => {
      const { generateImage } = await import('../packages/core/src/imagegen.js');
      const fakeConfig = {
        async read() {
          return {
            settings: { 'llm-pi-ai': { providers: { 'yang-newapi': { baseURL: 'http://x/v1', apiKeyEnv: 'YANG_KEY', models: [{ id: 'glm-image' }] } } } },
            credentials: { YANG_KEY: 'sk-fake' },
          };
        },
      };
      let calledUrl = '';
      let calledBody = null;
      let calledAuth = '';
      const fakeFetch = async (url, opts) => {
        calledUrl = url;
        calledBody = JSON.parse(opts.body);
        calledAuth = opts.headers.Authorization;
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ data: [{ b64_json: Buffer.from('fake-png-bytes').toString('base64') }] }),
        };
      };
      const res = await generateImage({ providerKey: 'yang-newapi', model: 'glm-image', prompt: '一只猫', size: '1024x1024', deps: { config: fakeConfig, fetchImpl: fakeFetch } });
      assert.equal(calledUrl, 'http://x/v1/images/generations');
      assert.equal(calledBody.model, 'glm-image');
      assert.equal(calledBody.prompt, '一只猫');
      assert.equal(calledBody.response_format, 'b64_json');
      assert.equal(calledAuth, 'Bearer sk-fake');
      assert.ok(res.path.startsWith(imgDir));
      assert.ok(existsSync(res.path));
      assert.ok(readFileSync(res.path).equals(Buffer.from('fake-png-bytes')));
      assert.equal(res.size, '1024x1024');
    });
  });

  it('generateImage 上游 HTTP 错误 → UPSTREAM_ERROR', async () => {
    await withHome(async () => {
      const { generateImage } = await import('../packages/core/src/imagegen.js');
      const fakeConfig = {
        async read() {
          return {
            settings: { 'llm-pi-ai': { providers: { 'yang-newapi': { baseURL: 'http://x/v1', apiKeyEnv: 'YANG_KEY', models: [{ id: 'glm-image' }] } } } },
            credentials: { YANG_KEY: 'sk-fake' },
          };
        },
      };
      const fakeFail = async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'model not found' });
      await assert.rejects(
        generateImage({ providerKey: 'yang-newapi', model: 'bad', prompt: 'x', deps: { config: fakeConfig, fetchImpl: fakeFail } }),
        (e) => e.code === 'UPSTREAM_ERROR' && String(e.message).includes('400')
      );
    });
  });

  it('generateImage 参数校验：缺 provider/model/prompt 抛 INVALID_PARAMS', async () => {
    const { generateImage } = await import('../packages/core/src/imagegen.js');
    await assert.rejects(generateImage({}), (e) => e.code === 'INVALID_PARAMS');
    await assert.rejects(generateImage({ providerKey: 'p' }), (e) => e.code === 'INVALID_PARAMS');
    await assert.rejects(generateImage({ providerKey: 'p', model: 'm' }), (e) => e.code === 'INVALID_PARAMS');
  });

  it('generateImage Provider 未配置 → NOT_FOUND', async () => {
    await withHome(async () => {
      const { generateImage } = await import('../packages/core/src/imagegen.js');
      const fakeConfig = { async read() { return { settings: {}, credentials: {} }; } };
      await assert.rejects(
        generateImage({ providerKey: 'missing', model: 'm', prompt: 'x', deps: { config: fakeConfig } }),
        (e) => e.code === 'NOT_FOUND'
      );
    });
  });
});