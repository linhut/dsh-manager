/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * HostScope 回归测试
 * 覆盖规范要求的三件事：卸载后不残留、异步清理被等待、重复释放幂等。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createScope } from '../electron/host/scope.js';

describe('资源登记与释放', () => {
  it('按注册逆序释放', async () => {
    const order = [];
    const scope = createScope('root');
    scope.effect(() => () => order.push('first'));
    scope.effect(() => () => order.push('second'));
    scope.effect(() => () => order.push('third'));

    await scope.dispose();
    assert.deepEqual(order, ['third', 'second', 'first']);
  });

  it('异步 disposer 会被等待', async () => {
    const scope = createScope('async');
    let cleaned = false;
    scope.effect(() => async () => {
      await delay(20);
      cleaned = true;
    });

    await scope.dispose();
    assert.equal(cleaned, true);
  });

  it('定时器在释放后不再触发', async () => {
    const scope = createScope('timer');
    let ticks = 0;
    scope.effect(() => {
      const timer = setInterval(() => { ticks += 1; }, 10);
      return () => clearInterval(timer);
    });

    await delay(35);
    const before = ticks;
    assert.ok(before > 0, '释放前应已触发');

    await scope.dispose();
    await delay(40);
    assert.equal(ticks, before, '释放后不应再触发');
  });

  it('非函数返回值被忽略，不视为 disposer', async () => {
    const scope = createScope('noop');
    assert.doesNotThrow(() => scope.effect(() => undefined));
    assert.doesNotThrow(() => scope.effect(() => 42));
    await scope.dispose();
  });
});

describe('作用域层级', () => {
  it('父释放会递归释放子作用域', async () => {
    const order = [];
    const parent = createScope('parent');
    const child = parent.child('child');
    parent.effect(() => () => order.push('parent'));
    child.effect(() => () => order.push('child'));

    await parent.dispose();
    assert.deepEqual(order, ['child', 'parent']);
    assert.equal(child.disposed, true);
  });

  it('子作用域单独释放不影响父作用域', async () => {
    const parent = createScope('parent');
    const child = parent.child('child');
    let parentCleaned = false;
    parent.effect(() => () => { parentCleaned = true; });

    await child.dispose();
    assert.equal(parent.disposed, false);
    assert.equal(parentCleaned, false);

    await parent.dispose();
    assert.equal(parentCleaned, true);
  });
});

describe('幂等与失败隔离', () => {
  it('重复释放不会二次执行 disposer', async () => {
    let count = 0;
    const scope = createScope('idem');
    scope.effect(() => () => { count += 1; });

    await scope.dispose();
    await scope.dispose();
    await scope.dispose();
    assert.equal(count, 1);
  });

  it('单个 disposer 抛错不阻断其余资源回收', async () => {
    const cleaned = [];
    const scope = createScope('partial');
    scope.effect(() => () => { cleaned.push('a'); });
    scope.effect(() => () => { throw new Error('b failed'); });
    scope.effect(() => () => { cleaned.push('c'); });

    await assert.rejects(() => scope.dispose(), (err) => {
      assert.equal(err instanceof AggregateError, true);
      assert.equal(err.errors.length, 1);
      return true;
    });
    // 逆序：c → b(失败) → a
    assert.deepEqual(cleaned, ['c', 'a']);
  });

  it('释放后禁止再登记资源', async () => {
    const scope = createScope('closed');
    await scope.dispose();
    assert.throws(() => scope.effect(() => () => {}), /已释放/);
  });
});
