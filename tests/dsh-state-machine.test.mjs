/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * DSH 状态机回归测试
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DSH_STATE, createDSHStateMachine } from '../packages/core/src/dsh-state-machine.js';

describe('正常状态流转', () => {
  it('冷启动：IDLE → CHECKING → STARTING → READY', () => {
    const m = createDSHStateMachine();
    assert.equal(m.state, DSH_STATE.IDLE);

    assert.equal(m.send('START').state, DSH_STATE.CHECKING);
    assert.equal(m.send('PROCEED').state, DSH_STATE.STARTING);
    assert.equal(m.send('READY').state, DSH_STATE.READY);
    assert.equal(m.snapshot().ready, true);
  });

  it('停止：READY → STOPPING → IDLE', () => {
    const m = createDSHStateMachine();
    m.send('START'); m.send('PROCEED'); m.send('READY');

    assert.equal(m.send('STOP').state, DSH_STATE.STOPPING);
    assert.equal(m.snapshot().busy, true);
    assert.equal(m.send('STOPPED').state, DSH_STATE.IDLE);
    assert.equal(m.snapshot().ready, false);
  });

  it('失败后重试：FAILED → START', () => {
    const m = createDSHStateMachine();
    m.send('START');
    m.send('FAIL', { message: '端口被占用' });
    assert.equal(m.state, DSH_STATE.FAILED);

    // 重试会清空 lastError，但历史仍保留
    const retry = m.send('START');
    assert.equal(retry.ok, true);
    assert.equal(m.state, DSH_STATE.CHECKING);
    assert.equal(m.lastError, null);
  });
});

describe('非法转换必须被拒绝', () => {
  it('IDLE 不能直接进入 READY', () => {
    const m = createDSHStateMachine();
    const res = m.send('READY');
    assert.equal(res.ok, false);
    assert.equal(m.state, DSH_STATE.IDLE);
    assert.match(res.reason, /不接受事件/);
  });

  it('READY 不能重复 START', () => {
    const m = createDSHStateMachine();
    m.send('START'); m.send('PROCEED'); m.send('READY');

    const res = m.send('START');
    assert.equal(res.ok, false);
    assert.equal(m.state, DSH_STATE.READY);
  });

  it('未知事件不会改变状态', () => {
    const m = createDSHStateMachine();
    const res = m.send('NOPE');
    assert.equal(res.ok, false);
    assert.equal(m.state, DSH_STATE.IDLE);
  });

  it('can() 与 send() 结论一致', () => {
    const m = createDSHStateMachine();
    assert.equal(m.can('START'), true);
    assert.equal(m.can('READY'), false);
    m.send('START');
    assert.equal(m.can('PROCEED'), true);
    assert.equal(m.can('START'), false);
  });
});

describe('失败信息与观测', () => {
  it('失败保留错误来源与状态', () => {
    const m = createDSHStateMachine();
    m.send('START');
    m.send('PROCEED');
    m.send('FAIL', { message: 'DSH 未安装', detail: { code: 'NOT_INSTALLED' } });

    const err = m.lastError;
    assert.equal(err.message, 'DSH 未安装');
    assert.equal(err.from, DSH_STATE.STARTING);
    assert.deepEqual(err.detail, { code: 'NOT_INSTALLED' });
    assert.equal(m.snapshot().ready, false);
  });

  it('缺失错误消息时给出兜底文案', () => {
    const m = createDSHStateMachine();
    m.send('START');
    m.send('FAIL');
    assert.equal(m.lastError.message, '未知错误');
  });

  it('onChange 收到前后状态与事件', () => {
    const seen = [];
    const m = createDSHStateMachine({ onChange: (t) => seen.push(`${t.previous}->${t.state}:${t.event}`) });
    m.send('START');
    m.send('PROCEED');

    assert.deepEqual(seen, ['IDLE->CHECKING:START', 'CHECKING->STARTING:PROCEED']);
  });

  it('观察者抛错不影响状态推进', () => {
    const m = createDSHStateMachine({ onChange: () => { throw new Error('observer boom'); } });
    assert.doesNotThrow(() => m.send('START'));
    assert.equal(m.state, DSH_STATE.CHECKING);
  });

  it('快照 history 只保留最近记录', () => {
    let t = 0;
    const m = createDSHStateMachine({ now: () => ++t });
    for (let i = 0; i < 30; i++) {
      m.send('START'); m.send('STOP'); m.send('STOPPED');
    }
    const snap = m.snapshot();
    assert.ok(snap.history.length <= 10);
    assert.equal(snap.state, DSH_STATE.IDLE);
  });

  it('busy 只覆盖进行中的三个状态', () => {
    const m = createDSHStateMachine();
    assert.equal(m.snapshot().busy, false);
    m.send('START');
    assert.equal(m.snapshot().busy, true);
    m.send('FAIL');
    assert.equal(m.snapshot().busy, false);
  });
});

