/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * 统一响应信封回归测试（P0-3 灰度试点）
 * 断言的是渲染进程实际感知的行为：成功拿 data、失败抛带 code 的 Error、未接入通道零变化。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CODE, ok, fail, isEnvelope, fromError, unwrap, usesEnvelope, ENVELOPE_PREFIXES } =
  require('../electron/contract/envelope.cjs');

describe('信封结构', () => {
  it('成功信封携带 data 与 OK', () => {
    const res = ok({ version: '2.0.7' });
    assert.equal(isEnvelope(res), true);
    assert.equal(res.ok, true);
    assert.equal(res.code, CODE.OK);
    assert.deepEqual(res.data, { version: '2.0.7' });
  });

  it('失败信封保留 code / message / detail', () => {
    const res = fail(CODE.PORT_IN_USE, '端口被占用', { port: 3080 });
    assert.equal(res.ok, false);
    assert.equal(res.code, CODE.PORT_IN_USE);
    assert.equal(res.message, '端口被占用');
    assert.deepEqual(res.detail, { port: 3080 });
  });

  it('普通对象不会被误判为信封', () => {
    assert.equal(isEnvelope({ ok: true, data: 1 }), false);
    assert.equal(isEnvelope(null), false);
    assert.equal(isEnvelope('x'), false);
    assert.equal(isEnvelope([{ __envelope: true }]), false);
  });
});

describe('异常收敛', () => {
  it('已知错误码按原码返回', () => {
    const err = new Error('依赖缺失');
    err.code = 'DEPENDENCY_MISSING';
    const res = fromError(err);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'DEPENDENCY_MISSING');
  });

  it('未知异常归一为 INTERNAL，且不外泄堆栈', () => {
    const err = new Error('boom');
    err.stack = 'SECRET_STACK';
    const res = fromError(err);
    assert.equal(res.code, CODE.INTERNAL);
    assert.equal(res.message, 'boom');
    assert.equal(JSON.stringify(res).includes('SECRET_STACK'), false);
  });

  it('非 Error 输入也能收敛', () => {
    assert.equal(fromError('plain').message, 'plain');
    assert.equal(fromError(null).code, CODE.INTERNAL);
  });
});

describe('preload 解包语义', () => {
  it('成功信封解出 data', async () => {
    await assert.doesNotReject(async () => {
      const value = await unwrap(ok(42));
      assert.equal(value, 42);
    });
  });

  it('失败信封抛出带 code 的 Error', async () => {
    await assert.rejects(
      async () => unwrap(fail(CODE.NOT_INSTALLED, 'DSH 未安装')),
      (err) => {
        assert.equal(err instanceof Error, true);
        assert.equal(err.code, CODE.NOT_INSTALLED);
        assert.equal(err.message, 'DSH 未安装');
        return true;
      }
    );
  });

  it('未接入通道原样返回（向后兼容）', async () => {
    const legacy = { success: true, version: '1.0.0' };
    assert.deepEqual(await unwrap(legacy), legacy);
    assert.equal(await unwrap(undefined), undefined);
    assert.equal(await unwrap(null), null);
  });
});

describe('灰度范围', () => {
  it('app 域接入信封', () => {
    assert.equal(usesEnvelope('app:get-version'), true);
    assert.equal(usesEnvelope('app:check-env'), true);
    assert.equal(usesEnvelope('app:install-nodejs-portable'), true);
  });

  it('未试点域保持原样', () => {
    assert.equal(usesEnvelope('dsh:get-info'), false);
    assert.equal(usesEnvelope('marketplace:search'), false);
    assert.equal(usesEnvelope(''), false);
  });

  it('前缀表可扩展且只按前缀匹配', () => {
    assert.ok(ENVELOPE_PREFIXES.includes('app:'));
    assert.equal(usesEnvelope('application:foo'), false);
  });
});
