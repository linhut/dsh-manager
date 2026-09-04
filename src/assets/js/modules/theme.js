/**
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * DSH Manager - Theme Module
 */
'use strict';

const THEME_KEY = 'dshm-theme';

function getCurrentTheme() {
  const stored = localStorage.getItem(THEME_KEY) || 'system';
  if (stored === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return stored;
}

function applyTheme() {
  const theme = getCurrentTheme();
  document.documentElement.setAttribute('data-theme', theme);
  const toggleBtn = document.getElementById('themeToggle');
  if (toggleBtn) {
    toggleBtn.innerHTML = theme === 'dark'
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-14v2m0 14v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  }
}

function setThemeChoice(choice) {
  localStorage.setItem(THEME_KEY, choice);
  applyTheme();
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('theme-option-active', btn.dataset.themeChoice === choice);
  });
}

function selectThemeOption(choice) {
  setThemeChoice(choice);
  showToast(`主题已切换为: ${choice === 'light' ? '浅色' : choice === 'dark' ? '深色' : '跟随系统'}`, 'success');
}
