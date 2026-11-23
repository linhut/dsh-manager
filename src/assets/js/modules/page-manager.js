/**
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * DSH Manager - Page Manager
 * Manages page lifecycle, lazy loading, and navigation
 *
 * 页面契约（对齐 DSH 0.2.x「副作用 100% 可逆」的宿主侧纪律）：
 *
 *   register(id, {
 *     render(params, ctx)   // 进入/刷新时渲染内容（可 async）
 *     mount(params, ctx)    // 可选：首次挂载后的一次性初始化
 *     unmount(ctx)          // 可选：离开页面时释放资源（可 async）
 *     onActivate(params, ctx) // 可选：每次激活都执行
 *   })
 *
 * ctx 提供受管的资源登记口，页面不必自己记定时器：
 *   ctx.disposer(fn)          登记任意清理函数
 *   ctx.on(target, ev, fn)    监听并在离开时自动解绑
 *   ctx.interval(fn, ms)      定时器并在离开时自动 clear
 *   ctx.timeout(fn, ms)       延时器并在离开时自动 clear
 *
 * 切换顺序固定为：上一页 unmount() → 释放该页登记的资源（逆序、幂等、失败隔离）
 * → 新页 render()。这样"切页面"本身就是一次资源回收验收。
 *
 * 说明：本文件仍以传统 <script> 方式加载（渲染层 ESM 化在 P1-3b 单独进行），
 * 因此不写 export；单元测试通过 new Function 加载真实源码执行。
 */
'use strict';

class PageManager {
  constructor() {
    this._pages = new Map();
    this._currentPage = null;
    this._previousPage = null;
    this._loaded = new Set();
    /** @type {Map<string, Function[]>} 页面 id → 待释放的清理函数 */
    this._disposers = new Map();
  }

  /**
   * Register a page
   * @param {string} id - Page ID (matches the page div id)
   * @param {object} page - { render?, mount?, unmount?, onActivate? }
   */
  register(id, page) {
    if (!id || typeof id !== 'string') {
      throw new TypeError('页面 id 必须是非空字符串');
    }
    if (!page || typeof page !== 'object') {
      throw new TypeError('页面 ' + id + ' 必须是对象');
    }
    for (const key of ['render', 'mount', 'unmount', 'onActivate']) {
      if (page[key] !== undefined && typeof page[key] !== 'function') {
        throw new TypeError('页面 ' + id + ' 的 ' + key + ' 必须是函数');
      }
    }
    this._pages.set(id, { page });
  }

  /**
   * 为页面登记清理函数；返回反注册函数（重复调用安全）
   * @param {string} id
   * @param {Function} fn
   * @returns {Function} 反注册
   */
  addDisposer(id, fn) {
    if (typeof fn !== 'function') throw new TypeError('disposer 必须是函数');
    const list = this._disposers.get(id) || [];
    list.push(fn);
    this._disposers.set(id, list);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this._disposers.get(id);
      if (!current) return;
      const idx = current.indexOf(fn);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /**
   * 构造页面上下文（资源登记口）
   * @param {string} id
   */
  _context(id) {
    const self = this;
    return {
      id,
      disposer(fn) {
        return self.addDisposer(id, fn);
      },
      on(target, event, handler, options) {
        if (!target || typeof target.addEventListener !== 'function') {
          throw new TypeError('ctx.on 需要 EventTarget');
        }
        target.addEventListener(event, handler, options);
        return self.addDisposer(id, () => target.removeEventListener(event, handler, options));
      },
      interval(fn, ms) {
        const timer = setInterval(fn, ms);
        self.addDisposer(id, () => clearInterval(timer));
        return timer;
      },
      timeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        self.addDisposer(id, () => clearTimeout(timer));
        return timer;
      },
    };
  }

