/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * 单飞锁回归测试：重点是"并发只跑一次"和"失败后必须解锁"。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createSingleFlight } from '../electron/host/single-flight.js';

describe('单飞锁', () => {
  it('并发调用只执行一次，结果共享', async () => {
    let calls = 0;
    const run = createSingleFlight(async () => {
      calls += 1;
      await delay(20);
      return { ok: true, n: calls };
    });

    const [a, b, c] = await Promise.all([run(), run(), run()]);
    assert.equal(calls, 1, '底层只应执行一次');
    assert.deepEqual(a, { ok: true, n: 1 });
    assert.equal(b, a);
    assert.equal(c, a);
  });

  it('完成后再次调用会重新执行', async () => {
    let calls = 0;
    const run = createSingleFlight(async () => { calls += 1; return calls; });

    assert.equal(await run(), 1);
    assert.equal(await run(), 2);
    assert.equal(calls, 2);
  });

  it('失败会传播给所有并发等待者，且锁被释放', async () => {
    let calls = 0;
    const run = createSingleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first fails');
      return 'second ok';
    });

    const results = await Promise.allSettled([run(), run()]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[0].reason.message, 'first fails');

    // 关键：失败后必须能重试
    assert.equal(await run(), 'second ok');
    assert.equal(calls, 2);
  });

  it('参数透传给底层实现', async () => {
    const run = createSingleFlight(async (a, b) => a + b);
    assert.equal(await run(2, 3), 5);
  });

  it('并发合流时触发 onJoin 回调', async () => {
    let joined = 0;
    const run = createSingleFlight(async () => { await delay(10); return 1; }, () => { joined += 1; });

    await Promise.all([run(), run(), run()]);
    assert.equal(joined, 2, '除首个外的 2 次调用应被合并');
  });

  it('底层同步抛错也不会卡住锁', async () => {
    let calls = 0;
    const run = createSingleFlight(() => {
      calls += 1;
      if (calls === 1) throw new Error('sync boom');
      return 'recovered';
    });

    await assert.rejects(() => run(), /sync boom/);
    assert.equal(await run(), 'recovered');
  });
});
