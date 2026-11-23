/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * 单飞（single-flight）：同一操作并发触发时只执行一次，其余调用复用同一结果。
 *
 * 用于 DSH 启动这类"有副作用、不可并行"的动作：
 * 两次点击如果在端口尚未被占用前各自 spawn，就会双开实例并随机换端口。
 * 失败后锁必须释放，否则一次失败会把后续重试永久挡在门外。
 */
export function createSingleFlight(fn, onJoin) {
  let inFlight = null;

  return function run(...args) {
    if (inFlight) {
      if (typeof onJoin === 'function') onJoin();
      return inFlight;
    }

    // 用 Promise.resolve().then 包一层：即使 fn 同步抛错也会变成 rejection，
    // 不会在 inFlight 赋值前逃逸出锁。
    inFlight = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => { inFlight = null; });

    return inFlight;
  };
}