  /**
   * 释放某页登记的全部资源：逆序执行、逐个隔离、执行后清空（幂等）
   * @param {string} id
   * @returns {{disposed: number, failed: number}}
   */
  disposePage(id) {
    const list = this._disposers.get(id);
    if (!list || list.length === 0) {
      this._disposers.delete(id);
      return { disposed: 0, failed: 0 };
    }
    // 先摘除再执行：清理函数内部若再次登记，不会被本次循环消费，也不会重复执行
    this._disposers.delete(id);
    let disposed = 0;
    let failed = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        list[i]();
        disposed++;
      } catch (e) {
        failed++;
        console.error('[page-manager] 释放资源失败 (' + id + '):', e);
      }
    }
    return { disposed, failed };
  }

  /**
   * 离开某页：先 unmount()，再释放资源
   * @param {string} id
   */
  async _leave(id) {
    const entry = this._pages.get(id);
    if (!entry) return { unmountError: null };
    const ctx = this._context(id);
    let unmountError = null;
    if (entry.page.unmount) {
      try {
        await entry.page.unmount(ctx);
      } catch (e) {
        unmountError = e;
        console.error('Page unmount error:', id, e);
      }
    }
    this.disposePage(id);
    return { unmountError };
  }

  /**
   * Navigate to a page
   * @param {string} id - Page ID
   * @param {object} [params] - Optional parameters to pass to the page
   */
  async navigate(id, params = {}) {
    const pageEntry = this._pages.get(id);
    if (!pageEntry) {
      console.warn('Page not found:', id);
      return;
    }

    const leaving = this._currentPage;
    // 离开上一页：切到自己时不做回收（同一页的刷新不应拆掉自己的资源）
    if (leaving && leaving !== id) {
      await this._leave(leaving);
    }

    this._previousPage = leaving;
    this._currentPage = id;

    // Update state
    if (window.appState) {
      appState.set('currentPage', id);
      appState.set('previousPage', this._previousPage);
    }

    // Update navigation UI
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector('.nav-item[data-page="' + id + '"]')?.classList.add('active');

    // Show the page div
    document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
    const pageDiv = document.getElementById('page-' + id);
    if (pageDiv) pageDiv.classList.add('active');

    const ctx = this._context(id);
    const firstLoad = !this._loaded.has(id);
    if (firstLoad) this._loaded.add(id);

    // 渲染（首次带 loading 占位，之后静默刷新）
    if (pageEntry.page.render) {
      const contentEl = document.getElementById(id + 'Content');
      if (firstLoad && contentEl) showLoading(contentEl, '正在加载...');
      try {
        await pageEntry.page.render(params, ctx);
      } catch (e) {
        console.error('Page render error:', id, e);
        if (firstLoad && contentEl) showError(contentEl, '页面加载失败: ' + (e.message || '未知错误'));
      }
    }

    // 首次挂载钩子（一次性初始化）
    if (firstLoad && pageEntry.page.mount) {
      try {
        await pageEntry.page.mount(params, ctx);
      } catch (e) {
        console.error('Page mount error:', id, e);
      }
    }

    // Call onActivate if available
    if (pageEntry.page.onActivate) {
      try {
        await pageEntry.page.onActivate(params, ctx);
      } catch (e) {
        console.error('Page onActivate error:', id, e);
      }
    }
  }

  /**
   * Get the current page ID
   */
  getCurrentPage() {
    return this._currentPage;
  }

  /**
   * Get the previous page ID
   */
  getPreviousPage() {
    return this._previousPage;
  }

  /**
   * Check if a page is loaded
   */
  isLoaded(id) {
    return this._loaded.has(id);
  }

  /**
   * 当前页登记但尚未释放的资源数量（诊断用）
   */
  pendingDisposers(id = this._currentPage) {
    return (this._disposers.get(id) || []).length;
  }

  /**
   * Force reload a page
   */
  async reload(id, params = {}) {
    await this._leave(id);
    this._loaded.delete(id);
    return this.navigate(id, params);
  }

  /**
   * 退出：回收当前页资源（窗口关闭前调用）
   */
  async destroy() {
    const id = this._currentPage;
    this._currentPage = null;
    if (id) await this._leave(id);
    for (const key of Array.from(this._disposers.keys())) {
      this.disposePage(key);
    }
  }
}

// Create global instance
if (typeof window !== 'undefined') {
  const pageManager = new PageManager();
  window.pageManager = pageManager;
}