// 以下用例复刻 electron/ipc-handlers.js 中四个真实入口的事件顺序。
// 目的：一旦状态机表被改动（例如给 READY 加上 PROCEED），这里会先失败，
// 而不是等到界面上出现「停止后仍显示启动中」才发现。
describe('真实入口的事件序列', () => {
  // IPC 层的 beginStop()：IDLE 时跳过自环
  const beginStop = (m) => { if (m.state !== DSH_STATE.IDLE) m.send('STOP'); };
  // IPC 层的 settleStopped()：只在 STOPPING 收口
  const settleStopped = (m) => { if (m.state === DSH_STATE.STOPPING) m.send('STOPPED'); };

  it('dsh:start 冷启动全序列无拒绝', () => {
    const parts = [];
    const m = createDSHStateMachine({ onChange: (t) => parts.push(t.state) });

    assert.equal(m.send('START').ok, true);
    assert.equal(m.send('PROCEED').ok, true);
    assert.equal(m.send('READY').ok, true);

    assert.deepEqual(parts, ['CHECKING', 'STARTING', 'READY']);
  });

  it('dsh:start 命中「已有实例在跑」时直接 READY', () => {
    const m = createDSHStateMachine();
    m.send('START');
    // 复用之路上层没启动新进程，CHECKING 直接跳 READY（不经过 STARTING）
    assert.equal(m.send('READY').ok, true);
    assert.equal(m.state, DSH_STATE.READY);
  });

  it('dsh:start 健康检查不通过时留 FAILED 与错误', () => {
    const m = createDSHStateMachine();
    m.send('START');
    m.send('PROCEED');
    m.send('FAIL', { message: '启动后 10 秒内健康检查未通过' });

    assert.equal(m.state, DSH_STATE.FAILED);
    assert.equal(m.snapshot().ready, false);
    assert.match(m.lastError.message, /健康检查/);
  });

  it('dsh:restart 从 READY 出发：STOP → STOPPED → START → PROCEED → READY', () => {
    const m = createDSHStateMachine();
    m.send('START'); m.send('PROCEED'); m.send('READY');

    beginStop(m);
    assert.equal(m.state, DSH_STATE.STOPPING);
    settleStopped(m);
    assert.equal(m.state, DSH_STATE.IDLE);
    assert.equal(m.send('START').ok, true);
    assert.equal(m.send('PROCEED').ok, true);
    assert.equal(m.send('READY').ok, true);
    assert.equal(m.state, DSH_STATE.READY);
  });

  it('dsh:stop 在 IDLE 上重复调用不会污染状态', () => {
    const m = createDSHStateMachine();
    const before = m.snapshot().history.length;

    beginStop(m); // IDLE → 跳过
    settleStopped(m); // 非 STOPPING → 跳过

    assert.equal(m.state, DSH_STATE.IDLE);
    assert.equal(m.snapshot().history.length, before);
  });

  it('dsh:stop 失败时停在 FAILED 而不是假装已停', () => {
    const m = createDSHStateMachine();
    m.send('START'); m.send('PROCEED'); m.send('READY');

    beginStop(m);
    m.send('FAIL', { message: '停止失败: 端口仍被占用' });

    assert.equal(m.state, DSH_STATE.FAILED);
    assert.equal(m.snapshot().ready, false);
  });

  it('dsh:fix-and-restart 从 FAILED 出发可完成闭环', () => {
    const m = createDSHStateMachine();
    m.send('START');
    m.send('FAIL', { message: '缺少模块 shiki' });

    beginStop(m);
    settleStopped(m);
    m.send('START');
    m.send('PROCEED');
    settleStopped(m); // 非 STOPPING，无副作用
    m.send('READY');

    assert.equal(m.state, DSH_STATE.READY);
    assert.equal(m.lastError, null);
  });

  it('自愈重启：FAILED → START → PROCEED → READY', () => {
    const m = createDSHStateMachine();
    m.send('START'); m.send('PROCEED'); m.send('FAIL', { message: 'boom' });

    assert.equal(m.send('START').ok, true);
    assert.equal(m.send('PROCEED').ok, true);
    assert.equal(m.send('READY').ok, true);
    assert.equal(m.snapshot().ready, true);
  });
});

