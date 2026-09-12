import test from 'node:test';
import assert from 'node:assert/strict';
import { DSHConfig } from '../packages/core/src/config.js';

// ====== 模型能力类型识别（detectModelCapabilities） ======

test('detectModelCapabilities：视觉模型名识别（gpt-4o）', () => {
  const caps = DSHConfig.detectModelCapabilities('gpt-4o');
  assert.ok(caps.includes('semantic'), '语义恒有');
  assert.ok(caps.includes('vision'), 'gpt-4o 应识别为识图');
});

test('detectModelCapabilities：纯文本模型仅语义（deepseek-chat）', () => {
  assert.deepEqual(DSHConfig.detectModelCapabilities('deepseek-chat'), ['semantic']);
});

test('detectModelCapabilities：API 元数据优先（input_types 含 audio → 多模态）', () => {
  const caps = DSHConfig.detectModelCapabilities('gpt-4o', { input_types: ['text', 'image', 'audio'] });
  assert.ok(caps.includes('vision'));
  assert.ok(caps.includes('multimodal'), 'audio 输入应识别为多模态');
});

test('detectModelCapabilities：capabilities 字段透传（code）', () => {
  const caps = DSHConfig.detectModelCapabilities('gpt-4o', { capabilities: ['code'] });
  assert.ok(caps.includes('code'));
});

test('detectModelCapabilities：嵌入模型识别（text-embedding-ada-002）', () => {
  const caps = DSHConfig.detectModelCapabilities('text-embedding-ada-002');
  assert.ok(caps.includes('embedding'));
});

test('detectModelCapabilities：deepseek-v4-flash 不误判视觉（v4 是版本号）', () => {
  assert.deepEqual(DSHConfig.detectModelCapabilities('deepseek-v4-flash'), ['semantic']);
});

test('detectModelCapabilities：代码/生图命名启发式', () => {
  assert.ok(DSHConfig.detectModelCapabilities('deepseek-coder').includes('code'));
  assert.ok(DSHConfig.detectModelCapabilities('dall-e-3').includes('image'));
});

// ====== 知名模型规格查询（lookupModelSpec） ======

test('lookupModelSpec：精确匹配（deepseek-v4-flash 1M/384K）', () => {
  assert.deepEqual(DSHConfig.lookupModelSpec('deepseek-v4-flash'), { contextWindow: 1048576, maxTokens: 393216 });
});

test('lookupModelSpec：长前缀匹配（gpt-4o-2024-05-13）', () => {
  assert.equal(DSHConfig.lookupModelSpec('gpt-4o-2024-05-13').contextWindow, 128000);
});

test('lookupModelSpec：精确 id 优先于前缀（gpt-4o-mini 不落 gpt-4o）', () => {
  assert.equal(DSHConfig.lookupModelSpec('gpt-4o-mini').contextWindow, 128000);
});

test('lookupModelSpec：未收录返回 null', () => {
  assert.equal(DSHConfig.lookupModelSpec('unknown-model-xyz'), null);
  assert.equal(DSHConfig.lookupModelSpec(''), null);
  assert.equal(DSHConfig.lookupModelSpec(null), null);
});
