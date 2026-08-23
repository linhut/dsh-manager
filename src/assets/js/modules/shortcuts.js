/**
 * DSH Manager - Keyboard Shortcuts Module
 * 集中管理全局键盘快捷键：
 * - Ctrl+Shift+D: 调试面板
 * - Ctrl+1~8: 页面切换
 * - Ctrl+F: 聚焦当前可见搜索框
 * - Escape: 关闭模态框
 * - F5: 刷新当前页面
 */
'use strict';

/**
 * 初始化全局键盘快捷键（在 DOMContentLoaded 后调用一次）
 */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+D: 调试面板
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      toggleDebugPanel();
      return;
    }

    // Ctrl+1~8: 页面切换
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && /^[1-8]$/.test(e.key)) {
      const page = (window.PAGE_ORDER || [])[Number(e.key) - 1];
      if (page && page !== state.currentPage) {
        e.preventDefault();
        switchPage(page);
      }
      return;
    }

    // Ctrl+F: 聚焦当前可见的搜索框
    if (e.ctrlKey && e.key === 'f' && !e.shiftKey && !e.altKey && !e.metaKey) {
      const inputs = document.querySelectorAll('.search-box input, input[type="text"]');
      for (const input of inputs) {
        if (input.offsetParent !== null) { // visible
          e.preventDefault();
          input.focus();
          input.select();
          return;
        }
      }
    }

    // Escape: 关闭模态框
    if (e.key === 'Escape') {
      const modal = document.querySelector('.modal-overlay.active');
      if (modal) {
        e.preventDefault();
        modal.remove();
      }
      return;
    }

    // F5: 刷新当前页面
    if (e.key === 'F5' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const current = state.currentPage || 'dashboard';
      switchPage(current);
      showToast('已刷新当前页面', 'info', 2000);
    }
  });
}

window.initKeyboardShortcuts = initKeyboardShortcuts;
