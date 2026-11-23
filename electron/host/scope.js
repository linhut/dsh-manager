/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * HostScope —— 主进程副作用的所有权与释放
 *
 * 对应 DSH 0.2.x 规范的「生命周期 100% 可逆」：
 *   谁申请资源，谁登记 disposer；作用域释放时按注册逆序执行，
 *   异步 disposer 会被等待，重复释放幂等，子作用域随父释放。
 *
 * 只托管 Cordis/Electron 管不到的资源：定时器、监听器、子进程句柄、watcher。
 * ipcMain.handle 的注销同样通过 effect 登记。
 */

export function createScope(name = 'root') {
  const disposers = [];
  const children = new Set();
  let disposed = false;

  const scope = {
    get name() { return name; },
    get disposed() { return disposed; },

    /** 登记一个资源：fn 立即执行并返回 disposer（可为异步） */
    effect(fn) {
      if (disposed) throw new Error(`scope "${name}" 已释放，不能再登记资源`);
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },

    /** 创建子作用域：父释放时递归释放 */
    child(childName) {
      const child = createScope(`${name}/${childName}`);
      children.add(child);
      scope.effect(() => () => {
        children.delete(child);
        return child.dispose();
      });
      return child;
    },

    /**
     * 释放：先子后父、逆序、逐个 await。
     * 单个 disposer 失败不阻断其余资源回收，最终以 AggregateError 汇总。
     */
    async dispose() {
      if (disposed) return;
      disposed = true;

      const errors = [];
      for (const child of [...children]) {
        try { await child.dispose(); } catch (err) { errors.push(err); }
      }
      children.clear();

      for (const disposer of disposers.reverse()) {
        try { await disposer(); } catch (err) { errors.push(err); }
      }
      disposers.length = 0;

      if (errors.length > 0) {
        throw new AggregateError(errors, `scope "${name}" 释放时出现 ${errors.length} 个错误`);
      }
    },
  };

  return scope;
}
