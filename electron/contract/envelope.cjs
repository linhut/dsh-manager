/**
 * DSH Manager
 * IPC 统一响应信封
 *
 * 目标：让"业务失败"与"基础设施异常"在传输层可区分。
 *   ok   → { __envelope: true, ok: true, code: 'OK', data }
 *   fail → { __envelope: true, ok: false, code, message, detail }
 *
 * 兼容策略：只有显式接入信封的通道才返回该结构；其余通道保持原样。
 * preload 侧统一解包——成功返回 data、失败抛带 code 的 Error，
 * 因此渲染进程的调用方式与返回值形状零变化，可以逐域灰度。
 */
'use strict';

const CODE = Object.freeze({
  OK: 'OK',
  INVALID_ARGS: 'INVALID_ARGS',
  NOT_INSTALLED: 'NOT_INSTALLED',
  PORT_IN_USE: 'PORT_IN_USE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INTERNAL: 'INTERNAL',
});

const MARK = '__envelope';

function ok(data) {
  return { [MARK]: true, ok: true, code: CODE.OK, data };
}

function fail(code, message, detail) {
  const payload = { [MARK]: true, ok: false, code: code || CODE.INTERNAL, message: message || '' };
  if (detail !== undefined) payload.detail = detail;
  return payload;
}

function isEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value[MARK] === true);
}

/**
 * 把任意异常收敛为信封。
 * 携带已知 code 的异常按原码返回；其余归一为 INTERNAL，避免把内部堆栈直接抛给渲染端。
 */
function fromError(error) {
  if (error && typeof error === 'object' && CODE[error.code]) {
    return fail(error.code, error.message || String(error.code), error.detail);
  }
  return fail(CODE.INTERNAL, (error && error.message) || String(error));
}

/**
 * preload 侧解包：成功取 data，失败抛 Error（带 code/detail）。
 * 非信封结构原样返回，保证未接入通道的行为不变。
 */
function unwrap(value) {
  if (!isEnvelope(value)) return value;
  if (value.ok) return value.data;
  const error = new Error(value.message || value.code || 'IPC_ERROR');
  error.code = value.code;
  if (value.detail !== undefined) error.detail = value.detail;
  return Promise.reject(error);
}

module.exports = { CODE, MARK, ok, fail, isEnvelope, fromError, unwrap };

/**
 * 信封灰度范围：按通道前缀接入，先试点 app 域（系统/环境类，失败语义最需要分类）。
 * 新增域时只加前缀，主进程与 preload 无需改动。
 */
const ENVELOPE_PREFIXES = Object.freeze(['app:']);

function usesEnvelope(channel) {
  return ENVELOPE_PREFIXES.some((prefix) => String(channel).startsWith(prefix));
}

module.exports.ENVELOPE_PREFIXES = ENVELOPE_PREFIXES;
module.exports.usesEnvelope = usesEnvelope;
