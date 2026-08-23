/**
 * DSH Manager - Utility Functions
 * HTML escaping, DOM helpers, caching, Toast system
 */
'use strict';

// ====== HTML Escaping ======

/**
 * HTML 转义（用于 innerHTML 中的文本内容）
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 属性值转义（用于 onclick 等单引号包裹的属性值）
 */
function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

/**
 * 防抖函数
 * @param {Function} fn - 需要防抖的函数
 * @param {number} delay - 延迟毫秒数
 * @returns {Function}
 */
function debounce(fn, delay = 300) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ====== Toast 通知系统 ======

const TOAST_TYPES = {
  info: 'toast-info',
  success: 'toast-success',
  warning: 'toast-warning',
  error: 'toast-error',
};

/**
 * 显示 Toast 通知
 * @param {string} message - 通知内容
 * @param {'info'|'success'|'warning'|'error'} type - 通知类型
 * @param {number} duration - 显示时长（毫秒），默认 4000
 * @param {object} [options] - 可选配置
 * @param {Function} [options.onClick] - 点击回调
 * @param {string} [options.actionLabel] - 操作按钮文字
 * @param {Function} [options.action] - 操作按钮回调
 */
function showToast(message, type = 'info', duration = 4000, options = {}) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  
  const el = document.createElement('div');
  el.className = 'toast-item ' + (TOAST_TYPES[type] || TOAST_TYPES.info);
  
  // Icon based on type
  const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
  const icon = icons[type] || icons.info;
  
  // Build toast content
  const content = document.createElement('span');
  content.textContent = icon + ' ' + message;
  
  // Action button
  if (options && options.actionLabel && options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action';
    actionBtn.textContent = options.actionLabel;
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      options.action();
      dismissToast(el);
    };
    el.appendChild(content);
    el.appendChild(actionBtn);
  } else {
    el.appendChild(content);
  }
  
  // Click handler
  if (options && options.onClick) {
    el.style.cursor = 'pointer';
    el.onclick = () => {
      options.onClick();
      dismissToast(el);
    };
  }
  
  container.appendChild(el);
  
  // Auto dismiss
  if (duration > 0) {
    setTimeout(() => dismissToast(el), duration);
  }
  
  // Limit visible toasts
  while (container.children.length > 5) {
    dismissToast(container.firstChild);
  }
}

function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.style.opacity = '0';
  el.style.transform = 'translateX(100%)';
  el.style.transition = 'all 0.3s ease';
  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, 300);
}

/**
 * 清除所有 Toast
 */
function clearAllToasts() {
  const container = document.getElementById('toastContainer');
  if (container) container.innerHTML = '';
}

// ====== 格式化工具 ======

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
  if (bytes === 0 || bytes === undefined || bytes === null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/**
 * 格式化日期
 */
function formatDate(date) {
  if (!date) return '-';
  try {
    return new Date(date).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return String(date);
  }
}

// ====== 请求缓存 ======

const _cache = new Map();
const _cacheTimers = new Map();

/**
 * 带缓存的请求（短 TTL，避免重复调用）
 * @param {string} key - 缓存键
 * @param {Function} fetcher - 获取数据的函数
 * @param {number} ttl - 缓存有效期（毫秒），默认 5000
 * @returns {Promise<any>}
 */
async function cachedRequest(key, fetcher, ttl = 5000) {
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }
  const data = await fetcher();
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

/**
 * 清除指定缓存
 */
function clearCache(key) {
  _cache.delete(key);
  const timer = _cacheTimers.get(key);
  if (timer) { clearTimeout(timer); _cacheTimers.delete(key); }
}

/**
 * 清除所有缓存
 */
function clearAllCache() {
  _cache.clear();
  for (const timer of _cacheTimers.values()) clearTimeout(timer);
  _cacheTimers.clear();
}

// ====== DOM 辅助 ======

/**
 * 安全地设置元素文本内容（避免 XSS）
 */
function setText(el, text) {
  if (el) el.textContent = text;
}

/**
 * 创建元素并设置属性
 */
function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key.startsWith('on')) {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child instanceof Node) el.appendChild(child);
  }
  return el;
}

/**
 * 显示加载状态
 */
function showLoading(el, message = '加载中...') {
  if (!el) return;
  el.innerHTML = '<div class="spinner-wrap"><span class="spinner"></span><span>' + escapeHtml(message) + '</span></div>';
}

/**
 * 显示空状态
 */
function showEmpty(el, icon = '📭', title = '暂无数据', desc = '') {
  if (!el) return;
  el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">' + icon + '</div>' +
    '<div class="empty-state-title">' + escapeHtml(title) + '</div>' +
    (desc ? '<div class="empty-state-desc">' + escapeHtml(desc) + '</div>' : '') +
    '</div>';
}

/**
 * 显示错误状态
 */
function showError(el, message = '加载失败', retryFn = null) {
  if (!el) return;
  el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div>' +
    '<div class="empty-state-title">' + escapeHtml(message) + '</div>' +
    (retryFn ? '<button class="btn btn-sm btn-primary" onclick="(' + retryFn + ')()">🔄 重试</button>' : '') +
    '</div>';
}

// ====== 模态对话框 ======

