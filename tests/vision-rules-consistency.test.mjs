/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// 视觉模型识别回归（行为测试）
//
// 历史背景：此测试原本对比 config.js 与 app.js 两份 VISION_MODEL_NAME_RULES 常量，
// 防止双实现漂移。现渲染层已不再重复实现该规则，识别统一走 DSHConfig.isVisionModelName，
// 双实现前提消失，因此改为直接断言判定行为——它才是下游真正依赖的契约
// （模型 input 是否补 image、能力路由是否标 vision，都以此为准）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DSHConfig } from '../packages/core/src/config.js';

const POSITIVES = [
  'gpt-4o', 'gpt-4o-mini', 'glm-4v', 'glm-5v', 'qwen2.5-vl', 'claude-sonnet-vision',
  'gemini-2.5-pro', 'gemini-flash', 'vision-model', 'minicpm-v', 'internvl2-8b',
  'llava-1.6', 'omni-model', 'vl-anything',
];

const NEGATIVES = [
  'deepseek-v4-flash', 'deepseek-chat', 'gpt-4', 'qwen2.5', 'llama3-8b',
  'claude-opus-4', 'glm-4', 'mistral-large', 'v4-flash', '',
];

describe('视觉模型识别', () => {
  it('视觉模型全部命中', () => {
    for (const id of POSITIVES) {
      assert.equal(DSHConfig.isVisionModelName(id), true, `应识别为视觉模型: ${id}`);
    }
  });

  it('纯文本模型不误判', () => {
    for (const id of NEGATIVES) {
      assert.equal(DSHConfig.isVisionModelName(id), false, `不应误判为视觉模型: ${id}`);
    }
  });

  it('大小写与空值安全', () => {
    assert.equal(DSHConfig.isVisionModelName('GPT-4O'), true);
    assert.equal(DSHConfig.isVisionModelName('GLM-5V'), true);
    assert.equal(DSHConfig.isVisionModelName(null), false);
    assert.equal(DSHConfig.isVisionModelName(undefined), false);
    assert.equal(DSHConfig.isVisionModelName(0), false);
    assert.equal(DSHConfig.isVisionModelName({}), false);
  });

  it('视觉模型在能力识别中标记 vision', () => {
    assert.ok(DSHConfig.detectModelCapabilities('qwen2.5-vl').includes('vision'));
    assert.ok(!DSHConfig.detectModelCapabilities('deepseek-chat').includes('vision'));
  });
});
