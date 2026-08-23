/**
 * DSH Manager - Page Manager
 * Manages page lifecycle, lazy loading, and navigation
 */
'use strict';

class PageManager {
  constructor() {
    this._pages = new Map();
    this._currentPage = null;
    this._previousPage = null;
    this._loaded = new Set();
  }

  /**
   * Register a page
   * @param {string} id - Page ID (matches the page div id)
   * @param {object} page - Page object with render() method
   * @param {boolean} [lazy=true] - Whether to lazy load the page
   */
  register(id, page, lazy = true) {
    this._pages.set(id, { page, lazy });
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

    // Store previous page
    this._previousPage = this._currentPage;
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

    // Render the page (lazy or eager)
    if (!this._loaded.has(id)) {
      this._loaded.add(id);
      // Show loading state
      const contentEl = document.getElementById(id + 'Content');
      if (contentEl && pageEntry.page.render) {
        showLoading(contentEl, '正在加载...');
        try {
          await pageEntry.page.render(params);
        } catch (e) {
          console.error('Page render error:', id, e);
          showError(contentEl, '页面加载失败: ' + (e.message || '未知错误'));
        }
      }
    } else {
      // Refresh the page
      if (pageEntry.page.render) {
        try {
          await pageEntry.page.render(params);
        } catch (e) {
          console.error('Page render error:', id, e);
        }
      }
    }

    // Call onActivate if available
    if (pageEntry.page.onActivate) {
      try {
        await pageEntry.page.onActivate(params);
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
   * Force reload a page
   */
  async reload(id, params = {}) {
    this._loaded.delete(id);
    return this.navigate(id, params);
  }
}

// Create global instance
const pageManager = new PageManager();
window.pageManager = pageManager;