/**
 * 显示确认对话框
 * @param {string} title - 对话框标题
 * @param {string} message - 对话框内容
 * @param {object} [options]
 * @param {string} [options.confirmText] - 确认按钮文字
 * @param {string} [options.cancelText] - 取消按钮文字
 * @param {'danger'|'primary'|'default'} [options.confirmVariant] - 确认按钮样式
 * @returns {Promise<boolean>} - 用户是否确认
 */
function showConfirm(title, message, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = '<div class="modal" style="min-width:400px;max-width:480px;">' +
      '<h3 class="modal-title">' + escapeHtml(title) + '</h3>' +
      '<div class="modal-body"><p style="line-height:1.6;white-space:pre-wrap;">' + escapeHtml(message) + '</p></div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" id="confirmCancel">' + escapeHtml(options.cancelText || '取消') + '</button>' +
      '<button class="btn ' + (options.confirmVariant === 'danger' ? 'btn-danger' : options.confirmVariant === 'primary' ? 'btn-primary' : 'btn-primary') + '" id="confirmOk">' + escapeHtml(options.confirmText || '确定') + '</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    
    const cleanup = () => { if (overlay.parentNode) overlay.remove(); };
    
    document.getElementById('confirmOk').onclick = () => { cleanup(); resolve(true); };
    document.getElementById('confirmCancel').onclick = () => { cleanup(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
    
    // Keyboard: Enter to confirm, Escape to cancel
    const keyHandler = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(false); }
      if (e.key === 'Enter') { cleanup(); resolve(true); }
    };
    document.addEventListener('keydown', keyHandler);
    overlay._cleanup = () => document.removeEventListener('keydown', keyHandler);
  });
}

/**
 * 显示提示对话框
 * @param {string} title - 对话框标题
 * @param {string} message - 对话框内容
 * @param {string} [type] - 'info' | 'warning' | 'error'
 */
function showAlert(title, message, type = 'info') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    const icon = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
    overlay.innerHTML = '<div class="modal" style="min-width:400px;max-width:480px;">' +
      '<h3 class="modal-title">' + icon + ' ' + escapeHtml(title) + '</h3>' +
      '<div class="modal-body"><p style="line-height:1.6;white-space:pre-wrap;">' + escapeHtml(message) + '</p></div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-primary" id="alertOk">确定</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    
    document.getElementById('alertOk').onclick = () => { overlay.remove(); resolve(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
  });
}

// ====== 超时管理器 ======

class TimeoutManager {
  constructor() {
    this._timers = new Map();
    this._idCounter = 0;
  }
  
  /**
   * 设置超时
   * @param {Function} fn - 回调函数
   * @param {number} delay - 延迟毫秒数
   * @param {string} [label] - 可选的标签
   * @returns {string} - 定时器 ID，可用于取消
   */
  setTimeout(fn, delay, label = '') {
    const id = 't_' + (++this._idCounter);
    const timer = setTimeout(() => {
      this._timers.delete(id);
      try { fn(); } catch (e) { console.warn('Timeout error [' + label + ']:', e); }
    }, delay);
    this._timers.set(id, { timer, label });
    return id;
  }
  
  /**
   * 取消超时
   */
  clearTimeout(id) {
    const entry = this._timers.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this._timers.delete(id);
    }
  }
  
  /**
   * 清除所有超时
   */
  clearAll() {
    for (const entry of this._timers.values()) clearTimeout(entry.timer);
    this._timers.clear();
  }
  
  /**
   * 安全地包裹一个 Promise 带超时
   * @param {Promise} promise - 原始 Promise
   * @param {number} timeoutMs - 超时毫秒
   * @param {string} [label] - 超时描述
   * @returns {Promise} - 带超时的 Promise
   */
  timeoutPromise(promise, timeoutMs, label = '') {
    return new Promise((resolve, reject) => {
      const timer = this.setTimeout(() => {
        reject(new Error((label || '操作') + '超时 (' + timeoutMs + 'ms)'));
      }, timeoutMs, label);
      promise.then(
        (val) => { this.clearTimeout(timer); resolve(val); },
        (err) => { this.clearTimeout(timer); reject(err); }
      );
    });
  }
}

// Create global instances
const timeoutManager = new TimeoutManager();

// ====== 日志系统 ======

const debugLog = {
  log(level, message) {
    const prefix = '[' + new Date().toLocaleTimeString() + '] [' + level.toUpperCase() + ']';
    if (level === 'error') console.error(prefix, message);
    else if (level === 'warn') console.warn(prefix, message);
    else console.log(prefix, message);
  },
  info(msg) { this.log('info', msg); },
  warn(msg) { this.log('warn', msg); },
  error(msg) { this.log('error', msg); },
};

// Export to window for backward compatibility
window.debugLog = debugLog;
window.timeoutManager = timeoutManager;
window.showToast = showToast;
window.dismissToast = dismissToast;
window.clearAllToasts = clearAllToasts;
window.showConfirm = showConfirm;
window.showAlert = showAlert;
window.showLoading = showLoading;
window.showEmpty = showEmpty;
window.showError = showError;
window.cachedRequest = cachedRequest;
window.clearCache = clearCache;
window.clearAllCache = clearAllCache;
window.formatDate = formatDate;
window.setText = setText;
window.createElement = createElement;
