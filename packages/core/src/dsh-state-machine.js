/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * DSH 运行时状态机
 *
 * 目的：把"是否在启动/是否可用/上一次为什么失败"从散落的布尔值收敛为单一事实来源。
 * 约束（对齐 DSH 0.2.x 的防御性模式）：
 *   1. 非法转换必须被拒绝，不能靠调用方自觉；
 *   2. 失败保留 lastError，重试时不清空历史；
 *   3. 只有 READY 才代表"健康检查通过"，进程存在不等于可用。
 *
 * 纯模块、无 Electron / 无 I/O，可直接被 node:test 覆盖。
 */

export const DSH_STATE = Object.freeze({
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  STARTING: 'STARTING',
  READY: 'READY',
  STOPPING: 'STOPPING',
  FAILED: 'FAILED',
});

const TRANSITIONS = Object.freeze({
  IDLE: { START: 'CHECKING', STOP: 'IDLE' },
  CHECKING: { PROCEED: 'STARTING', READY: 'READY', FAIL: 'FAILED', STOP: 'STOPPING' },
  STARTING: { READY: 'READY', FAIL: 'FAILED', STOP: 'STOPPING' },
  READY: { STOP: 'STOPPING', FAIL: 'FAILED' },
  STOPPING: { STOPPED: 'IDLE', FAIL: 'FAILED' },
  FAILED: { START: 'CHECKING', RESET: 'IDLE', STOP: 'STOPPING' },
});

const TERMINAL_FAILURE = 'FAILED';

export function createDSHStateMachine(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let state = DSH_STATE.IDLE;
  let lastError = null;
  let since = now();
  let history = [{ state, at: since, event: 'INIT' }];

  function can(event) {
    const table = TRANSITIONS[state];
    return Boolean(table && table[event]);
  }

  function send(event, payload) {
    const table = TRANSITIONS[state];
    const next = table && table[event];
    if (!next) {
      return {
        ok: false,
        state,
        reason: `状态 ${state} 不接受事件 ${event}`,
      };
    }

    const previous = state;
    state = next;
    since = now();

    if (state === TERMINAL_FAILURE) {
      lastError = {
        message: (payload && (payload.message || payload.error)) || '未知错误',
        detail: payload && payload.detail ? payload.detail : undefined,
        from: previous,
        at: since,
      };
    }
    if (event === 'START' || event === 'RESET') {
      lastError = null;
    }

    history.push({ state, at: since, event });
    if (history.length > 40) history = history.slice(-40);

    if (onChange) {
      try {
        onChange({ previous, state, event, payload, lastError });
      } catch {
        // 观察者异常不得影响状态推进
      }
    }

    return { ok: true, previous, state };
  }

  return {
    get state() { return state; },
    get lastError() { return lastError; },
    can,
    send,
    /** 供 IPC 直接返回的快照：渲染进程据此渲染状态，不再自行拼凑布尔值 */
    snapshot() {
      return {
        state,
        ready: state === DSH_STATE.READY,
        busy: state === DSH_STATE.CHECKING || state === DSH_STATE.STARTING || state === DSH_STATE.STOPPING,
        since,
        lastError,
        history: history.slice(-10),
      };
    },
  };
}
