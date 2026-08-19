/**
 * DSH Manager - 主应用逻辑
 * 
 * 管理所有页面渲染、DSH 状态、安装流程、插件管理
 */

// ====== 全局状态 ======
const state = {
  skillsQuery: '',
  skillEditingName: null,
  currentPage: 'dashboard',
  dshInstalled: false,
  dshVersion: null,
  dshRunning: false,
  dshUrl: 'http://127.0.0.1:3080',
  plugins: [],
  installing: false,
  pnpmAvailable: null,
  pnpmVersion: null,
  pnpmInstallGuide: '',
  dshInfo: null,
  marketResults: [],
  marketCategory: 'all',
  marketSort: 'top',
  localPlugins: [],
};

// ====== 安全工具（防止 XSS） ======
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

// ====== 调试日志系统（拦截 console 和全局错误） ======
const debugLog = {
  enabled: false, logs: [], MAX_QUEUE: 500,
  init() {
    this.enabled = true;
    const self = this;
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;
    console.log = function(...args) { self._log('info', args); origLog.apply(console, args); };
    console.info = function(...args) { self._log('info', args); origInfo.apply(console, args); };
    console.warn = function(...args) { self._log('warn', args); origWarn.apply(console, args); };
    console.error = function(...args) { self._log('error', args); origError.apply(console, args); };
    window.addEventListener('error', (event) => { self._log('error', [event.error?.stack || event.error?.message || event.message || '未知错误']); });
    window.addEventListener('unhandledrejection', (event) => { self._log('error', [event.reason?.stack || event.reason?.message || String(event.reason)]); });
    this.log('info', '调试日志系统已初始化');
    this.log('info', 'URL: ' + window.location.href);
  },
  _log(level, args) {
    const msg = args.map(a => typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a)).join(' ');
    this.logs.push({ level, message: msg, time: new Date().toISOString() });
    if (this.logs.length > this.MAX_QUEUE) this.logs.splice(0, this.logs.length - this.MAX_QUEUE);
    if (window.dshManager) { window.dshManager.writeDebugLog(level, msg).catch(() => {}); }
  },
  log(level, message) { this._log(level, [message]); },
  getLogs() { return this.logs.map(l => '[' + l.time + '] [' + l.level.toUpperCase() + '] ' + l.message).join('\n'); },
  clearLogs() { this.logs = []; return '日志已清除'; }
};
try { debugLog.init(); } catch (e) { try { console.error('调试日志初始化失败:', e); } catch {} }

// ====== 主题系统 ======
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
  // 更新主题切换按钮图标
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
  // 更新设置页的主题选项高亮
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('theme-option-active', btn.dataset.themeChoice === choice);
  });
}

function selectThemeOption(choice) {
  setThemeChoice(choice);
  showToast(`主题已切换为: ${choice === 'light' ? '浅色' : choice === 'dark' ? '深色' : '跟随系统'}`, 'success');
}

// ====== 初始化（带超时保护） ======


// ====== 带超时的 fetch（手动 AbortController） ======
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

document.addEventListener('DOMContentLoaded', async () => {
  debugLog.log('info', 'DOMContentLoaded 触发');
  // 应用主题（在渲染页面之前）
  applyTheme();

  // 监听系统主题变化（system 模式下自动切换）
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') {
      applyTheme();
    }
  });

  // 主题切换按钮
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = getCurrentTheme();
      // 切换后固定为用户选择（不再跟随系统）
      setThemeChoice(current === 'dark' ? 'light' : 'dark');
    });
  }

  // 窗口最大化监听
  if (window.dshManager) {
    window.dshManager.onMaximizeChange((isMax) => {
      document.getElementById('maxBtn').innerHTML = isMax
        ? '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="2" width="8" height="8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
        : '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1" y="1" width="10" height="10" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
    });
    // 初始化最大化按钮状态
    try {
      const isMax = await window.dshManager.isMaximized();
      document.getElementById('maxBtn').innerHTML = isMax
        ? '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="2" width="8" height="8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
        : '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1" y="1" width="10" height="10" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
    } catch {}
  }

  // 首次渲染页面（让用户尽快看到内容，不因检测阻塞）
  renderInstallPage();
  renderPluginsPage();
  renderSkillsPage();
  renderVersionsPage();
  renderSettingsPage();
  renderAboutPage();

  // 异步检测 DSH 状态（带超时保护，不阻塞 UI）
  // 注意：Promise.race 不会取消超时定时器，必须在回调里用完成标志防止
  // 检测成功后仍把状态覆盖成"检测超时"
  let dshCheckDone = false;
  Promise.race([
    checkDSHStatus().then(() => { dshCheckDone = true; }),
    new Promise(r => setTimeout(() => {
      if (!dshCheckDone) {
        console.warn('checkDSHStatus 超时，跳过');
        updateStatusToError('dshStatus', 'DSH 检测超时');
      }
      r();
    }, 30_000))
  ]).then(() => {
    if (state.dshInstalled && autoStartConsole) {
      tryLoadDSHWeb();
    }
  }).catch(() => {});

  // 异步检测 pnpm 状态（带超时保护）
  let pnpmCheckDone = false;
  Promise.race([
    checkPnpmStatus().then(() => { pnpmCheckDone = true; }),
    new Promise(r => setTimeout(() => {
      if (!pnpmCheckDone) {
        console.warn('checkPnpmStatus 超时，跳过');
        updateStatusToError('pnpmStatus', 'pnpm 检测超时');
      }
      r();
    }, 30_000))
  ]).catch(() => {});

  // 读取 Manager 设置（自动打开控制台 / 启动时检查更新）
  let autoStartConsole = true;
  let checkUpdatesOnStartup = true;
  try {
    autoStartConsole = (await window.dshManager.getConfig('manager.auto-start-dsh')) !== false;
    checkUpdatesOnStartup = (await window.dshManager.getConfig('manager.check-updates')) !== false;
  } catch {}

  //   // 等 checkDSHStatus 完成后再尝试加载 DSH Web
  // (已移至 Promise.race .then() 中)

  // 开启"启动时检查 DSH 更新"则静默检查一次
  if (checkUpdatesOnStartup) {
    checkDSHUpdateStartup();
  }
});

// ====== 页面切换 ======
function switchPage(page) {
  state.currentPage = page;

  // 更新导航高亮
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

  // 显示对应页面
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  // 刷新页面数据
  if (page === 'dashboard') tryLoadDSHWeb();
  if (page === 'plugins') renderPluginsPage();
  if (page === 'skills') renderSkillsPage();
  if (page === 'versions') renderVersionsPage();
}

// ====== 状态更新辅助函数 ======
function updateStatusToError(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('.status-text');
  if (dot) dot.className = 'status-dot status-error';
  if (text) text.textContent = message;
}

// ====== DSH 状态检测 ======
async function checkDSHStatus() {
  const statusEl = document.getElementById('dshStatus');
  if (!statusEl) return;

  try {
    const info = await window.dshManager.getDSHInfo();
    state.dshInstalled = info.installed;
    state.dshVersion = info.version;
    state.dshInfo = info;

    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');

    if (info.installed) {
      dot.className = 'status-dot status-ok';
      text.textContent = `DSH ${info.version}`;
      
      // 不在此处检测 DSH 是否运行（避免 TCP 连接挂起）
      // 由 tryLoadDSHWeb 在需要时检测
      state.dshRunning = false;
    } else {
      dot.className = 'status-dot status-error';
      text.textContent = 'DSH 未安装';
    }
    renderDashToolbar();
    renderDashInfo();
    // 异步检测完成后刷新安装页，避免"已安装却显示未安装/提示重装"
    const installContent = document.getElementById('installContent');
    if (installContent) renderInstallPage();
  } catch (err) {
    console.error('状态检测失败:', err);
    updateStatusToError('dshStatus', 'DSH 检测失败');
  }
}

// ====== pnpm 状态检测 ======
async function checkPnpmStatus() {
  const statusEl = document.getElementById('pnpmStatus');
  if (!statusEl) return;

  try {
    const result = await window.dshManager.checkPnpm();
    state.pnpmAvailable = result.installed;
    state.pnpmVersion = result.version;
    state.pnpmInstallGuide = result.installGuide || 'corepack enable';

    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');

    if (result.installed) {
      dot.className = 'status-dot status-ok';
      text.textContent = `pnpm ${result.version}`;
      statusEl.style.cursor = 'default';
      statusEl.title = '';
      statusEl.onclick = null;
    } else {
      dot.className = 'status-dot status-error';
      text.textContent = 'pnpm 未安装';
      // 点击触发一键安装
      statusEl.style.cursor = 'pointer';
      statusEl.title = '点击一键安装 pnpm';
      statusEl.onclick = () => {
        if (confirm('pnpm 未安装，插件管理功能不可用。\n是否立即一键安装 pnpm？（npm install -g pnpm）')) {
          installPnpm();
        }
      };
    }
  } catch (err) {
    console.error('pnpm 检测失败:', err);
    updateStatusToError('pnpmStatus', 'pnpm 检测失败');
  }
}

// ====== 一键安装 pnpm ======
async function installPnpm() {
  clearEnvInstallLog();
  appendEnvInstallLog('开始安装 pnpm（npm install -g pnpm）...');
  showToast('正在安装 pnpm，请稍候...', 'info');
  // 订阅主进程推送的安装过程输出（实时回显）
  window.dshManager.removeAllListeners('env-install-progress');
  window.dshManager.onEnvInstallProgress((data) => {
    if (data && data.message) appendEnvInstallLog(data.message, data.level);
  });
  try {
    const result = await window.dshManager.installPnpm();
    if (result.success) {
      appendEnvInstallLog(`✅ pnpm ${result.version} 安装成功！`, 'info');
      showToast(`✅ pnpm ${result.version} 安装成功！`, 'success');
    } else {
      const detail = result.message || result.error || '未知错误';
      appendEnvInstallLog(`❌ pnpm 安装失败: ${detail}`, 'error');
      showToast(`❌ pnpm 安装失败: ${detail}`, 'error');
    }
    await checkPnpmStatus();
    renderInstallPage();
  } catch (err) {
    appendEnvInstallLog(`❌ ${err.message}`, 'error');
    showToast('❌ pnpm 安装失败: ' + err.message, 'error');
  } finally {
    window.dshManager.removeAllListeners('env-install-progress');
  }
}

// ====== 启动时静默检查 DSH 更新 ======
async function checkDSHUpdateStartup() {
  try {
    const update = await window.dshManager.checkDSHUpdate();
    if (update && update.hasUpdate) {
      showToast(`发现 DSH 新版本 ${update.latest}（当前 ${update.current}），可到"安装/升级"页升级`, 'warning');
    }
  } catch {}
}

// ====== DSH Web 界面加载 ======
// ====== DSH Web 界面加载 ======
async function tryLoadDSHWeb() {
  renderDashToolbar();
  renderDashInfo();
  const container = document.getElementById('dshWebviewContainer');
  const placeholder = document.getElementById('dshPlaceholder');
  const webview = document.getElementById('dshWebview');

  if (!state.dshInstalled) {
    placeholder.style.display = 'flex';
    webview.style.display = 'none';
    return;
  }

  // 尝试连接 DSH Web
  try {
    const resp = await fetchWithTimeout('http://127.0.0.1:3080', 3000);
    if (resp.ok) {
      placeholder.style.display = 'none';
      webview.style.display = 'flex';
      state.dshRunning = true;
      // DSH 运行中：自动收起环境信息
      dashInfoCollapsed = true;
      const dashInfoEl = document.getElementById('dashInfo');
      if (dashInfoEl) dashInfoEl.style.display = 'none';

      // 自动刷新 webview
      try {
        if (webview.src === 'http://127.0.0.1:3080') {
          webview.reload();
        } else {
          webview.src = 'http://127.0.0.1:3080';
        }
      } catch (e) {
        console.warn('webview 刷新失败:', e.message);
        webview.src = 'http://127.0.0.1:3080';
      }

      // 刷新工具栏
      renderDashToolbar();
      renderDashInfo();
      return;
    }
  } catch {}

  // DSH 未运行，显示启动提示
  state.dshRunning = false;
  placeholder.style.display = 'flex';
  webview.style.display = 'none';
  placeholder.innerHTML = `
    <div class="placeholder-content">
      <img src="assets/images/logo-large.png" alt="DSH Manager" class="placeholder-icon" style="width:64px;height:64px;">
      <h2>DSH 已安装但未运行</h2>
      <p>DeepSeek Harness ${state.dshVersion} 已安装，但服务未启动。</p>
      <p class="placeholder-hint">请在终端中运行 <code>dsh web</code> 启动 Web 界面</p>
      <button class="btn btn-primary btn-lg" onclick="tryStartDSH()">
        🚀 尝试启动 DSH
      </button>
    </div>
  `;
  renderDashToolbar();
  renderDashInfo();
}

// ====== 尝试启动 DSH ======
async function tryStartDSH() {
  showToast('正在尝试启动 DSH...', 'info');
  try {
    // 订阅主进程推送的启动失败信息（dsh web 崩溃时展示真实 stderr）
    let startErrorHandled = false;
    window.dshManager.removeAllListeners('dsh:start-error');
    window.dshManager.onDSHStartError((data) => {
      if (startErrorHandled) return;
      startErrorHandled = true;
      const detail = data?.stderr
        ? (data.stderr.split('\n').slice(0, 4).join(' ').slice(0, 300))
        : ('exit code ' + (data?.exitCode ?? '?'));
      showToast('❌ DSH 启动失败: ' + detail, 'error');
    });

    // 通过 IPC 让主进程启动 DSH（渲染进程无法直接访问 execa）
    const result = await window.dshManager.startDSH();
    
    if (!result.success) {
      showToast('启动失败: ' + (result.error || '未知错误'), 'error');
      return;
    }
    
    showToast('DSH 启动命令已发送，正在等待服务就绪...', 'info');
    
    // 重试连接：每 2 秒尝试一次，最长等待 30 秒
    let retries = 0;
    const maxRetries = 15;
    const retryInterval = 2000;
    
    const tryConnect = async () => {
      retries++;
      try {
        const resp = await fetchWithTimeout('http://127.0.0.1:3080', 3000);
        if (resp.ok) {
          showToast('DSH 已启动！', 'success');
          tryLoadDSHWeb();
          return;
        }
      } catch {
        // 连接失败，继续重试
      }
      
      if (retries < maxRetries) {
        setTimeout(tryConnect, retryInterval);
      } else {
        showToast('DSH 启动超时，请手动运行 dsh web 命令，或切换页面重新加载', 'error');
      }
    };
    
    setTimeout(tryConnect, 2000);
  } catch (err) {
    showToast('启动失败: ' + err.message, 'error');
  }
}

// ====== 环境信息折叠状态 ======
let dashInfoCollapsed = false;

// ====== 切换环境信息显隐 ======
function toggleDashInfo() {
  dashInfoCollapsed = !dashInfoCollapsed;
  const el = document.getElementById('dashInfo');
  // 用户点击优先：显示与否仅由 dashInfoCollapsed 决定，不受 DSH 运行状态压制
  if (el) el.style.display = dashInfoCollapsed ? 'none' : 'block';
  renderDashToolbar();
  // 更新按钮高亮
  const btn = document.querySelector('[data-toggle-dashinfo]');
  if (btn) {
    btn.classList.toggle('btn-primary', !dashInfoCollapsed);
    btn.classList.toggle('btn-ghost', dashInfoCollapsed);
  }
}

// ====== DSH 控制台合并工具栏（启动/停止/浏览器/更新/安装/环境信息） ======
function renderDashToolbar() {
  const bar = document.getElementById('dashToolbar');
  if (!bar) return;

  const statusBadge = !state.dshInstalled
    ? '<span class="badge badge-red">🔴 未安装</span>'
    : state.dshRunning
      ? '<span class="badge badge-green">🟢 运行中</span>'
      : '<span class="badge badge-yellow">🟡 未运行</span>';

  bar.style.display = 'flex';
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        ${statusBadge}
        <span style="font-size:12px;color:var(--text-muted);">v${state.dshVersion || '-'}</span>
      </div>
      <div style="display:flex;gap:6px;margin-left:auto;flex-wrap:wrap;">
        <button class="btn btn-sm btn-secondary" onclick="window.dshManager.openExternal('${state.dshUrl}')" title="在系统浏览器中打开 DSH Web">🌐 浏览器打开</button>
        ${state.dshRunning
          ? '<button class="btn btn-sm btn-danger" onclick="stopDSH()">🛑 停止 DSH</button>'
          : (state.dshInstalled ? '<button class="btn btn-sm btn-primary" onclick="tryStartDSH()">🚀 启动 DSH</button>' : '')}
        <button class="btn btn-sm btn-secondary" onclick="checkAppUpdateUI()" title="检查 DSH Manager 新版本">🔄 检查更新</button>
        <button class="btn btn-sm btn-secondary" onclick="switchPage('install')" title="安装/升级 DSH">📥 安装/升级</button>
        <button class="btn btn-sm ${!dashInfoCollapsed ? 'btn-primary' : 'btn-ghost'}" onclick="toggleDashInfo()" data-toggle-dashinfo title="展开/收起环境信息">📋 环境信息</button>
      </div>
    </div>
  `;
}

// ====== 停止 DSH ======
async function stopDSH() {
  showToast('正在停止 DSH...', 'info');
  try {
    const result = await window.dshManager.stopDSH();
    if (result.success) {
      showToast('DSH 已停止', 'success');
    } else {
      showToast('停止失败: ' + (result.error || '未知错误'), 'error');
    }
    state.dshRunning = false;
    renderDashToolbar();
    tryLoadDSHWeb();
  } catch (err) {
    showToast('停止失败: ' + err.message, 'error');
  }
}

// ====== DSH 控制台环境信息栏（自动折叠） ======
async function renderDashInfo() {
  const el = document.getElementById('dashInfo');
  if (!el) return;
  const info = state.dshInfo || {};
  if (!state.dshInstalled) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  // 折叠：仅由用户状态 dashInfoCollapsed 决定（初始加载时 DSH 运行中会自动折叠一次）
  if (dashInfoCollapsed) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML =
    `<div class="card" style="margin-bottom:12px;">
      <div class="card-header">
        <span class="card-title">🖥️ 环境信息</span>
        <span class="badge ${state.dshRunning ? 'badge-green' : 'badge-gray'}">${state.dshRunning ? '运行中' : '未运行'}</span>
      </div>
      <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px;font-size:12px;color:var(--text-muted);">
        <div>📦 DSH 版本: <strong>${state.dshVersion || '-'}</strong></div>
        <div>⚙️ Node.js: <strong>${info.nodeVersion || '-'}</strong></div>
        <div>💻 平台: <strong>${info.platform || '-'} / ${info.arch || '-'}</strong></div>
        <div>🏠 主目录: <strong title="${info.home || ''}" style="word-break:break-all;">${info.home || '-'}</strong></div>
        <div>📡 全局路径: <strong title="${info.npmGlobalPath || ''}" style="word-break:break-all;">${info.npmGlobalPath || '-'}</strong></div>
        <div>🌐 Web 地址: <strong>${state.dshUrl}</strong></div>
        <div id="processStatusCell">🔌 端口 3080: <strong>检测中...</strong></div>
      </div>
    </div>
  `;

  // 异步检测
  try {
    const proc = await window.dshManager.getDSHProcessInfo();
    const cell = document.getElementById('processStatusCell');
    if (cell) {
      if (proc.portInUse) {
        cell.innerHTML = `🔌 端口 ${proc.port}: <strong class="badge badge-red">占用中${proc.pid ? ` (PID ${proc.pid}${proc.command ? ' · ' + proc.command : ''})` : ''}</strong>`;
      } else {
        cell.innerHTML = `🔌 端口 ${proc.port}: <span class="badge badge-green">空闲</span>`;
      }
    }
  } catch {}
}

// ====== 安装页面 ======
function renderInstallPage() {
  const el = document.getElementById('installContent');
  if (!el) return;

  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <span class="card-title">🧪 基础环境检测</span>
      </div>
      <div class="card-body" id="envStatus">
        <p style="color:var(--text-dim);">检测中...</p>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:24px;">
      <div class="card">
        <div class="card-header">
          <span class="card-title">DSH 安装状态</span>
          <span class="badge ${state.dshInstalled ? 'badge-green' : 'badge-red'}">
            ${state.dshInstalled ? '已安装' : '未安装'}
          </span>
        </div>
        <div class="card-body">
          ${state.dshInstalled
            ? `<p>当前版本: <strong>${state.dshVersion}</strong></p>
               <p style="margin-top:8px;color:var(--text-dim);">DSH 已就绪，可以开始使用</p>`
            : `<p>DeepSeek Harness 尚未安装。</p>
               <p style="margin-top:8px;color:var(--text-dim);">点击下方按钮一键安装</p>`
          }
        </div>
        <div style="margin-top:16px;display:flex;gap:8px;">
          ${!state.dshInstalled
            ? `<button class="btn btn-primary btn-lg" onclick="installDSH('auto')" id="installBtn">
                 📥 安装 DSH
               </button>`
            : `<button class="btn btn-success" onclick="upgradeDSH()" id="upgradeBtn">
                 🔄 检查更新
               </button>
               <button class="btn btn-danger" onclick="uninstallDSH()" id="uninstallBtn">
                 🗑️ 卸载
               </button>`
          }
        </div>
        ${!state.dshInstalled ? `
        <div style="margin-top:12px;">
          <p style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">安装方式（npm 失败自动切换 pnpm/镜像）：</p>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-secondary" onclick="installDSH('auto')">🔄 自动</button>
            <button class="btn btn-sm btn-secondary" onclick="installDSH('mirror')">🇨🇳 镜像源</button>
            <button class="btn btn-sm btn-secondary" onclick="installDSH('pnpm')">📦 pnpm</button>
            <button class="btn btn-sm btn-secondary" onclick="installDSH('corepack')">📦 corepack</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <input class="input" id="installVersion" placeholder="版本号（留空=最新）" style="flex:1;min-width:140px;max-width:200px;">
            <select class="input" id="installRegistry" style="flex:1;min-width:180px;max-width:260px;">
              <option value="">镜像：自动（官方）</option>
              <option value="https://registry.npmjs.org">官方 registry.npmjs.org</option>
              <option value="https://registry.npmmirror.com">npmmirror（国内）</option>
              <option value="https://mirrors.cloud.tencent.com/npm/">腾讯云镜像</option>
              <option value="https://repo.huaweicloud.com/repository/npm/">华为云镜像</option>
            </select>
          </div>
        </div>` : ''}
        <div id="installProgress" style="display:none;margin-top:16px;">
          <div class="progress-bar"><div class="progress-bar-fill" id="progressFill" style="width:0%"></div></div>
          <p id="progressText" style="margin-top:8px;font-size:13px;color:var(--text-muted);"></p>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">快速启动</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;">
          <button class="btn btn-primary btn-lg" onclick="switchPage('dashboard')" ${!state.dshInstalled ? 'disabled' : ''}>
            🚀 打开 DSH 控制台
          </button>
          <button class="btn btn-secondary" onclick="switchPage('plugins')" ${!state.dshInstalled ? 'disabled' : ''}>
            🔌 管理插件
          </button>
          <button class="btn btn-secondary" onclick="switchPage('versions')" ${!state.dshInstalled ? 'disabled' : ''}>
            📦 版本管理
          </button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">安装说明</span>
      </div>
      <div class="card-body" style="line-height:1.8;">
        <p>📋 <strong>DSH Manager</strong> 会自动完成以下操作：</p>
        <ol style="margin-top:8px;padding-left:20px;color:var(--text-muted);">
          <li>检测 Node.js 环境</li>
          <li>通过 npm 全局安装 <code>@deepseek-ai/dsh</code></li>
          <li>创建 DSH 配置文件目录</li>
          <li>安装完成后即可启动 DSH Web 界面</li>
        </ol>
        <p style="margin-top:12px;color:var(--text-dim);">
          💡 安装需要 Node.js 18+ 和网络连接。如果遇到问题，请使用"系统诊断"功能。
        </p>
        <div style="margin-top:12px;">
          <button class="btn btn-secondary" onclick="runDoctor()">🩺 系统诊断</button>
        </div>
      </div>
    </div>
  `;

  // 基础环境检测（空白环境部署支持）
  renderEnvStatus();
}

// ====== 基础环境检测 ======
async function renderEnvStatus() {
  const el = document.getElementById('envStatus');
  if (!el) return;
  let env = null;
  try {
    // 带超时保护的环境检测（30秒超时，防止挂死）
    env = await Promise.race([
      window.dshManager.checkEnvironment(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('环境检测超时')), 30_000))
    ]);
  } catch (e) {
    console.warn('环境检测失败:', e.message);
  }
  if (!env) {
    el.innerHTML = '<p style="color:var(--error);font-size:13px;">⚠️ 环境检测失败</p>';
    return;
  }

  const { node, npm, pnpm, git } = env;
  const row = (icon, label, info) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${icon}</span>
      <span style="min-width:110px;">${label}</span>
      <span>${info}</span>
    </div>`;

  const nodeRow = node.installed
    ? row('✅', 'Node.js', `<strong>${node.version}</strong>`)
    : row('❌', 'Node.js', '<span style="color:var(--error);">未安装（DSH 依赖 Node.js 18+）</span>');
  const npmRow = npm.installed
    ? row('✅', 'npm', `<strong>${npm.version}</strong>`)
    : row('❌', 'npm', '<span style="color:var(--error);">未安装（随 Node.js 一起提供）</span>');
  const pnpmRow = pnpm.installed
    ? row('✅', 'pnpm', `<strong>${pnpm.version}</strong>`)
    : row('⚠️', 'pnpm', '<span style="color:var(--warning);">未安装（插件管理需要，可一键安装）</span>');
  const gitRow = git?.installed
    ? row('✅', 'git', `<strong>${git.version}</strong>`)
    : row('❌', 'git', '<span style="color:var(--error);">未安装（GitHub 插件安装需要，可一键安装）</span>');

  const missingNode = !node.installed;
  const missingNpm = !npm.installed;
  const missingGit = !git?.installed;
  el.innerHTML = `
    ${nodeRow}${npmRow}${pnpmRow}${gitRow}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      ${(missingNode || missingNpm) ? `
        <button class="btn btn-sm btn-primary" onclick="installNodejs()" id="installNodeBtn">⬇️ 一键安装 Node.js</button>
        <button class="btn btn-sm btn-secondary" onclick="window.dshManager.openExternal('https://nodejs.org')">🌐 官网下载</button>` : ''}
      ${!pnpm.installed ? `<button class="btn btn-sm btn-secondary" onclick="installPnpm()">一键安装 pnpm</button>` : ''}
      ${missingGit ? `
        <button class="btn btn-sm btn-secondary" onclick="installGit()" id="installGitBtn">⬇️ 一键安装 git</button>
        <button class="btn btn-sm btn-secondary" onclick="window.dshManager.openExternal('https://git-scm.com/downloads')">🌐 官网下载</button>` : ''}
    </div>
    ${(missingNode || missingNpm) ? `<p style="font-size:12px;color:var(--text-dim);margin-top:8px;">💡 基础空白环境：请先安装 Node.js（含 npm）再安装 DSH。安装后如仍不可用，请重启 DSH Manager 使 PATH 生效。</p>` : ''}
    <div id="envInstallLog" style="display:none;margin-top:10px;background:var(--bg-primary);border-radius:var(--radius-sm);padding:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);max-height:180px;overflow-y:auto;line-height:1.6;"></div>
  `;
}

// ====== 安装回显日志（Node/pnpm 安装实时输出） ======
function appendEnvInstallLog(message, level = 'info') {
  const log = document.getElementById('envInstallLog');
  if (!log) return;
  if (log.style.display === 'none') log.style.display = 'block';
  const color = level === 'warn' ? 'var(--warning)' : level === 'error' ? 'var(--error)' : 'var(--text-muted)';
  log.innerHTML += `<div style="color:${color};white-space:pre-wrap;">${message.replace(/</g, '&lt;')}</div>`;
  log.scrollTop = log.scrollHeight;
}

function clearEnvInstallLog() {
  const log = document.getElementById('envInstallLog');
  if (log) { log.innerHTML = ''; log.style.display = 'none'; }
}

// ====== 一键安装 Node.js ======
async function installNodejs() {
  const btn = document.getElementById('installNodeBtn');
  clearEnvInstallLog();
  appendEnvInstallLog('开始安装 Node.js（通过系统包管理器），请稍候...');
  showToast('正在通过系统包管理器安装 Node.js，请稍候（可能需要几分钟）...', 'info');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 安装中...'; }
  // 订阅主进程推送的安装过程输出（实时回显）
  window.dshManager.removeAllListeners('env-install-progress');
  window.dshManager.onEnvInstallProgress((data) => {
    if (data && data.message) appendEnvInstallLog(data.message, data.level);
  });
  try {
    const result = await window.dshManager.installNodejs();
    if (result.success) {
      appendEnvInstallLog(`✅ ${result.message || 'Node.js 安装成功'}`, 'info');
      showToast(`✅ ${result.message || 'Node.js 安装成功'}`, 'success');
    } else {
      appendEnvInstallLog(`❌ ${result.message || result.error || '未知错误'}`, 'error');
      showToast(`❌ Node.js 安装失败: ${result.message || result.error || '未知错误'}`, 'error');
    }
    await renderEnvStatus();
    await checkDSHStatus();
  } catch (err) {
    appendEnvInstallLog(`❌ ${err.message}`, 'error');
    showToast('❌ Node.js 安装失败: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '⬇️ 一键安装 Node.js'; }
  } finally {
    window.dshManager.removeAllListeners('env-install-progress');
  }
}

// ====== 一键安装 git ======
async function installGit() {
  clearEnvInstallLog();
  appendEnvInstallLog('开始安装 git（通过系统包管理器），请稍候...');
  showToast('正在通过系统包管理器安装 git，请稍候（可能需要几分钟）...', 'info');
  window.dshManager.removeAllListeners('env-install-progress');
  window.dshManager.onEnvInstallProgress((data) => {
    if (data && data.message) appendEnvInstallLog(data.message, data.level);
  });
  try {
    const result = await window.dshManager.installGit();
    if (result.success) {
      appendEnvInstallLog('✅ ' + (result.message || 'git 安装成功'), 'info');
      showToast('✅ ' + (result.message || 'git 安装成功'), 'success');
    } else {
      appendEnvInstallLog('❌ ' + (result.message || result.error || '未知错误'), 'error');
      showToast('❌ git 安装失败: ' + (result.message || result.error || '未知错误'), 'error');
    }
    await renderEnvStatus();
    await checkDSHStatus();
  } catch (err) {
    appendEnvInstallLog('❌ ' + err.message, 'error');
    showToast('❌ git 安装失败: ' + err.message, 'error');
  } finally {
    window.dshManager.removeAllListeners('env-install-progress');
  }
}

async function installDSH(tool = 'auto') {
  const btn = document.getElementById('installBtn');
  const progress = document.getElementById('installProgress');
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');

  if (state.installing) return;
  state.installing = true;
  btn.disabled = true;
  btn.textContent = '⏳ 安装中...';
  progress.style.display = 'block';
  fill.style.width = '0%';
  text.textContent = '正在准备安装...';

  try {
    // 读取版本号与镜像选择（若存在输入框）
    let version = null;
    let registry = null;
    const versionEl = document.getElementById('installVersion');
    const registryEl = document.getElementById('installRegistry');
    if (versionEl && versionEl.value.trim()) version = versionEl.value.trim();
    if (registryEl && registryEl.value) registry = registryEl.value;

    // 真实进度提示（由主进程 dsh:install-progress 事件驱动，不再模拟进度条）
    const toolLabel = tool === 'pnpm' ? 'pnpm' : tool === 'mirror' ? '镜像源' : tool === 'corepack' ? 'corepack' : '自动';
    text.textContent = `正在通过 ${toolLabel} 安装 DSH${version ? ` v${version}` : ''}（可能需要几分钟，请耐心等待）...`;
    fill.style.width = '30%';

    // 订阅主进程推送的安装日志，实时更新进度条
    window.dshManager.removeAllListeners('dsh:install-progress');
    window.dshManager.onInstallProgress((data) => {
      if (!data || !data.message) return;
      text.textContent = data.message;
      if (data.level === 'warn') {
        fill.style.width = '80%';
      } else if (data.level === 'error') {
        fill.style.width = '100%';
      } else {
        const current = parseInt(fill.style.width, 10) || 0;
        fill.style.width = Math.min(current + 15, 70) + '%';
      }
    });

    const result = await window.dshManager.installDSH(version, registry, tool);
    
    fill.style.width = '100%';
    text.textContent = `✅ DSH 安装成功！（通过 ${toolLabel}）`;

    showToast(`DSH ${result.version} 安装成功！`, 'success');
    await checkDSHStatus();
    renderInstallPage();
  } catch (err) {
    fill.style.width = '100%';
    const errMsg = err.message || '未知错误';
    // 检测常见的权限错误
    if (errMsg.includes('EACCES') || errMsg.includes('EPERM') || errMsg.includes('权限') || errMsg.includes('Access')) {
      text.innerHTML = `❌ 安装失败：权限不足<br><span style="font-size:12px;color:var(--text-dim);">请右键点击 DSH Manager，选择「以管理员身份运行」后重试</span>`;
      showToast('安装失败：权限不足，请以管理员身份运行', 'error');
    } else if (errMsg.includes('timeout') || errMsg.includes('TIMEOUT') || errMsg.includes('网络')) {
      text.innerHTML = `❌ 安装失败：网络超时<br><span style="font-size:12px;color:var(--text-dim);">请检查网络连接后重试，或选择「镜像源」安装</span>`;
      showToast('安装失败：网络超时，可尝试镜像源或 pnpm 安装', 'error');
    } else {
      text.textContent = '❌ 安装失败: ' + errMsg;
      showToast('安装失败: ' + errMsg, 'error');
    }
  } finally {
    state.installing = false;
    btn.disabled = false;
    btn.textContent = '📥 安装 DSH';
  }
}

// ====== 升级 DSH ======
async function upgradeDSH() {
  showToast('正在检查更新...', 'info');
  try {
    const update = await window.dshManager.checkDSHUpdate();
    if (update.hasUpdate) {
      showToast(`发现新版本: ${update.latest}`, 'info');
      if (confirm(`发现新版本 DSH ${update.latest}（当前: ${update.current}），是否升级？`)) {
        await window.dshManager.installDSH(null, null);
        showToast('DSH 升级成功！', 'success');
        await checkDSHStatus();
        renderInstallPage();
      }
    } else {
      showToast(`当前版本 ${update.current} 已是最新`, 'success');
    }
  } catch (err) {
    showToast('检查更新失败: ' + err.message, 'error');
  }
}

// ====== 系统诊断 ======
async function runDoctor() {
  try {
    showToast('正在诊断环境...', 'info');
    const results = await window.dshManager.doctorCheck();

    const statusIcon = (s) => s === 'ok' ? '✅' : s === 'warning' ? '⚠️' : '❌';
    const itemsHtml = results.map(r => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border);">
        <span>${statusIcon(r.status)} <strong>${r.name}</strong></span>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">${r.message}</p>
        ${r.fix ? `<p style="font-size:12px;color:var(--warning);margin-top:2px;">💡 ${r.fix}</p>` : ''}
      </div>
    `).join('');

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
      <div class="modal" style="min-width:520px;">
        <h3 class="modal-title">🩺 系统诊断</h3>
        <div class="modal-body">${itemsHtml}</div>
        <div class="modal-footer">
          <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  } catch (err) {
    showToast('诊断失败: ' + err.message, 'error');
  }
}

// ====== 卸载 DSH ======
async function uninstallDSH() {
  if (!confirm('确定要卸载 DSH 吗？此操作不会删除配置和数据文件。')) return;
  try {
    await window.dshManager.uninstallDSH();
    showToast('DSH 已卸载', 'success');
    state.dshInstalled = false;
    state.dshVersion = null;
    await checkDSHStatus();
    renderInstallPage();
  } catch (err) {
    showToast('卸载失败: ' + err.message, 'error');
  }
}

// ====== 插件管理页面 ======
// 诊断并一键修复插件树中的无效条目（恢复 dsh web 启动）
async function diagnoseAndFixPlugins() {
  showToast('正在诊断插件树...', 'info');
  try {
    const diag = await window.dshManager.diagnoseInvalidPlugins('web');
    if (!diag.invalid || diag.invalid.length === 0) {
      showToast('✅ 插件树健康，未发现无效条目', 'success');
      return;
    }

    const reasons = diag.invalid.map(p => `• ${p.id}: ${p.reason}`).join('\n');
    const ok = confirm(`检测到 ${diag.invalid.length} 个无效插件条目（可能导致 DSH 启动失败）：\n\n${reasons}\n\n是否一键移除？`);
    if (!ok) return;

    showToast('正在移除无效条目...', 'info');
    const result = await window.dshManager.fixInvalidPlugins('web');
    const parts = [];
    if (result.fixed?.length) parts.push(`已移除 ${result.fixed.length} 个：${result.fixed.map(f => f.id).join(', ')}`);
    if (result.failed?.length) parts.push(`失败 ${result.failed.length} 个：${result.failed.map(f => f.id).join(', ')}`);
    if (result.remaining?.length) parts.push(`仍有残留 ${result.remaining.length} 个（需手动处理）`);
    showToast('🩺 ' + (parts.join('；') || '处理完成'), result.failed?.length || result.remaining?.length ? 'warning' : 'success');
    renderPluginsPage();
  } catch (err) {
    showToast('诊断失败: ' + err.message, 'error');
  }
}

// 折叠/展开某个 bundle 分组
function toggleBundleGroup(groupId) {
  const bodyRows = document.querySelectorAll(`tr[data-bundle-body="${groupId}"]`);
  const chevron = document.querySelector(`[data-chevron="${groupId}"]`);
  let collapsed = false;
  bodyRows.forEach((row, i) => {
    const isHidden = row.style.display === 'none';
    row.style.display = isHidden ? '' : 'none';
    if (i === 0) collapsed = !isHidden; // 首行决定新状态：当前展开→收起
  });
  if (chevron) chevron.textContent = collapsed ? '▶' : '▼';
}

// 全部展开 / 全部收起
function toggleAllBundles(expand) {
  document.querySelectorAll('.plugin-item-row').forEach(row => {
    row.style.display = expand ? '' : 'none';
  });
  document.querySelectorAll('.bundle-chevron').forEach(c => {
    c.textContent = expand ? '▼' : '▶';
  });
}

async function renderPluginsPage() {
  const el = document.getElementById('pluginsContent');
  if (!el) return;

  let localPlugins = [];
  let composedPlugins = [];
  try {
    // 强制刷新：读取 DSH profile 中实际安装的插件（版本/描述/来源）
    localPlugins = await window.dshManager.getLocalPlugins(true);
  } catch {}
  try {
    // 完整组合插件树（等同 DSH 设置页展示：含核心框架 + bundle 展开子插件 + 启用状态）
    composedPlugins = await window.dshManager.getComposedPlugins('web', true);
  } catch {}

  // 版本信息合并：composed 条目无版本号，从 localPlugins 按 id 补齐
  const localById = new Map(localPlugins.map(p => [p.id, p]));
  const merged = composedPlugins.map(c => {
    const lp = localById.get(c.id);
    return { ...c, version: lp?.version || null, type: lp?.type || (c.core ? 'core' : 'dsh') };
  });

  // 按 bundle 分组：用户 bundle（非核心）在前，核心框架在后
  const byBundle = new Map();
  for (const p of merged) {
    const key = p.bundle || (p.core ? '@deepseek-ai/dsh-base' : 'unknown');
    if (!byBundle.has(key)) byBundle.set(key, []);
    byBundle.get(key).push(p);
  }
  const bundleGroups = [...byBundle.entries()].sort((a, b) => {
    const aCore = a[0].startsWith('@deepseek-ai/');
    const bCore = b[0].startsWith('@deepseek-ai/');
    return (aCore === bCore) ? 0 : (aCore ? 1 : -1);
  });
  const totalPlugins = merged.length;
  const userBundles = bundleGroups.filter(([b]) => !b.startsWith('@deepseek-ai/'));
  const coreBundles = bundleGroups.filter(([b]) => b.startsWith('@deepseek-ai/'));

  // 默认折叠策略：核心框架组收起（数量大），用户 bundle 展开
  const renderBundleRows = (groups, defaultCollapsed = false) => groups.map(([bundle, items]) => {
    const groupId = 'bundle-' + bundle.replace(/[^a-zA-Z0-9]/g, '-');
    return `
    <tr class="plugin-bundle-row" data-bundle-row="${groupId}" onclick="toggleBundleGroup('${groupId}')" style="cursor:pointer;">
      <td colspan="5" style="font-weight:600;font-size:12px;color:var(--text-secondary);background:var(--bg-hover);">
        <span class="bundle-chevron" data-chevron="${groupId}">${defaultCollapsed ? '▶' : '▼'}</span>
        📦 ${escapeHtml(bundle)}
        <span style="font-weight:400;color:var(--text-dim);">（${items.length}）</span>
      </td>
    </tr>
    ${items.map(p => `
      <tr class="plugin-item-row" data-bundle-body="${groupId}" style="${defaultCollapsed ? 'display:none;' : ''}">
        <td><strong>${escapeHtml(p.name || p.id)}</strong>${p.core ? ' <span class="badge badge-gray">核心</span>' : ''}</td>
        <td><span class="badge badge-blue">${p.version || '-'}</span></td>
        <td style="color:var(--text-dim);font-size:12px;">${p.type === 'github' ? 'GitHub' : p.type === 'core' ? '框架' : 'npm'}</td>
        <td><span class="badge ${p.enabled !== false ? 'badge-green' : 'badge-gray'}">${p.enabled !== false ? '已启用' : '已禁用'}</span></td>
        <td>
          ${p.core
            ? '<span style="font-size:11px;color:var(--text-dim);">系统插件</span>'
            : `<button class="btn btn-sm btn-ghost" onclick="togglePlugin('${escapeAttr(p.id)}', ${p.enabled !== false})">${p.enabled !== false ? '禁用' : '启用'}</button>
               <button class="btn btn-sm btn-ghost" onclick="uninstallPlugin('${escapeAttr(p.id)}')">卸载</button>`}
        </td>
      </tr>
    `).join('')}
  `;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="showMarketplace()">
        🛒 浏览插件市场
      </button>
      <button class="btn btn-secondary" onclick="checkPluginUpdates()">
        🔄 检查更新
      </button>
      <button class="btn btn-ghost" onclick="diagnoseAndFixPlugins()" title="扫描插件树中无效条目（如已注册但包缺失/非合法 bundle），一键移除以恢复 DSH 启动">🩺 诊断并修复</button>
      <button class="btn btn-ghost" onclick="toggleAllBundles(true)" title="展开所有 bundle 分组">📂 全部展开</button>
      <button class="btn btn-ghost" onclick="toggleAllBundles(false)" title="收起所有 bundle 分组">📁 全部收起</button>
      <span style="font-size:12px;color:var(--text-dim);">共 ${totalPlugins} 个插件（用户 bundle ${userBundles.length} 组 · 核心框架 ${coreBundles.length} 组）</span>
      <div class="search-box" style="margin-left:auto;">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input type="text" placeholder="搜索插件..." oninput="searchPlugins(this.value)">
      </div>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <span class="card-title">📥 安装插件</span>
      </div>
      <div class="card-body">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
          <input class="input" id="pluginSource" placeholder="插件来源：github:owner/repo · npm:包名 · git:URL · file:本地路径" style="flex:1;min-width:220px;">
          <button class="btn btn-sm btn-primary" onclick="installPluginSource()">⬇️ 安装</button>
          <button class="btn btn-sm btn-secondary" onclick="pickLocalPluginDir()">📁 选择本地目录</button>
          <button class="btn btn-sm btn-ghost" onclick="toggleBatchInstall()">📚 批量安装</button>
        </div>
        <div id="batchInstallBox" style="display:none;">
          <textarea class="input" id="batchSources" rows="3" placeholder="每行一个插件来源，如：&#10;github:linhut/gongwen-skill&#10;npm:@linxin666/dsh-web-ui-all"></textarea>
          <div style="margin-top:8px;">
            <button class="btn btn-sm btn-primary" onclick="runBatchInstall()">🚀 开始批量安装</button>
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-dim);margin-top:8px;">支持来源：<code>github:owner/repo</code> · <code>npm:包名</code> · <code>git:仓库URL</code> · <code>file:本地目录</code></p>
      </div>
    </div>
    <div id="pluginList">
      ${totalPlugins === 0
        ? `<div class="empty-state">
             <div class="empty-state-icon">🔌</div>
             <div class="empty-state-title">暂无已安装的插件</div>
             <div class="empty-state-desc">浏览插件市场，发现并安装你需要的插件</div>
             <button class="btn btn-primary" onclick="showMarketplace()">🛒 浏览插件市场</button>
           </div>`
        : `<div class="table-wrap">
             <table class="table">
               <thead>
                 <tr>
                   <th>插件名称</th>
                   <th>版本</th>
                   <th>来源</th>
                   <th>状态</th>
                   <th>操作</th>
                 </tr>
               </thead>
               <tbody>
                 ${renderBundleRows(userBundles, false)}
                 ${renderBundleRows(coreBundles, true)}
               </tbody>
             </table>
           </div>`
      }
    </div>
    <div id="marketplaceSection" style="display:none;margin-top:24px;">
      <div class="card">
        <div class="card-header">
          <span class="card-title">🛒 插件市场</span>
          <button class="btn btn-sm btn-ghost" onclick="closeMarketplace()">✕ 关闭</button>
        </div>
        <div class="card-body">
          <div class="search-box" style="max-width:100%;margin-bottom:12px;">
            <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input type="text" id="marketplaceSearch" placeholder="搜索插件 (如: agent, file, web)..." onkeydown="if(event.key==='Enter')loadMarketplace(this.value)">
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">
            <span style="font-size:12px;color:var(--text-dim);">分类:</span>
            <button class="btn btn-sm market-cat ${state.marketCategory === 'all' ? 'btn-primary' : 'btn-secondary'}" data-cat="all" onclick="setMarketCategory('all')">全部</button>
            <button class="btn btn-sm market-cat ${state.marketCategory === 'recommended' ? 'btn-primary' : 'btn-secondary'}" data-cat="recommended" onclick="setMarketCategory('recommended')">⭐ 推荐</button>
            <button class="btn btn-sm market-cat ${state.marketCategory === 'ui' ? 'btn-primary' : 'btn-secondary'}" data-cat="ui" onclick="setMarketCategory('ui')">🖥️ UI 皮肤</button>
            <button class="btn btn-sm market-cat ${state.marketCategory === 'tool' ? 'btn-primary' : 'btn-secondary'}" data-cat="tool" onclick="setMarketCategory('tool')">🔧 工具</button>
            <button class="btn btn-sm market-cat ${state.marketCategory === 'writing' ? 'btn-primary' : 'btn-secondary'}" data-cat="writing" onclick="setMarketCategory('writing')">📝 写作</button>
            <span style="margin-left:auto;display:flex;align-items:center;gap:6px;">
              <span style="font-size:12px;color:var(--text-dim);">排序:</span>
              <select class="input" id="marketSort" style="width:auto;padding:4px 8px;" onchange="setMarketSort(this.value)">
                <option value="top">⭐ 热门优先</option>
                <option value="new">🆕 最新优先</option>
              </select>
            </span>
          </div>
          <div id="marketplaceGrid" class="grid-3">
            <div class="skeleton" style="height:120px;"></div>
            <div class="skeleton" style="height:120px;"></div>
            <div class="skeleton" style="height:120px;"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * 关闭安装进度模态框
 * 安装将在后台继续，完成后会自动刷新页面
 */
function closeInstallProgressModal() {
  const overlay = document.querySelector('.modal-overlay.active');
  if (overlay && overlay.querySelector('#installCloseBtn')) {
    overlay.remove();
  }
}

// ====== 插件市场 ======
async function showMarketplace() {
  const section = document.getElementById('marketplaceSection');
  section.style.display = 'block';
  // 加载本地插件列表，用于市场卡片"已安装"标记（强制刷新，避免缓存不同步）
  try {
    state.localPlugins = await window.dshManager.getLocalPlugins(true);
  } catch {
    state.localPlugins = [];
  }
  await loadMarketplace('');
}

function closeMarketplace() {
  document.getElementById('marketplaceSection').style.display = 'none';
}

// ====== 市场分类/排序 ======
function setMarketCategory(cat) {
  state.marketCategory = cat;
  document.querySelectorAll('.market-cat').forEach(b => {
    b.className = `btn btn-sm market-cat ${b.dataset.cat === cat ? 'btn-primary' : 'btn-secondary'}`;
  });
  renderMarketplaceGrid();
}

function setMarketSort(sort) {
  state.marketSort = sort;
  renderMarketplaceGrid();
}

function renderMarketplaceGrid() {
  const grid = document.getElementById('marketplaceGrid');
  if (!grid) return;
  const results = state.marketResults || [];
  const query = (document.getElementById('marketplaceSearch')?.value || '').trim().toLowerCase();

  // 关键词过滤
  let filtered = query
    ? results.filter(p =>
        (p.fullName || '').toLowerCase().includes(query) ||
        (p.description || '').toLowerCase().includes(query) ||
        (p.topics || []).some(t => t.toLowerCase().includes(query)))
    : [...results];

  // 分类过滤
  if (state.marketCategory !== 'all') {
    filtered = filtered.filter(p => {
      if (state.marketCategory === 'recommended') return p.recommended;
      if (state.marketCategory === 'ui') return (p.topics || []).some(t => /web-ui|skin|theme|ui/i.test(t));
      if (state.marketCategory === 'tool') return (p.topics || []).some(t => /tool|util|helper|cli|ssh/i.test(t));
      if (state.marketCategory === 'writing') return (p.topics || []).some(t => /writ|gongwen|doc|article|report/i.test(t));
      return true;
    });
  }

  // 排序
  if (state.marketSort === 'new') {
    filtered.sort((a, b) => (b.pushedAt || b.createdAt || '').localeCompare(a.pushedAt || a.createdAt || ''));
  } else {
    filtered.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">🔍</div><div class="empty-state-title">没有符合条件的插件</div><div class="empty-state-desc">试试切换分类或调整搜索关键词</div></div>';
    return;
  }

  grid.innerHTML = filtered.map(p => renderPluginCard(p)).join('') +
    `<div style="grid-column:1/-1;text-align:center;padding:10px;color:var(--text-dim);font-size:12px;border-top:1px solid var(--border);margin-top:8px;">共 ${filtered.length} 个插件</div>`;
}

async function loadMarketplace(query) {
  const grid = document.getElementById('marketplaceGrid');
  grid.innerHTML = '<div class="skeleton" style="height:120px;"></div><div class="skeleton" style="height:120px;"></div><div class="skeleton" style="height:120px;"></div>';

  // 本地预置的精选插件（当 GitHub API 不可用时作为降级展示）
  const FALLBACK_PLUGINS = [
    {
      fullName: 'linhut/gongwen-skill',
      stars: 128,
      forks: 34,
      description: '公文写作辅助技能 - 支持各类公文格式（通知、报告、请示、函件等），智能生成符合国家标准的公文内容，大幅提升办公效率。',
      language: 'JavaScript',
      topics: ['dsh-plugin', 'gongwen', 'writing', 'recommended'],
      recommended: true,
    },
    {
      fullName: 'deepseek-ai/deepseek-harness',
      stars: 0,
      forks: 0,
      description: 'DeepSeek Harness - AI 应用开发框架，支持插件化扩展。',
      language: 'TypeScript',
      topics: ['dsh', 'deepseek-harness', 'ai'],
      recommended: false,
    },
    {
      fullName: 'codeAnqiang-ma/dsh-superpowers',
      stars: 3,
      forks: 0,
      description: 'Superpowers (obra/superpowers) 作为 DeepSeek Harness 插件：内置 brainstorming、using-superpowers、writing-skills、TDD、调试与代码审查等 14 个方法论技能，并在会话中持续注入 using-superpowers 引导。',
      language: 'JavaScript',
      topics: ['agent-skills', 'dsh-plugin', 'deepseek-harness', 'dsh', 'skills', 'superpowers', 'tdd', 'code-review', 'recommended'],
      recommended: true,
    },
    {
      fullName: 'linhut/dsh-skills',
      stars: 1,
      forks: 0,
      description: '实用技能合集 - 内置 brainstorming、using-superpowers、finishing-a-development-branch、writing-skills、github-actions-docs、how-it-works 六个开箱即用的方法论技能，模型可通过 skill 工具按需加载。',
      language: 'JavaScript',
      topics: ['dsh-plugin', 'dsh', 'skills', 'deepseek-harness', 'superpowers', 'brainstorming', 'recommended'],
      recommended: true,
    },
  ];

  try {
    let results;
    try {
      results = await window.dshManager.searchPlugins(query, 1);
    } catch (e) {
      console.warn('插件市场 API 请求失败，使用精选插件降级:', e.message);
      results = null;
    }

    // 如果 API 返回为空或失败，使用精选插件
    if (!results || results.length === 0) {
      const fallback = query
        ? FALLBACK_PLUGINS.filter(p => p.fullName.toLowerCase().includes(query.toLowerCase()))
        : FALLBACK_PLUGINS;

      if (fallback.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">🔍</div><div class="empty-state-title">未找到匹配的插件</div><div class="empty-state-desc">请更换关键词搜索，或检查网络连接后刷新</div></div>';
        return;
      }
      state.marketResults = fallback;

      renderMarketplaceGrid();
      // 添加提示
      grid.innerHTML += '<div style="grid-column:1/-1;text-align:center;padding:12px;color:var(--text-dim);font-size:12px;border-top:1px solid var(--border);margin-top:8px;">⚠️ 无法连接到 GitHub API，以上为精选插件推荐。请检查网络后 <a href="javascript:void(0)" onclick="showMarketplace()" style="color:var(--primary-light);">刷新重试</a></div>';
      return;
    }

    state.marketResults = results;
    renderMarketplaceGrid();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">加载失败</div><div class="empty-state-desc">${err.message || '请检查网络连接后刷新'}</div></div>`;
  }
}

function renderPluginCard(p) {
  const isInstalled = (state.localPlugins || []).some(l => {
    const lName = (l.fullName || l.source || '').toLowerCase();
    const pName = (p.fullName || '').toLowerCase();
    return lName.includes(pName) || pName.includes(lName) || (l.id && pName.includes(l.id.toLowerCase()));
  });
  const updated = p.pushedAt || p.updatedAt || p.createdAt;
  const updatedStr = updated ? new Date(updated).toLocaleDateString() : '';
  const npmVersion = p._source === 'npm' && p.version ? p.version : '';
  return `
    <div class="card" style="cursor:pointer;" onclick="showPluginDetails('${escapeAttr(p.fullName)}')">
      <div class="card-header" style="margin-bottom:8px;flex-wrap:wrap;">
        <span class="card-title" style="font-size:13px;display:flex;align-items:center;gap:6px;">
          ${escapeHtml(p.fullName)}
          ${p._source === 'npm' ? '<span class="badge badge-gray" title="来源：npm registry">📦 npm</span>' : ''}
          ${p.recommended ? '<span class="badge badge-recommended" style="background:linear-gradient(135deg,#F59E0B,#D97706);color:white;font-size:10px;padding:1px 6px;border-radius:3px;">⭐ 推荐</span>' : ''}
          ${isInstalled ? '<span class="badge badge-green">✓ 已安装</span>' : ''}
        </span>
        <span style="font-size:13px;color:var(--warning);font-weight:700;">★ ${p.stars}</span>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.4;">${escapeHtml((p.description || '暂无描述').slice(0, 80))}</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">
        ${p.language ? `<span class="badge badge-gray">${escapeHtml(p.language)}</span>` : ''}
        ${npmVersion ? `<span class="badge badge-blue" title="npm 版本">v${escapeHtml(npmVersion)}</span>` : ''}
        ${(p.topics || []).slice(0, 3).map(t => `<span class="badge badge-blue">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;color:var(--text-dim);">🍴 ${p.forks}  ${renderLogoIcon(12)} ${(p.stars || 0) + (p.forks || 0)} 活跃${updatedStr ? `  · 更新 ${updatedStr}` : ''}</span>
        <span style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();showPluginDetails('${escapeAttr(p.fullName)}')">👁 详情</button>
          <button class="btn btn-sm ${isInstalled ? 'btn-secondary' : 'btn-primary'}" onclick="event.stopPropagation();installMarketPlugin('${escapeAttr(p.fullName)}')">
            ${isInstalled ? '✓ 已装' : '📥 安装'}
          </button>
        </span>
      </div>
    </div>
  `;
}

// ====== 插件详情模态框 ======
async function showPluginDetails(fullName) {
  // 先从缓存中找基础信息，立即展示
  const p = (state.marketResults || []).find(x => x.fullName === fullName);
  if (!p) {
    showToast('未找到插件信息', 'error');
    return;
  }
  const ghUrl = p.url || (fullName.includes('/') ? `https://github.com/${fullName}` : '');

  // 展示基础卡片
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal" style="min-width:560px;max-width:720px;">
      <h3 class="modal-title">${renderLogoIcon(18)} ${escapeHtml(p.fullName)} ${p.recommended ? '<span class="badge badge-recommended" style="background:linear-gradient(135deg,#F59E0B,#D97706);color:white;font-size:10px;padding:1px 6px;border-radius:3px;">⭐ 推荐</span>' : ''}</h3>
      <div class="modal-body">
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:13px;color:var(--text-dim);">
          <span>⭐ <strong>${p.stars}</strong></span>
          <span>🍴 <strong>${p.forks}</strong></span>
          ${p.language ? `<span>🔤 ${escapeHtml(p.language)}</span>` : ''}
          ${p.license ? `<span>📄 ${escapeHtml(p.license)}</span>` : ''}
          ${p.issues ? `<span>🐞 ${p.issues}</span>` : ''}
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;color:var(--text-dim);">
          ${p.createdAt ? `<span>🗓️ 创建 ${new Date(p.createdAt).toLocaleDateString()}</span>` : ''}
          ${p.pushedAt ? `<span>🔄 更新 ${new Date(p.pushedAt).toLocaleDateString()}</span>` : ''}
          ${p.homepage ? `<span>🏠 <a href="javascript:void(0)" onclick="window.dshManager.openExternal('${escapeAttr(p.homepage)}')" style="color:var(--primary-light);">主页</a></span>` : ''}
        </div>
        <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:12px;">${escapeHtml(p.description || '暂无描述')}</p>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">
          ${(p.topics || []).map(t => `<span class="badge badge-blue">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div id="pluginDetailExtra">
          <p style="color:var(--text-dim);font-size:13px;">⏳ 正在加载 README 与版本信息...</p>
        </div>
      </div>
      <div class="modal-footer">
        ${ghUrl ? `<button class="btn btn-secondary" onclick="window.dshManager.openExternal('${ghUrl}')">🌐 项目地址</button>` : ''}
        <button class="btn btn-primary" onclick="installMarketPlugin('${escapeAttr(p.fullName)}');document.querySelector('.modal-overlay.active')?.remove();">📥 安装</button>
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // 异步加载详情（README + releases + package.json 信息）
  try {
    const info = await window.dshManager.getPluginDetails(fullName);
    const extraEl = document.getElementById('pluginDetailExtra');
    if (!extraEl) return;

    let html = '';
    // package.json 信息
    if (info.packageJson && Object.keys(info.packageJson).length > 0) {
      html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">📦 ${info.packageJson.npmPackage || ''}${info.packageJson.version ? ` @ ${info.packageJson.version}` : ''}${info.packageJson.dshPlugin ? ' · dsh-plugin' : ''}${info.packageJson.cordisPlugin ? ' · cordis' : ''}</div>`;
    }
    // README 图片预览（AppStore 风格截图展示，最多 3 张）
    if (info.readme) {
      const imgMatches = [...info.readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]).filter(u => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u)).slice(0, 3);
      if (imgMatches.length > 0) {
        html += `<div style="margin-bottom:12px;">
          <p style="font-size:12px;color:var(--text-dim);margin-bottom:6px;"><strong>🖼️ 预览</strong></p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${imgMatches.map(u => {
              const src = u.startsWith('http') ? u : `https://raw.githubusercontent.com/${fullName}/main/${u.replace(/^\.?\//, '')}`;
              return `<img src="${src}" style="max-width:100%;max-height:160px;border-radius:var(--radius-sm);border:1px solid var(--border);" loading="lazy" onerror="this.style.display='none'">`;
            }).join('')}
          </div>
        </div>`;
      }
      const plain = info.readme.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`~\[\]()!-]/g, '').replace(/\s+/g, ' ').trim();
      html += `<div style="font-size:12px;color:var(--text-muted);line-height:1.7;background:var(--bg-primary);padding:12px;border-radius:var(--radius-sm);max-height:240px;overflow-y:auto;margin-bottom:12px;">${plain.slice(0, 600)}${plain.length > 600 ? '...' : ''}</div>`;
    }
    // 最近版本
    if (info.releases && info.releases.length > 0) {
      html += `<div style="font-size:12px;color:var(--text-dim);">
        <p style="margin-bottom:4px;"><strong>🏷️ 最近版本</strong></p>
        ${info.releases.slice(0, 5).map(r => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
            <span>${r.tag || r.name}</span>
            <span>${r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : ''}</span>
          </div>`).join('')}
      </div>`;
    }
    extraEl.innerHTML = html || '<p style="color:var(--text-dim);font-size:13px;">未获取到更多信息</p>';
  } catch (err) {
    const extraEl = document.getElementById('pluginDetailExtra');
    if (extraEl) {
      extraEl.innerHTML = `<p style="color:var(--text-dim);font-size:12px;">⚠️ 详情加载失败：${err.message || '网络错误'}（可在项目地址查看）</p>`;
    }
  }
}

async function searchPlugins(query) {
  // 过滤本地插件列表
  const listEl = document.getElementById('pluginList');
  if (!listEl) return;

  let localPlugins = [];
  try {
    localPlugins = await window.dshManager.getLocalPlugins();
  } catch {}

  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? localPlugins.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.id || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.source || '').toLowerCase().includes(q)
      )
    : localPlugins;

  if (q && filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">未找到匹配 "{{ESCAPED}}" 的插件</div>
        <div class="empty-state-desc">换个关键词试试</div>
      </div>`.replace('{{ESCAPED}}', query);
    return;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔌</div>
        <div class="empty-state-title">暂无已安装的插件</div>
        <div class="empty-state-desc">浏览插件市场，发现并安装你需要的插件</div>
        <button class="btn btn-primary" onclick="showMarketplace()">🛒 浏览插件市场</button>
      </div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>插件名称</th>
            <th>版本</th>
            <th>来源</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(p => `
            <tr>
              <td><strong>${p.name || p.id}</strong></td>
              <td><span class="badge badge-blue">${p.version}</span></td>
              <td style="color:var(--text-dim);font-size:12px;">${p.type === 'github' ? 'GitHub' : 'npm'}</td>
              <td><span class="badge ${p.enabled !== false ? 'badge-green' : 'badge-gray'}">${p.enabled !== false ? '已启用' : '已禁用'}</span></td>
              <td>
                <button class="btn btn-sm btn-ghost" onclick="togglePlugin('${escapeAttr(p.id)}', ${p.enabled !== false})">${p.enabled !== false ? '禁用' : '启用'}</button>
                <button class="btn btn-sm btn-ghost" onclick="uninstallPlugin('${escapeAttr(p.id)}')">卸载</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${q ? `<p style="margin-top:12px;color:var(--text-dim);font-size:13px;">找到 ${filtered.length} 个匹配插件</p>` : ''}
  `;
}

/**
 * 显示安装进度模态框
 * @param {string} label - 安装目标名称
 * @param {string} title - 标题
 * @returns {{ update: (msg, level) => void, done: (msg, type) => void }}
 */
function showInstallProgressModal(label, title = '安装') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = `
    <div class="modal" style="min-width:420px;max-width:520px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <h3 class="modal-title" style="margin-bottom:0;">📥 ${title}</h3>
        <button class="btn btn-sm btn-ghost" id="installCloseX" onclick="closeInstallProgressModal()" title="关闭窗口（安装将在后台继续）" style="min-width:28px;padding:1px 8px;font-size:14px;line-height:1.4;">✕</button>
      </div>
      <div class="modal-body" style="text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;" id="installSpinner">⏳</div>
        <p style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text-primary);" id="installLabel">${label}</p>
        <div id="installProgressBar" style="width:100%;height:4px;background:var(--bg-primary);border-radius:2px;margin-bottom:12px;overflow:hidden;">
          <div style="width:30%;height:100%;background:var(--primary-light);border-radius:2px;animation:progressIndeterminate 1.5s ease-in-out infinite;"></div>
        </div>
        <div id="installMessage" style="font-size:12px;color:var(--text-dim);min-height:40px;line-height:1.5;">
          正在准备安装...
        </div>
        <p style="font-size:11px;color:var(--text-dim);margin-top:4px;">安装期间可随时关闭此窗口，安装将在后台继续。</p>
      </div>
      <div class="modal-footer" style="justify-content:center;">
        <button class="btn btn-ghost" id="installCloseBtn" onclick="closeInstallProgressModal()">后台继续（关闭窗口）</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  return {
    update: (msg, level = 'info') => {
      const msgEl = document.getElementById('installMessage');
      const spinner = document.getElementById('installSpinner');
      if (msgEl) msgEl.textContent = msg;
      if (spinner) spinner.textContent = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '⏳';
    },
    done: (msg, type = 'success') => {
      const spinner = document.getElementById('installSpinner');
      const bar = document.getElementById('installProgressBar');
      const closeBtn = document.getElementById('installCloseBtn');
      const msgEl = document.getElementById('installMessage');
      if (spinner) spinner.textContent = type === 'success' ? '✅' : '❌';
      if (bar) bar.innerHTML = '<div style="width:100%;height:100%;background:' + (type === 'success' ? 'var(--success, #22C55E)' : 'var(--error, #EF4444)') + ';border-radius:2px;"></div>';
      if (msgEl) msgEl.textContent = msg;
      if (closeBtn) { closeBtn.style.display = ''; closeBtn.textContent = '关闭'; }
    }
  };
}

async function installMarketPlugin(fullName) {
  const p = (state.marketResults || []).find(x => x.fullName === fullName);
  const source = (p && p._source === 'npm') ? `npm:${fullName}` : `github:${fullName}`;
  const modal = showInstallProgressModal(source, '插件安装');
  try {
    // 订阅主进程推送的插件安装进度
    window.dshManager.removeAllListeners('plugin-install-progress');
    window.dshManager.onPluginInstallProgress((data) => {
      if (data && data.message) modal.update(data.message, data.level);
    });
    const result = await window.dshManager.installPlugin(source);
    modal.done(`✅ 插件 ${result.name} 安装成功！`, 'success');
    // 刷新本地插件列表，同步市场卡片安装状态（强制刷新）
    try { state.localPlugins = await window.dshManager.getLocalPlugins(true); } catch { state.localPlugins = []; }
    const section = document.getElementById('marketplaceSection');
    if (section && section.style.display !== 'none') renderMarketplaceGrid();
    renderPluginsPage();
  } catch (err) {
    modal.done('❌ 安装失败: ' + err.message, 'error');
  } finally {
    window.dshManager.removeAllListeners('plugin-install-progress');
  }
}

// ====== 插件来源直装 ======
async function installPluginSource() {
  const input = document.getElementById('pluginSource');
  const source = input?.value.trim();
  if (!source) { showToast('请输入插件来源', 'error'); return; }
  const modal = showInstallProgressModal(source, '插件安装');
  try {
    window.dshManager.removeAllListeners('plugin-install-progress');
    window.dshManager.onPluginInstallProgress((data) => {
      if (data && data.message) modal.update(data.message, data.level);
    });
    const result = await window.dshManager.installPlugin(source);
    modal.done(`✅ 插件 ${result.name} 安装成功！`, 'success');
    if (input) input.value = '';
    try { state.localPlugins = await window.dshManager.getLocalPlugins(true); } catch { state.localPlugins = []; }
    const section2 = document.getElementById('marketplaceSection');
    if (section2 && section2.style.display !== 'none') renderMarketplaceGrid();
    renderPluginsPage();
  } catch (err) {
    modal.done('❌ 安装失败: ' + err.message, 'error');
  } finally {
    window.dshManager.removeAllListeners('plugin-install-progress');
  }
}

// ====== 选择本地插件目录 ======
async function pickLocalPluginDir() {
  try {
    const dir = await window.dshManager.pickPluginDir();
    if (!dir) return; // 用户取消
    const input = document.getElementById('pluginSource');
    if (input) input.value = `file:${dir}`;
    showToast(`已选择: ${dir}，点击「安装」开始安装`, 'info');
  } catch (err) {
    showToast('选择目录失败: ' + err.message, 'error');
  }
}

// ====== 批量安装 ======
function toggleBatchInstall() {
  const box = document.getElementById('batchInstallBox');
  if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

async function runBatchInstall() {
  const textarea = document.getElementById('batchSources');
  const raw = textarea?.value || '';
  const sources = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (sources.length === 0) { showToast('请输入至少一个插件来源', 'error'); return; }

  const modal = showInstallProgressModal(sources.length + ' 个插件', '批量安装');
  try {
    window.dshManager.removeAllListeners('plugin-install-progress');
    window.dshManager.onPluginInstallProgress((data) => {
      if (data && data.message) modal.update(data.message, data.level);
    });
    const results = await window.dshManager.batchInstallPlugins(sources);
    const ok = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);
    const msg = `批量安装完成：${ok}/${results.length} 成功${failed.length ? `，${failed.length} 失败` : ''}`;
    modal.done(msg, failed.length ? 'warning' : 'success');
    if (failed.length > 0) {
      const detail = failed.map(r => `${r.source}: ${r.error || '未知错误'}`).join('\n');
      modal.update('失败详情:\n' + detail, 'error');
    }
    try { state.localPlugins = await window.dshManager.getLocalPlugins(true); } catch { state.localPlugins = []; }
    const section3 = document.getElementById('marketplaceSection');
    if (section3 && section3.style.display !== 'none') renderMarketplaceGrid();
    renderPluginsPage();
  } catch (err) {
    modal.done('❌ 批量安装失败: ' + err.message, 'error');
  } finally {
    window.dshManager.removeAllListeners('plugin-install-progress');
  }
}

async function uninstallPlugin(id) {
  if (!confirm(`确定要卸载插件 "${id}" 吗？`)) return;
  try {
    await window.dshManager.uninstallPlugin(id);
    showToast('插件已卸载', 'success');
    renderPluginsPage();
  } catch (err) {
    showToast('卸载失败: ' + err.message, 'error');
  }
}

async function togglePlugin(id, currentlyEnabled) {
  try {
    if (currentlyEnabled) {
      await window.dshManager.disablePlugin(id);
      showToast(`插件 ${id} 已禁用`, 'success');
    } else {
      await window.dshManager.enablePlugin(id);
      showToast(`插件 ${id} 已启用`, 'success');
    }
    renderPluginsPage();
  } catch (err) {
    showToast('操作失败: ' + err.message, 'error');
  }
}

async function checkPluginUpdates() {
  try {
    showToast('正在检查插件更新...', 'info');
    const updates = await window.dshManager.checkPluginUpdates();
    const hasUpdates = updates.filter(u => u.hasUpdate);
    if (hasUpdates.length === 0) {
      showToast('所有插件已是最新', 'success');
    } else {
      showToast(`发现 ${hasUpdates.length} 个插件可更新`, 'warning');
    }
  } catch (err) {
    showToast('检查失败: ' + err.message, 'error');
  }
}

// ====== 技能管理页面 ======
async function renderSkillsPage() {
  const el = document.getElementById('skillsContent');
  if (!el) return;
  try {
    const [skills, stats] = await Promise.all([
      window.dshManager.skillsList({}),
      window.dshManager.skillsStats()
    ]);
    const q = (state.skillsQuery || '').toLowerCase();
    const filtered = skills.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) || (s.whenToUse || '').toLowerCase().includes(q));
    const userSkills = filtered.filter(s => s.source === 'user' || s.source === 'custom');
    const bundledSkills = filtered.filter(s => s.source === 'bundled' || s.source === 'project');
    el.innerHTML = [
      '<div class="page-toolbar">',
      '  <div class="search-box">',
      '    <input id="skillsSearch" type="text" placeholder="搜索技能..." value="' + escSkillHtml(state.skillsQuery || '') + '"',
      '      oninput="state.skillsQuery=this.value; renderSkillsPage()">',
      '  </div>',
      '  <div class="btn-group">',
      '    <button class="btn btn-primary" onclick="openCreateSkill()">＋ 新建技能</button>',
      '    <button class="btn" onclick="openImportSkillDialog()">⬇ GitHub 导入</button>',
      '    <button class="btn" onclick="importSkillFromDir()">📂 目录导入</button>',
      '  </div>',
      '</div>',
      '<div class="inline-stats">',
      '  <span class="inline-stat"><b>' + stats.total + '</b> 全部</span>',
      '  <span class="inline-stat"><b>' + stats.active + '</b> 生效</span>',
      '  <span class="inline-stat"><b>' + stats.shadowed + '</b> 被覆盖</span>',
      '  <span class="inline-stat"><b>' + (stats.bySource.user || 0) + '</b> 用户</span>',
      '  <span class="inline-stat"><b>' + (stats.bySource.bundled || 0) + '</b> 内置</span>',
      '</div>',
      renderSkillSection('用户 / 自定义技能', userSkills, true),
      renderSkillSection('内置 / 项目技能', bundledSkills, false),
    ].join('\n');
  } catch (err) {
    el.innerHTML = '<div class="empty-state"><p>❌ 技能加载失败: ' + escSkillHtml(err.message) + '</p>'
      + '<button class="btn btn-primary" onclick="renderSkillsPage()">重试</button></div>';
  }
}
function escSkillHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function renderSkillSection(title, skills, editable) {
  if (!skills.length) {
    return '<div class="card"><div class="card-header"><span class="card-title">' + escSkillHtml(title) + '</span></div>'
      + '<div class="empty-state"><p>暂无技能</p></div></div>';
  }
  return '<div class="card">'
    + '<div class="card-header"><span class="card-title">' + escSkillHtml(title) + '</span>'
    + '<span class="badge badge-info">' + skills.length + '</span></div>'
    + skills.map(skillCardHtml).join('')
    + '</div>';
}
function skillCardHtml(s) {
  const shadowed = s.shadowed ? ' skill-shadowed' : '';
  const shadowBadge = s.shadowed ? '<span class="badge badge-warning">被覆盖</span>' : '';
  const sourceBadge = '<span class="badge badge-' + escSkillHtml(s.source) + '">' + escSkillHtml(s.sourceLabel || s.source) + '</span>';
  const disabled = s.shadowed ? ' disabled' : '';
  const whenHtml = s.whenToUse ? '<div class="skill-when"><strong>适用：</strong>' + escSkillHtml(s.whenToUse) + '</div>' : '';
  const delBtn = editable && !s.shadowed ? '<button class="btn btn-sm btn-danger" onclick="deleteSkill(\'' + s.name + '\')">删除</button>' : '';
  return '<div class="skill-card' + shadowed + '">'
    + '<div class="skill-card-main">'
    + '  <div class="skill-card-head">'
    + '    <span class="skill-name">' + escSkillHtml(s.name) + '</span>'
    + '    ' + sourceBadge + shadowBadge
    + '  </div>'
    + '  <div class="skill-desc">' + escSkillHtml(s.description || '暂无描述') + '</div>'
    + '  ' + whenHtml
    + '  <div class="skill-preview">' + escSkillHtml(s.bodyPreview || '') + '</div>'
    + '</div>'
    + '<div class="skill-card-actions">'
    + '  <label class="switch-label"><input type="checkbox" ' + (s.modelInvocable ? 'checked' : '') + ' ' + disabled + ' onchange="toggleSkillInvocation(\'' + s.name + '\', \'model\', this.checked)">'
    + '    <span class="switch"></span> 模型可调用</label>'
    + '  <label class="switch-label"><input type="checkbox" ' + (s.userInvocable ? 'checked' : '') + ' ' + disabled + ' onchange="toggleSkillInvocation(\'' + s.name + '\', \'user\', this.checked)">'
    + '    <span class="switch"></span> 用户可调用</label>'
    + '  <div class="btn-group">'
    + '    <button class="btn btn-sm btn-ghost" ' + disabled + ' onclick="openEditSkill(\'' + s.name + '\')">编辑</button>'
    + '    ' + delBtn
    + '  </div>'
    + '</div>'
    + '</div>';
}
// ====== 技能弹窗 ======
function openCreateSkill() { openSkillModal(null); }
function openEditSkill(name) {
  window.dshManager.skillsGet(name).then(function(s) { openSkillModal(s); }).catch(function(e) { showToast('读取失败: ' + e.message, 'error'); });
}
function openSkillModal(existing) {
  state.skillEditingName = existing ? existing.name : null;
  const nameValue = existing ? existing.name : '';
  const descValue = existing ? (existing.meta.description || '') : '';
  const whenValue = existing ? (existing.meta['when-to-use'] || '') : '';
  const bodyValue = existing ? (existing.body || '') : '';
  let overlay = document.getElementById('skillModal');
  if (!overlay) {
    const div = document.createElement('div');
    div.id = 'skillModal'; div.className = 'modal-overlay';
    div.innerHTML = '<div class="modal">'
      + '<div class="modal-header"><h3 id="skillModalTitle">新建技能</h3><button class="modal-close" onclick="closeSkillModal()">×</button></div>'
      + '<div class="modal-body">'
      + '  <label class="field-label">技能名（kebab-case）</label>'
      + '  <input id="skillName" placeholder="如 my-skill" class="input-text">'
      + '  <label class="field-label">描述</label>'
      + '  <textarea id="skillDesc" placeholder="一句话描述技能用途" rows="2" class="input-text"></textarea>'
      + '  <label class="field-label">何时使用（可选）</label>'
      + '  <input id="skillWhen" placeholder="when-to-use" class="input-text">'
      + '  <label class="field-label">技能正文（Markdown）</label>'
      + '  <textarea id="skillBody" placeholder="# 技能标题\\n\\n正文内容..." rows="8" class="input-text code-textarea"></textarea>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn btn-ghost" onclick="closeSkillModal()">取消</button><button class="btn btn-primary" onclick="saveSkill()">保存</button></div>'
      + '</div>';
    document.body.appendChild(div);
  } else {
    document.getElementById('skillName').value = nameValue;
    document.getElementById('skillDesc').value = descValue;
    document.getElementById('skillWhen').value = whenValue;
    document.getElementById('skillBody').value = bodyValue;
  }
  document.getElementById('skillName').disabled = !!existing;
  document.getElementById('skillModalTitle').textContent = existing ? '编辑技能: ' + nameValue : '新建技能';
  document.getElementById('skillModal').style.display = 'flex';
}
function closeSkillModal() { const el = document.getElementById('skillModal'); if (el) el.style.display = 'none'; }
async function saveSkill() {
  const name = document.getElementById('skillName').value.trim();
  const description = document.getElementById('skillDesc').value.trim();
  const whenToUse = document.getElementById('skillWhen').value.trim();
  const body = document.getElementById('skillBody').value;
  if (!name || !description) { showToast('技能名和描述必填', 'warning'); return; }
  try {
    if (state.skillEditingName) {
      await window.dshManager.skillsUpdate(name, { description: description, whenToUse: whenToUse, body: body });
      showToast('技能已更新: ' + name, 'success');
    } else {
      await window.dshManager.skillsCreate({ name: name, description: description, whenToUse: whenToUse, body: body });
      showToast('技能已创建: ' + name, 'success');
    }
    closeSkillModal(); renderSkillsPage();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
}
// ====== 可见性切换 / 删除 ======
async function toggleSkillInvocation(name, kind, value) {
  try { await window.dshManager.skillsToggle(name, kind, value); showToast('已更新调用权限', 'success'); renderSkillsPage(); }
  catch (e) { showToast('更新失败: ' + e.message, 'error'); renderSkillsPage(); }
}
async function deleteSkill(name) {
  if (!confirm('确定删除技能 ' + name + '？该操作不可恢复。')) return;
  try { await window.dshManager.skillsDelete(name); showToast('已删除: ' + name, 'success'); renderSkillsPage(); }
  catch (e) { showToast('删除失败: ' + e.message, 'error'); }
}
// ====== 导入技能 ======
function openImportSkillDialog() {
  const url = prompt('输入 GitHub 技能仓库链接：\n支持仓库根、/tree/分支/路径、/blob/分支/file.md');
  if (!url || !url.trim()) return;
  importSkillFromGitHub(url.trim());
}
async function importSkillFromGitHub(url) {
  showToast('正在从 GitHub 下载技能...', 'info');
  try { const r = await window.dshManager.skillsImportGitHub(url, { overwrite: false }); showToast('导入成功: ' + r.name, 'success'); renderSkillsPage(); }
  catch (e) { showToast('导入失败: ' + e.message, 'error'); }
}
async function importSkillFromDir() {
  try {
    if (!window.dshManager.selectSkillDirectory) throw new Error('当前环境不支持目录选择');
    const res = await window.dshManager.selectSkillDirectory();
    if (!res || res.canceled || !res.path) return;
    const r = await window.dshManager.skillsImportDir(res.path, { overwrite: false });
    showToast('导入成功: ' + r.name, 'success'); renderSkillsPage();
  } catch (e) { showToast('导入失败: ' + e.message, 'error'); }
}

// ====== 版本管理页面 ======
/**
 * 渲染 DSH Manager 品牌 Logo（图片）
 * @param {number} size - 图标尺寸 px，默认 16
 * @returns {string} HTML 字符串
 */
function renderLogoIcon(size = 16) {
  return `<img src="assets/images/logo-icon.png" alt="" width="${size}" height="${size}" style="vertical-align:middle;display:inline-block;flex-shrink:0;">`;
}
async function renderVersionsPage() {
  const el = document.getElementById('versionsContent');
  if (!el) return;

  el.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <span class="card-title">当前版本</span>
        </div>
        <div class="card-body" style="text-align:center;padding:20px;">
          <div style="font-size:48px;margin-bottom:12px;">📦</div>
          <div style="font-size:24px;font-weight:700;color:var(--primary-light);">${state.dshVersion || '未安装'}</div>
          <p style="color:var(--text-dim);margin-top:8px;">DeepSeek Harness</p>
          <div style="margin-top:16px;">
            <button class="btn btn-primary" onclick="upgradeDSH()">🔄 检查更新</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">版本信息</span>
          <button class="btn btn-sm btn-ghost" onclick="renderVersionsPage()">🔄 刷新</button>
        </div>
        <div class="card-body" id="versionInfo">
          <p>正在加载...</p>
        </div>
      </div>
    </div>
  `;

  // 加载版本信息
  try {
    const data = await window.dshManager.getDSHVersions();
    const infoEl = document.getElementById('versionInfo');
    if (data) {
      const installedRecord = (data.installed || []).map(v => `
        <span class="badge ${v.isCurrent ? 'badge-green' : 'badge-gray'}">${v.version}${v.isCurrent ? '（当前）' : ''}</span>
      `).join(' ') || '<span style="color:var(--text-dim);">无记录</span>';
      infoEl.innerHTML = `
        <p style="margin-bottom:8px;">📋 可用版本: <strong>${data.versions?.length || 0}</strong> 个</p>
        <p style="margin-bottom:8px;">📦 已安装版本记录: ${installedRecord}</p>
        <div style="margin-top:16px;max-height:280px;overflow-y:auto;">
          ${(data.versions || []).map(v => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
              <span>${v}</span>
              <span style="display:flex;align-items:center;gap:6px;">
                ${v === state.dshVersion
                  ? '<span class="badge badge-green">当前</span>'
                  : `<button class="btn btn-sm btn-ghost" onclick="switchDSHVersion('${v}')">切换</button>`}
              </span>
            </div>
          `).join('')}
        </div>
      `;
    }
  } catch (err) {
    const infoEl = document.getElementById('versionInfo');
    if (infoEl) {
      infoEl.innerHTML = `<p style="color:var(--error);font-size:13px;">⚠️ 版本信息加载失败：${err.message || '未知错误'}<br><span style="color:var(--text-dim);font-size:12px;">可能是网络问题（查询 npm registry 失败），可点击「刷新」重试</span></p>`;
    }
  }
}

// ====== 切换 DSH 版本 ======
async function switchDSHVersion(version) {
  if (!confirm(`确定要切换到 DSH ${version} 吗？\n将先卸载当前版本，再安装目标版本。`)) return;
  showToast(`正在切换到 DSH ${version}...`, 'info');
  try {
    const result = await window.dshManager.switchDSHVersion(version);
    if (result.success) {
      showToast(`已切换到 DSH ${result.newVersion}`, 'success');
      await checkDSHStatus();
      renderVersionsPage();
      renderInstallPage();
    } else {
      showToast('切换失败', 'error');
    }
  } catch (err) {
    showToast('切换失败: ' + err.message, 'error');
  }
}

// ====== 设置页面 ======
async function renderSettingsPage() {
  const el = document.getElementById('settingsContent');
  if (!el) return;

  let config = { settings: {}, credentials: {} };
  let autoStartConsole = true;
  let checkUpdatesOnStartup = true;
  try {
    config = await window.dshManager.getAllConfig();
    autoStartConsole = (await window.dshManager.getConfig('manager.auto-start-dsh')) !== false;
    checkUpdatesOnStartup = (await window.dshManager.getConfig('manager.check-updates')) !== false;
  } catch (err) { console.warn('读取配置失败:', err); }

  el.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
      <button class="btn btn-primary" onclick="openSettingsTab('manager')">⚙️ Manager 设置</button>
      <button class="btn btn-secondary" onclick="openSettingsTab('llm')">🤖 LLM 提供商</button>
      <button class="btn btn-secondary" onclick="openSettingsTab('yaml')">📝 YAML 编辑器</button>
      <button class="btn btn-secondary" onclick="openSettingsTab('presets')">🧠 Agent Presets</button>
      <button class="btn btn-secondary" onclick="openSettingsTab('system')">🔧 系统管理</button>
    </div>
    <div id="settingsTabs">
      ${renderSettingsManagerTab(autoStartConsole, checkUpdatesOnStartup)}
    </div>
  `;
  el.querySelector('.btn-primary')?.classList.add('settings-tab-active');
}

async function addLLMProvider() {
  showLLMProviderForm();
}

async function removeLLMProvider(name) {
  deleteLLMProvider(name);
}
// ====== Profile 管理 ======
function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

async function renderProfiles() {
  const el = document.getElementById('profileList');
  if (!el) return;
  let profiles = [];
  let loadError = null;
  try { profiles = await window.dshManager.listProfiles(); } catch (err) { loadError = err; }

  if (loadError) {
    el.innerHTML = `<p style="color:var(--error);font-size:13px;">⚠️ Profile 列表加载失败：${loadError.message || '未知错误'}</p>`;
    return;
  }

  const rows = profiles.length === 0
    ? '<p style="color:var(--text-dim);">暂无 Profile</p>'
    : profiles.map(p => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <span><strong>${p.name}</strong></span>
          <span style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);">
            <span>${p.mtime ? new Date(p.mtime).toLocaleString() : ''}</span>
            <button class="btn btn-sm btn-ghost" onclick="backupProfile('${p.name}')">备份</button>
          </span>
        </div>
      `).join('');

  el.innerHTML = rows + `
    <div style="display:flex;gap:8px;margin-top:12px;">
      <input class="input" id="newProfileName" placeholder="新建 Profile 名称" style="flex:1;min-width:140px;">
      <button class="btn btn-sm btn-primary" onclick="createProfile()">＋ 新建</button>
    </div>
    <p style="font-size:12px;color:var(--text-dim);margin-top:8px;">Profile 目录位于 ~/.dsh/profiles，备份保存到 ~/.dsh/manager/backups</p>
  `;
}

async function createProfile() {
  const input = document.getElementById('newProfileName');
  const name = input?.value.trim();
  if (!name) { showToast('请输入 Profile 名称', 'error'); return; }
  try {
    await window.dshManager.createProfile(name);
    showToast(`Profile ${name} 已创建`, 'success');
    await renderProfiles();
  } catch (err) {
    showToast('创建失败: ' + err.message, 'error');
  }
}

async function backupProfile(name) {
  if (!confirm(`确定备份 Profile "${name}" 吗？`)) return;
  try {
    const result = await window.dshManager.backupProfile(name);
    showToast(`已备份到 ${result.backupPath}`, 'success');
  } catch (err) {
    showToast('备份失败: ' + err.message, 'error');
  }
}

// ====== 数据管理 ======
async function renderDataManagement() {
  const el = document.getElementById('dataManagement');
  if (!el) return;
  let info = null;
  try { info = await window.dshManager.getDSHStorageInfo(); } catch {}

  if (!info) {
    el.innerHTML = '<p style="color:var(--text-dim);">加载失败</p>';
    return;
  }

  const dirLabels = { profiles: 'Profiles', sessions: '会话', skills: '技能', storages: '存储', manager: '管理器/缓存' };
  const cleanKeys = { sessions: '会话', storages: '存储', cache: '管理器/缓存' };

  const rows = info.dirs.map(d => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${dirLabels[d.name] || d.name}</span>
      <span style="display:flex;align-items:center;gap:8px;">
        <span style="color:var(--text-muted);font-size:12px;">${formatBytes(d.size)}</span>
        ${cleanKeys[d.name]
          ? `<button class="btn btn-sm btn-ghost" style="color:var(--error);" onclick="cleanData('${d.name}')">清理</button>`
          : '<span style="color:var(--text-dim);font-size:11px;">不清理</span>'}
      </span>
    </div>
  `).join('');

  el.innerHTML = `
    ${rows}
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:13px;">
      <span>合计</span>
      <strong>${formatBytes(info.total)}</strong>
    </div>
    <p style="font-size:12px;color:var(--text-dim);">清理只删除目录内文件，保留目录结构本身。</p>
  `;
}

async function cleanData(key) {
  const labels = { sessions: '会话', storages: '存储', cache: '管理器/缓存' };
  if (!confirm(`确定清空${labels[key] || key}数据吗？此操作不可恢复。`)) return;
  try {
    const result = await window.dshManager.cleanDSHData({ [key]: true });
    showToast(`已清理: ${(result.cleaned || []).join(', ') || '无' }`, 'success');
    await renderDataManagement();
  } catch (err) {
    showToast('清理失败: ' + err.message, 'error');
  }
}

// ====== MCP 服务端管理 ======
async function mcpRenderList() {
  const el = document.getElementById('mcpServerList');
  if (!el) return;

  let servers = [];
  try {
    servers = await window.dshManager.mcpList('web');
  } catch (err) {
    el.innerHTML = `<p style="color:var(--error);">加载失败: ${err.message}</p>`;
    return;
  }

  if (servers.length === 0) {
    el.innerHTML = `
      <div class="empty-state" style="padding:24px;">
        <div class="empty-state-icon">🔌</div>
        <div class="empty-state-title">暂无 MCP 服务端</div>
        <div class="empty-state-desc">添加 MCP 服务端，让 DSH Agent 连接外部工具</div>
        <button class="btn btn-primary" onclick="mcpAddDialog()">＋ 添加第一个服务端</button>
        <button class="btn btn-sm" style="margin-top:8px;" onclick="mcpImportJsonDialog()">📄 从 JSON 导入</button>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>服务端名称</th>
            <th>类型</th>
            <th>配置</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${servers.map(s => `
            <tr>
              <td><strong>${s.serverName}</strong></td>
              <td><span class="badge ${s.transport === 'stdio' ? 'badge-blue' : 'badge-green'}">${s.transport === 'stdio' ? 'stdio' : 'HTTP'}</span></td>
              <td style="color:var(--text-dim);font-size:12px;">${s.pluginName}</td>
              <td>
                <button class="btn btn-sm btn-ghost" onclick="mcpEditDialog('${s.serverName}')">编辑</button>
                <button class="btn btn-sm btn-ghost" style="color:var(--error);" onclick="mcpRemove('${s.serverName}')">删除</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  // 增强工具栏
  el.innerHTML += `<div class="page-toolbar" style="margin-top:12px;gap:8px;">
    <button class="btn btn-sm" onclick="mcpImportJsonDialog()">📄 从 JSON 导入</button>
    <button class="btn btn-sm" onclick="mcpExportJson()">📤 导出 JSON</button>
    <button class="btn btn-sm" onclick="mcpBackup()">💾 备份</button>
    <button class="btn btn-sm" onclick="mcpListBackups()">📋 备份列表</button>
  </div>`;
}

// ====== MCP 增强：JSON 导入 ======
function mcpImportJsonDialog() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active'; modal.id = 'mcpImportModal';
  modal.innerHTML = `<div class="modal" style="min-width:560px;">
    <div class="modal-header"><h3>从 JSON 导入 MCP 服务端</h3><button class="modal-close" onclick="mcpImportModalClose()">×</button></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">粘贴 Claude Code / Cursor 风格的 MCP 配置 JSON</p>
      <textarea id="mcpJsonInput" class="input-text code-textarea" rows="8" placeholder={'{"mcpServers":{"filesystem":{"command":"npx"}}}'}></textarea>
      <div id="mcpJsonPreview" style="margin-top:12px;font-size:12px;color:var(--text-dim);"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="mcpImportModalClose()">取消</button>
      <button class="btn btn-ghost" onclick="mcpPreviewJsonImport()">预览转换</button>
      <button class="btn btn-primary" onclick="mcpApplyJsonImport()">导入并合并</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}
function mcpImportModalClose() {
  const el = document.getElementById('mcpImportModal');
  if (el) el.remove();
}
async function mcpPreviewJsonImport() {
  const text = document.getElementById('mcpJsonInput')?.value;
  if (!text || !text.trim()) { showToast('请输入 JSON 配置', 'warning'); return; }
  try {
    const result = await window.dshManager.mcpImportJson(text, 'web');
    const preview = document.getElementById('mcpJsonPreview');
    if (!result.ok) {
      preview.innerHTML = `<span style="color:var(--error);">转换失败: ${result.error || '未知错误'}</span>`;
      return;
    }
    let html = `<div style="color:var(--success);">✅ 转换成功，检测到 ${result.servers} 个服务端</div>`;
    if (result.warnings && result.warnings.length) {
      html += result.warnings.map(w => `<div style="color:var(--warning);font-size:11px;">⚠ ${w}</div>`).join('');
    }
    html += `<pre style="margin-top:8px;padding:8px;background:var(--bg);border-radius:4px;font-size:11px;max-height:200px;overflow:auto;">${result.yaml || ''}</pre>`;
    preview.innerHTML = html;
  } catch (e) {
    showToast('转换失败: ' + e.message, 'error');
  }
}
async function mcpApplyJsonImport() {
  const text = document.getElementById('mcpJsonInput')?.value;
  if (!text || !text.trim()) { showToast('请输入 JSON 配置', 'warning'); return; }
  try {
    const result = await window.dshManager.mcpImportJson(text, 'web');
    if (!result.ok) { showToast('转换失败: ' + (result.error || ''), 'error'); return; }
    if (!result.rows || !result.rows.length) { showToast('未检测到服务端', 'warning'); return; }
    await window.dshManager.mcpApplyImport(result.rows, { __profile: 'web', mode: 'merge' });
    showToast('导入成功，已添加 ' + result.rows.length + ' 个服务端', 'success');
    mcpImportModalClose();
    mcpRenderList();
  } catch (e) {
    showToast('导入失败: ' + e.message, 'error');
  }
}
// ====== MCP 增强：导出 / 备份 ======
async function mcpExportJson() {
  try {
    const json = await window.dshManager.mcpExportJson('web');
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mcp-config.json'; a.click();
    URL.revokeObjectURL(url);
    showToast('已导出 MCP 配置', 'success');
  } catch (e) { showToast('导出失败: ' + e.message, 'error'); }
}
async function mcpBackup() {
  try {
    const result = await window.dshManager.mcpBackup('web');
    showToast('备份成功: ' + (result.backupPath || '无文件可备份'), 'success');
  } catch (e) { showToast('备份失败: ' + e.message, 'error'); }
}
async function mcpListBackups() {
  try {
    const backups = await window.dshManager.mcpListBackups('web');
    if (!backups || backups.length === 0) {
      showToast('暂无备份', 'info');
      return;
    }
    const info = backups.map(b => b.name + ' (' + new Date(b.mtime).toLocaleString() + ')').join('\n');
    showToast('备份列表:\n' + info, 'info', 5000);
  } catch (e) { showToast('获取备份列表失败: ' + e.message, 'error'); }
}

// ====== MCP 添加/编辑对话框 ======
function mcpAddDialog() {
  mcpDialog(null);
}

async function mcpEditDialog(serverName) {
  try {
    const server = await window.dshManager.mcpGet(serverName, 'web');
    if (server) mcpDialog(server);
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

function mcpDialog(existing) {
  const transport = existing?.transport || 'stdio';
  const html = `
    <div class="modal-overlay active" id="mcpModal">
      <div class="modal" style="min-width:520px;">
        <h3 class="modal-title">${existing ? '编辑 MCP 服务端' : '添加 MCP 服务端'}</h3>
        <div class="modal-body">
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div>
              <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">服务端名称 *</label>
              <input class="input" id="mcpName" placeholder="如: filesystem" value="${existing?.serverName || ''}" ${existing ? 'disabled' : ''}>
            </div>
            <div>
              <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">传输类型</label>
              <div style="display:flex;gap:8px;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="mcpTransport" value="stdio" ${transport === 'stdio' ? 'checked' : ''} onchange="mcpToggleTransport()">
                  <span style="font-size:13px;">stdio（本地命令）</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="mcpTransport" value="streamable-http" ${transport === 'streamable-http' ? 'checked' : ''} onchange="mcpToggleTransport()">
                  <span style="font-size:13px;">streamable-http（远程 URL）</span>
                </label>
              </div>
            </div>
            <div id="mcpStdioFields">
              <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">命令 *</label>
                <input class="input" id="mcpCommand" placeholder="如: npx" value="${existing?.command || ''}">
              </div>
              <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">参数（逗号分隔）</label>
                <input class="input" id="mcpArgs" placeholder="如: -y, @modelcontextprotocol/server-filesystem, /home/user" value="${(existing?.args || []).join(', ')}">
              </div>
              <div>
                <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">环境变量（KEY=VALUE，分号分隔）</label>
                <input class="input" id="mcpEnv" placeholder="如: API_KEY=xxx;TOKEN=yyy" value="${Object.entries(existing?.env || {}).map(([k,v]) => `${k}=${v}`).join('; ')}">
              </div>
            </div>
            <div id="mcpHttpFields" style="display:none;">
              <div style="margin-bottom:12px;">
                <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">URL *</label>
                <input class="input" id="mcpUrl" placeholder="如: https://example.com/mcp" value="${existing?.url || ''}">
              </div>
              <div>
                <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">请求头（KEY=VALUE，分号分隔）</label>
                <input class="input" id="mcpHeaders" placeholder="如: Authorization=Bearer xxx" value="${Object.entries(existing?.headers || {}).map(([k,v]) => `${k}=${v}`).join('; ')}">
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="mcpDialogClose()">取消</button>
          <button class="btn btn-primary" onclick="mcpSave()">保存</button>
        </div>
      </div>
    </div>
  `;

  const container = document.getElementById('toastContainer');
  const modal = document.createElement('div');
  modal.innerHTML = html;
  document.body.appendChild(modal.firstElementChild);
}

function mcpToggleTransport() {
  const stdio = document.getElementById('mcpStdioFields');
  const http = document.getElementById('mcpHttpFields');
  const val = document.querySelector('input[name="mcpTransport"]:checked').value;
  if (stdio && http) {
    stdio.style.display = val === 'stdio' ? 'block' : 'none';
    http.style.display = val === 'streamable-http' ? 'block' : 'none';
  }
}

function mcpDialogClose() {
  const modal = document.getElementById('mcpModal');
  if (modal) modal.remove();
}

async function mcpSave() {
  try {
    const transport = document.querySelector('input[name="mcpTransport"]:checked').value;
    const serverName = document.getElementById('mcpName').value.trim();
    if (!serverName) { showToast('服务端名称不能为空', 'error'); return; }

    const config = { transport, serverName };

    if (transport === 'stdio') {
      const command = document.getElementById('mcpCommand').value.trim();
      if (!command) { showToast('命令不能为空', 'error'); return; }
      config.command = command;
      config.args = (document.getElementById('mcpArgs').value || '').split(',').map(s => s.trim()).filter(Boolean);
      config.env = {};
      (document.getElementById('mcpEnv').value || '').split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) config.env[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      });
    } else {
      const url = document.getElementById('mcpUrl').value.trim();
      if (!url) { showToast('URL 不能为空', 'error'); return; }
      config.url = url;
      config.headers = {};
      (document.getElementById('mcpHeaders').value || '').split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) config.headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      });
    }

    const result = await window.dshManager.mcpAdd(config);
    showToast(`MCP 服务端 ${result.serverName} 已保存`, 'success');
    mcpDialogClose();
    mcpRenderList();
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function mcpRemove(serverName) {
  if (!confirm(`确定要删除 MCP 服务端 "${serverName}" 吗？`)) return;
  try {
    await window.dshManager.mcpRemove(serverName, 'web');
    showToast(`MCP 服务端 ${serverName} 已删除`, 'success');
    mcpRenderList();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

// ====== 关于页面 ======
async function renderAboutPage() {
  const el = document.getElementById('aboutContent');
  if (!el) return;

  let version = '0.1.0';
  try { version = await window.dshManager.getAppVersion(); } catch {}

  // 获取系统信息
  let nodeVer = '-', plat = '-', arch = '-';
  try {
    const info = state.dshInfo || {};
    nodeVer = info.nodeVersion || '-';
    plat = info.platform || '-';
    arch = info.arch || '-';
  } catch {}

  el.innerHTML = `
    <div style="width:100%;max-width:960px;margin:0 auto;padding:0 8px 24px;">
      <!-- Hero 区 -->
      <div style="text-align:center;padding:40px 16px 28px;">
        <div style="display:flex;flex-direction:column;align-items:center;gap:16px;">
          <img src="assets/images/logo-large.png" alt="DSH Manager" style="width:88px;height:88px;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,0.15);">
          <div>
            <h2 style="font-size:28px;font-weight:800;margin:0 0 4px;letter-spacing:-0.5px;">DSH Manager</h2>
            <p style="margin:0;color:var(--text-muted);font-size:14px;line-height:1.5;">DeepSeek Harness 安装、管理与插件一体化工具</p>
          </div>
        </div>
        <div style="margin-top:16px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
          <span class="badge badge-blue">v${version}</span>
          <span class="badge badge-gray">${plat} ${arch}</span>
          <span class="badge badge-gray">Node ${nodeVer}</span>
        </div>
      </div>

      <!-- 功能亮点（自适应网格） -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:24px;">
        <div class="card" style="margin:0;padding:16px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;line-height:1.4;">🚀</span>
            <div><div style="font-weight:600;font-size:13px;margin-bottom:2px;">一键安装 DSH</div><div style="font-size:11px;color:var(--text-muted);">npm / pnpm / corepack 自动降级，镜像源加速</div></div>
          </div>
        </div>
        <div class="card" style="margin:0;padding:16px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;line-height:1.4;">🔌</span>
            <div><div style="font-weight:600;font-size:13px;margin-bottom:2px;">插件市场</div><div style="font-size:11px;color:var(--text-muted);">浏览、搜索与一键安装 DSH 社区插件</div></div>
          </div>
        </div>
        <div class="card" style="margin:0;padding:16px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;line-height:1.4;">📋</span>
            <div><div style="font-weight:600;font-size:13px;margin-bottom:2px;">版本管理</div><div style="font-size:11px;color:var(--text-muted);">查看历史版本、切换与回滚 DSH</div></div>
          </div>
        </div>
        <div class="card" style="margin:0;padding:16px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;line-height:1.4;">🌐</span>
            <div><div style="font-weight:600;font-size:13px;margin-bottom:2px;">代理加速</div><div style="font-size:11px;color:var(--text-muted);">内置 gh-proxy.com 加速，自动切换最快源</div></div>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:24px;">
        <a class="btn btn-secondary" href="javascript:void(0)" onclick="window.dshManager.openExternal('https://github.com/linhut/dsh-manager')" style="font-size:12px;">GitHub</a>
        <a class="btn btn-secondary" href="javascript:void(0)" onclick="window.dshManager.openExternal('https://discord.gg/4qT7TPdft')" style="font-size:12px;">Discord</a>
        <a class="btn btn-secondary" href="javascript:void(0)" onclick="window.dshManager.openExternal('https://github.com/linhut/dsh-manager/issues')" style="font-size:12px;">反馈问题</a>
        <button class="btn btn-sm btn-primary" onclick="checkAppUpdateUI()">🔄 检查更新</button>
        <button class="btn btn-sm btn-ghost" onclick="toggleDebugPanel()">🐛 调试面板</button>
      </div>

      <!-- 底部信息 -->
      <div style="text-align:center;color:var(--text-dim);font-size:12px;line-height:2;padding-bottom:12px;">
        <p style="margin:0;">MIT License</p>
        <p style="margin:0;">由 Jose AI 编写 · <a href="javascript:void(0)" onclick="window.dshManager.openExternal('https://www.linhut.cn')" style="color:var(--primary-light);">www.linhut.cn</a> 出品</p>
        <p style="margin:0;">Made with ❤️ for the DSH community</p>
      </div>
    </div>
  `;
}

// ====== Toast 通知 ======
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  item.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(item);
  setTimeout(() => { item.style.opacity = '0'; item.style.transform = 'translateX(100px)'; item.style.transition = 'all 0.3s'; }, 3000);
  setTimeout(() => item.remove(), 3500);
}

// ====== 设置页面 - 辅助函数 ======

function renderSystemManagementTab() {
  const html = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <span class="card-title">🔌 MCP 服务端</span>
        <button class="btn btn-sm btn-primary" onclick="mcpAddDialog()">＋ 添加服务端</button>
      </div>
      <div class="card-body" id="mcpServerList">
        <p style="color:var(--text-dim);">正在加载...</p>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        <p style="font-size:12px;color:var(--text-dim);line-height:1.7;">
          MCP (Model Context Protocol) 让 DSH Agent 可以连接外部工具和数据源。
          配置保存在 <code>~/.dsh/profiles/web/cordis.patch.yml</code>，
          保存后需重启 DSH 生效。
        </p>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <span class="card-title">📂 Profile 管理</span>
      </div>
      <div class="card-body" id="profileList">
        <p style="color:var(--text-dim);">正在加载...</p>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <span class="card-title">🗂️ 数据管理</span>
      </div>
      <div class="card-body" id="dataManagement">
        <p style="color:var(--text-dim);">正在加载...</p>
      </div>
    </div>
  `;
  setTimeout(() => {
    mcpRenderList();
    renderProfiles();
    renderDataManagement();
  }, 50);
  return html;
}

function openSettingsTab(tab) {
  const el = document.getElementById('settingsContent');
  if (!el) return;
  el.querySelectorAll('.btn').forEach(b => {
    b.classList.remove('btn-primary', 'settings-tab-active');
    b.classList.add('btn-secondary');
  });
  const tabEl = document.getElementById('settingsTabs');
  if (!tabEl) return;

  switch (tab) {
    case 'manager':
      Promise.all([
        window.dshManager.getConfig('manager.auto-start-dsh'),
        window.dshManager.getConfig('manager.check-updates'),
        window.dshManager.getReplyLanguage()
      ]).then(([autoStart, checkUpdates, replyLang]) => {
        tabEl.innerHTML = renderSettingsManagerTab(autoStart !== false, checkUpdates !== false, replyLang || 'default');
      }).catch(() => {
        tabEl.innerHTML = renderSettingsManagerTab(true, true, 'default');
      });
      break;
    case 'llm':
      renderLLMProvidersTab().then(html => { tabEl.innerHTML = html; });
      break;
    case 'yaml':
      renderYAMLEditorTab().then(html => { tabEl.innerHTML = html; });
      break;
    case 'presets':
      renderPresetsTab().then(html => { tabEl.innerHTML = html; });
      break;
    case 'system':
      tabEl.innerHTML = renderSystemManagementTab();
      break;
  }

  el.querySelectorAll('[onclick*="' + tab + '"]').forEach(b => {
    b.classList.remove('btn-secondary');
    b.classList.add('btn-primary', 'settings-tab-active');
  });
}

function renderSettingsManagerTab(autoStart, checkUpdates, replyLang = 'default') {
  const theme = localStorage.getItem('dshm-theme') || 'system';
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">⚙️ Manager 设置</span>
      </div>
      <div class="card-body">
        <div class="setting-item">
          <div class="setting-info">
            <strong>自动打开 DSH 控制台</strong>
            <p class="setting-desc">启动时自动加载 DSH Web 界面</p>
          </div>
          <label class="toggle">
            <input type="checkbox" ${autoStart ? 'checked' : ''} onchange="setManagerSetting('manager.auto-start-dsh', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <strong>启动时检查更新</strong>
            <p class="setting-desc">启动时静默检查 DSH 是否有新版本</p>
          </div>
          <label class="toggle">
            <input type="checkbox" ${checkUpdates ? 'checked' : ''} onchange="setManagerSetting('manager.check-updates', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <strong>回复语言</strong>
            <p class="setting-desc">控制 DSH 回复与思考使用的语言；改动需新开会话或重启 DSH 生效，且为引导级指令</p>
          </div>
          <select class="setting-select" onchange="setReplyLanguage(this.value)">
            <option value="zh-CN" ${replyLang === 'zh-CN' ? 'selected' : ''}>简体中文</option>
            <option value="en" ${replyLang === 'en' ? 'selected' : ''}>English</option>
            <option value="default" ${replyLang === 'default' ? 'selected' : ''}>跟随默认</option>
          </select>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <strong>主题选择</strong>
            <p class="setting-desc">选择界面主题</p>
          </div>
          <div class="theme-selector">
            <button class="btn btn-sm theme-option ${theme === 'system' ? 'theme-option-active' : ''}" data-theme-choice="system" onclick="selectThemeOption('system')">🌓 跟随系统</button>
            <button class="btn btn-sm theme-option ${theme === 'light' ? 'theme-option-active' : ''}" data-theme-choice="light" onclick="selectThemeOption('light')">☀️ 浅色</button>
            <button class="btn btn-sm theme-option ${theme === 'dark' ? 'theme-option-active' : ''}" data-theme-choice="dark" onclick="selectThemeOption('dark')">🌙 深色</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function renderLLMProvidersTab() {
  let providers = [];
  let config = { settings: {}, credentials: {} };
  try { providers = await window.dshManager.getLLMProviders(); } catch (e) { console.warn('getLLMProviders failed:', e); }
  try { config = await window.dshManager.getAllConfig(); } catch (e) { console.warn('getAllConfig failed:', e); }

  // 收集 LLM 提供商，兼容两种配置形态：
  //   旧格式: settings.llm.<name> = { provider, model, apiKey, baseUrl }
  //   DSH 官方格式: settings.llm-<adapter>.providers.<name> = { api, baseURL, models, apiKeyEnv }
  const settings = config.settings || {};
  const providerEntries = [];
  const llm = settings.llm || {};
  for (const [name, conf] of Object.entries(llm)) {
    if (conf && typeof conf === 'object') providerEntries.push([name, conf]);
  }
  for (const [adapter, adapterCfg] of Object.entries(settings)) {
    if (!/^llm-/.test(adapter) || !adapterCfg || typeof adapterCfg !== 'object') continue;
    for (const [name, conf] of Object.entries(adapterCfg.providers || {})) {
      if (conf && typeof conf === 'object') {
        const model = Array.isArray(conf.models) && conf.models[0]
          ? (conf.models[0].id || conf.models[0])
          : '';
        providerEntries.push([name, { provider: adapter, model, apiKeyEnv: conf.apiKeyEnv || '', baseURL: conf.baseURL || '', _official: true }]);
      }
    }
  }

  if (providerEntries.length === 0) {
    return `
      <div class="card">
        <div class="card-header"><span class="card-title">🤖 LLM 提供商</span><button class="btn btn-sm btn-primary" onclick="showLLMProviderForm()">＋ 添加</button></div>
        <div class="card-body">
          <div class="empty-state">
            <div class="empty-state-icon">🤖</div>
            <div class="empty-state-title">暂无 LLM 提供商</div>
            <div class="empty-state-desc">添加一个 LLM 提供商来开始使用 AI 模型</div>
            <button class="btn btn-primary" onclick="showLLMProviderForm()">＋ 添加提供商</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <span class="card-title">🤖 LLM 提供商（${providerEntries.length}）</span>
        <button class="btn btn-sm btn-primary" onclick="showLLMProviderForm()">＋ 添加</button>
      </div>
      <div class="card-body">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>名称</th><th>提供商</th><th>模型</th><th>API Key</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${providerEntries.map(([name, conf]) => `
                <tr>
                  <td><strong>${name}</strong>${conf._official ? ' <span class="badge badge-blue">官方格式</span>' : ''}</td>
                  <td><span class="badge badge-blue">${conf.provider || 'unknown'}</span></td>
                  <td><code>${conf.model || '-'}</code></td>
                  <td>${conf.apiKey ? '••••••' + conf.apiKey.slice(-4) : (conf.apiKeyEnv ? '<span style="color:var(--text-dim);">env: ' + conf.apiKeyEnv + '</span>' : '<span style="color:var(--warning);">未设置</span>')}</td>
                  <td>
                    <button class="btn btn-sm btn-ghost" onclick="showLLMProviderForm('${name}')">✏️ 编辑</button>
                    <button class="btn btn-sm btn-ghost" onclick="deleteLLMProvider('${name}')">🗑️ 删除</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">📖 支持的提供商类型</span></div>
      <div class="card-body" style="font-size:12px;color:var(--text-muted);">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
          <div><strong>openai</strong> — OpenAI GPT 系列</div>
          <div><strong>deepseek</strong> — DeepSeek 系列</div>
          <div><strong>anthropic</strong> — Claude 系列</div>
          <div><strong>google</strong> — Gemini 系列</div>
          <div><strong>azure</strong> — Azure OpenAI</div>
          <div><strong>ollama</strong> — 本地 Ollama 模型</div>
          <div><strong>openai-compatible</strong> — 兼容 OpenAI 接口</div>
        </div>
      </div>
    </div>
  `;
}

async function renderYAMLEditorTab() {
  let config = { settings: {}, credentials: {} };
  try { config = await window.dshManager.getAllConfig(); } catch {}
  const settings = config.settings || {};
  const yamlStr = objToYAMLStr(settings);
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">📝 settings.yaml 编辑器</span>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm btn-primary" onclick="saveYAMLConfig()">💾 保存</button>
          <button class="btn btn-sm btn-secondary" onclick="refreshYAMLEditor()">🔄 刷新</button>
        </div>
      </div>
      <div class="card-body">
        <p style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">📁 ~/.dsh/settings.yaml — 编辑 YAML 配置后点击保存</p>
        <textarea id="yamlEditor" class="yaml-editor" spellcheck="false">${yamlStr.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        <div id="yamlEditorStatus" style="margin-top:8px;font-size:12px;"></div>
      </div>
    </div>
  `;
}

async function renderPresetsTab() {
  const config = await window.dshManager.getAllConfig();
  const agentPresets = config.settings?.['agent-presets'] || {};
  const entries = Object.entries(agentPresets);
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">🧠 Agent Presets（${entries.length}）</span></div>
      <div class="card-body">
        ${entries.length === 0
          ? '<p style="color:var(--text-dim);">暂无 Agent Presets 配置</p>'
          : `
            <div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>名称</th><th>路径</th></tr></thead><tbody>
              ${entries.map(([id, conf]) => {
                // 兼容 DSH 官方格式：agent-presets.default = 'preset-id'（字符串）
                const name = typeof conf === 'string' ? conf : (conf?.name || id);
                const path = typeof conf === 'string' ? '' : (conf?.path || '-');
                return `<tr><td><code>${id}</code></td><td><strong>${name}</strong>${typeof conf === 'string' ? ' <span class="badge badge-blue">默认引用</span>' : ''}</td><td style="font-size:12px;color:var(--text-dim);">${path}</td></tr>`;
              }).join('')}
            </tbody></table></div>
          `}
      </div>
    </div>
  `;
}

async function setManagerSetting(key, value) {
  try { await window.dshManager.setConfig(key, value); showToast('设置已保存', 'success'); }
  catch (err) { showToast('保存失败: ' + err.message, 'error'); }
}

async function setReplyLanguage(lang) {
  try {
    await window.dshManager.setReplyLanguage(lang);
    showToast('已保存，新会话生效', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function showLLMProviderForm(editName) {
  let name = '', provider = 'openai', model = '', apiKey = '', baseUrl = '';
  if (editName) {
    try {
      const config = await window.dshManager.getAllConfig();
      const conf = config.settings?.llm?.[editName];
      if (conf) { name = editName; provider = conf.provider || 'openai'; model = conf.model || ''; apiKey = conf.apiKey || ''; baseUrl = conf.baseUrl || ''; }
    } catch {}
  }
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal" style="min-width:480px;max-width:560px;">
      <h3 class="modal-title">${editName ? '✏️ 编辑 LLM 提供商' : '➕ 添加 LLM 提供商'}</h3>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">名称 *</label><input class="input" id="llm-name" value="${name}" placeholder="例如: default, my-gpt4" ${editName ? 'readonly' : ''}></div>
        <div class="form-group">
          <label class="form-label">提供商类型 *</label>
          <select class="input" id="llm-provider" onchange="updateLLMProviderModelHints(this.value)">
            <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI</option>
            <option value="deepseek" ${provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
            <option value="anthropic" ${provider === 'anthropic' ? 'selected' : ''}>Anthropic Claude</option>
            <option value="google" ${provider === 'google' ? 'selected' : ''}>Google Gemini</option>
            <option value="azure" ${provider === 'azure' ? 'selected' : ''}>Azure OpenAI</option>
            <option value="ollama" ${provider === 'ollama' ? 'selected' : ''}>Ollama (本地)</option>
            <option value="openai-compatible" ${provider === 'openai-compatible' ? 'selected' : ''}>OpenAI 兼容接口</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">模型名称 *</label><input class="input" id="llm-model" value="${model}" placeholder="例如: gpt-4o, deepseek-chat"><p class="form-hint" id="modelHint">不同提供商支持的模型名称不同</p></div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <div style="display:flex;gap:8px;"><input class="input" id="llm-apikey" type="password" value="${apiKey}" placeholder="sk-..." style="flex:1;"><button class="btn btn-sm btn-ghost" onclick="toggleApiKeyVisibility()" title="显示/隐藏">👁</button></div>
        </div>
        <div class="form-group"><label class="form-label">API Base URL（可选）</label><input class="input" id="llm-baseurl" value="${baseUrl}" placeholder="例如: https://api.openai.com/v1"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn btn-primary" onclick="saveLLMProvider()">💾 保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function saveLLMProvider() {
  const name = document.getElementById('llm-name')?.value?.trim();
  const provider = document.getElementById('llm-provider')?.value;
  const model = document.getElementById('llm-model')?.value?.trim();
  const apiKey = document.getElementById('llm-apikey')?.value?.trim();
  const baseUrl = document.getElementById('llm-baseurl')?.value?.trim();
  if (!name) { showToast('请输入提供商名称', 'error'); return; }
  if (!model) { showToast('请输入模型名称', 'error'); return; }
  const providerConfig = { provider, model };
  if (apiKey) providerConfig.apiKey = apiKey;
  if (baseUrl) providerConfig.baseUrl = baseUrl;
  try {
    await window.dshManager.updateLLMProvider(name, providerConfig);
    showToast(`✅ LLM 提供商 "${name}" 已保存`, 'success');
    document.querySelector('.modal-overlay.active')?.remove();
    openSettingsTab('llm');
  } catch (err) { showToast('保存失败: ' + err.message, 'error'); }
}

async function deleteLLMProvider(name) {
  if (!confirm(`确定删除 LLM 提供商 "${name}"？`)) return;
  try { await window.dshManager.deleteLLMProvider(name); showToast(`🗑️ 已删除 "${name}"`, 'success'); openSettingsTab('llm'); }
  catch (err) { showToast('删除失败: ' + err.message, 'error'); }
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('llm-apikey');
  if (input) input.type = input.type === 'password' ? 'text' : 'password';
}

let _pendingSaveTimer = null;

async function saveYAMLConfig() {
  const editor = document.getElementById('yamlEditor');
  const status = document.getElementById('yamlEditorStatus');
  if (!editor) return;

  // 二次确认：第一次点击显示确认按钮，第二次才真正保存
  const saveBtn = document.querySelector('#settingsTabs .btn-primary');
  if (saveBtn && saveBtn.dataset.confirming === 'true') {
    // 第二次点击，执行保存
    saveBtn.dataset.confirming = 'false';
    saveBtn.textContent = '💾 保存中...';
    saveBtn.disabled = true;
    const yamlText = editor.value;
    status.textContent = '正在解析和保存...'; status.style.color = 'var(--text-muted)';
    try {
      const parsed = parseSimpleYAML(yamlText);
      await window.dshManager.writeConfig(parsed);
      status.textContent = '✅ 配置已保存成功！'; status.style.color = 'var(--success)';
      showToast('✅ 配置已保存', 'success');
      saveBtn.textContent = '💾 保存';
      saveBtn.disabled = false;
    } catch (err) {
      status.textContent = '❌ ' + (err.message || '保存失败，请检查 YAML 格式'); status.style.color = 'var(--error)';
      showToast('❌ 保存失败: ' + (err.message || 'YAML 格式错误'), 'error');
      saveBtn.textContent = '💾 保存';
      saveBtn.disabled = false;
    }
  } else {
    // 第一次点击，显示确认
    if (saveBtn) {
      saveBtn.dataset.confirming = 'true';
      saveBtn.textContent = '⚠️ 确认保存？';
      saveBtn.style.background = 'var(--warning)';
      saveBtn.style.borderColor = 'var(--warning)';
      status.textContent = '⚠️ 再次点击"确认保存"以保存配置'; status.style.color = 'var(--warning)';
      // 5秒后自动取消确认状态
      if (_pendingSaveTimer) clearTimeout(_pendingSaveTimer);
      _pendingSaveTimer = setTimeout(() => {
        if (saveBtn.dataset.confirming === 'true') {
          saveBtn.dataset.confirming = 'false';
          saveBtn.textContent = '💾 保存';
          saveBtn.style.background = '';
          saveBtn.style.borderColor = '';
          status.textContent = ''; status.style.color = '';
        }
      }, 5000);
    }
  }
}

async function refreshYAMLEditor() {
  try {
    const config = await window.dshManager.getAllConfig();
    const yamlStr = objToYAMLStr(config.settings || {});
    const editor = document.getElementById('yamlEditor');
    if (editor) editor.value = yamlStr;
    const status = document.getElementById('yamlEditorStatus');
    if (status) { status.textContent = '🔄 已刷新'; status.style.color = 'var(--text-muted)'; }
  } catch (err) { showToast('刷新失败: ' + err.message, 'error'); }
}

function objToYAMLStr(obj, indent) {
  if (indent === undefined) indent = 0;
  const prefix = '  '.repeat(indent);
  let result = '';
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    if (value === null || value === undefined) { result += prefix + key + ': null\n'; }
    else if (typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) { result += prefix + key + ': {}\n'; }
      else { result += prefix + key + ':\n' + objToYAMLStr(value, indent + 1); }
    } else if (Array.isArray(value)) {
      result += prefix + key + ':\n';
      for (const item of value) {
        if (typeof item === 'object') { result += prefix + '  - ' + objToYAMLStr(item, indent + 2).trimStart(); }
        else { result += prefix + '  - ' + formatYAMLVal(item) + '\n'; }
      }
    } else { result += prefix + key + ': ' + formatYAMLVal(value) + '\n'; }
  }
  return result;
}

function formatYAMLVal(value) {
  if (typeof value === 'string') {
    if (value.includes(':') || value.includes('#') || value.includes("'") || value.includes('\n')) return JSON.stringify(value);
    return value;
  }
  return String(value);
}

function parseSimpleYAML(yaml) {
  const result = {};
  const lines = yaml.split('\n');
  const stack = [{ indent: -1, obj: result }];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const content = trimmed.trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (content.endsWith(':')) { const key = content.slice(0, -1).trim(); parent[key] = {}; stack.push({ indent, obj: parent[key] }); }
    else if (content.includes(':')) { const colonIdx = content.indexOf(':'); const key = content.slice(0, colonIdx).trim(); let value = content.slice(colonIdx + 1).trim(); parent[key] = value === '' ? null : parseSimpleYAMLValue(value); }
    else if (content.startsWith('- ')) { const item = content.slice(2).trim(); if (!Array.isArray(parent._items)) parent._items = []; parent._items.push(parseSimpleYAMLValue(item)); }
  }
  function convertItems(obj) { for (const [key, value] of Object.entries(obj)) { if (value && typeof value === 'object') { if (value._items) obj[key] = value._items; convertItems(value); } } }
  convertItems(result);
  return result;
}

function parseSimpleYAMLValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1);
  return value;
}

function updateLLMProviderModelHints(provider) {
  const hint = document.getElementById('modelHint'); if (!hint) return;
  const hints = {
    openai: '💡 常用: gpt-4o, gpt-4-turbo, gpt-3.5-turbo, o1-preview, o1-mini',
    deepseek: '💡 常用: deepseek-chat, deepseek-reasoner, deepseek-coder',
    anthropic: '💡 常用: claude-3-opus, claude-3-sonnet, claude-3-haiku, claude-2.1',
    google: '💡 常用: gemini-1.5-pro, gemini-1.5-flash, gemini-1.0-pro',
    azure: '💡 需要填写部署名称作为模型名称，以及 Azure endpoint 作为 Base URL',
    ollama: '💡 模型名称对应本地拉取的模型名，如 llama3, mistral, qwen2，Base URL 默认为 http://localhost:11434/v1',
    'openai-compatible': '💡 任意兼容 OpenAI API 格式的服务，填写其 Base URL 和 API Key',
  };
  hint.textContent = hints[provider] || '💡 输入你使用的模型名称';
}

// ====== 版本管理 - 辅助函数 ======
async function refreshVersions() {
  const listEl = document.getElementById('versionsList');
  const availEl = document.getElementById('availableVersionsList');
  if (!listEl || !availEl) return;
  try {
    const data = await window.dshManager.getDSHVersions();
    const { versions = [], installed = [] } = data;
    if (installed.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-icon">📦</div><div class="empty-state-title">暂无已安装版本</div><div class="empty-state-desc">当前 DSH 版本由 npm 全局管理</div></div>';
    } else {
      listEl.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>版本</th><th>安装时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${installed.map(v => `
                <tr>
                  <td><strong>${v.version}</strong> ${v.current ? '<span class="badge badge-green">当前</span>' : ''}</td>
                  <td style="color:var(--text-dim);font-size:12px;">${v.installedAt ? new Date(v.installedAt).toLocaleString() : '-'}</td>
                  <td>
                    ${!v.current ? `<button class="btn btn-sm btn-primary" onclick="switchVersion('${v.version}')">切换</button>` : ''}
                    ${!v.current ? `<button class="btn btn-sm btn-ghost" onclick="removeVersion('${v.version}')">删除</button>` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    if (versions.length === 0) {
      availEl.innerHTML = '<p style="color:var(--text-dim);">无法获取可用版本列表，请检查网络连接</p>';
    } else {
      availEl.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>版本</th><th>发布日期</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${versions.slice(0, 20).map(v => `
                <tr>
                  <td><strong>${v}</strong></td>
                  <td style="color:var(--text-dim);font-size:12px;">-</td>
                  <td>
                    <button class="btn btn-sm btn-primary" onclick="installVersion('${v}')">安装</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${versions.length > 20 ? `<p style="margin-top:8px;color:var(--text-dim);font-size:12px;">显示前 20 个版本，共 ${versions.length} 个</p>` : ''}
      `;
    }
  } catch (err) {
    listEl.innerHTML = `<p style="color:var(--error);">${err.message || '加载失败'}</p>`;
    availEl.innerHTML = `<p style="color:var(--error);">${err.message || '加载失败'}</p>`;
  }
}

async function switchVersion(version) {
  if (!confirm(`是否确定要切换到 DSH ${version}？\n将先卸载当前版本，再安装目标版本。`)) return;
  showToast(`正在切换到 DSH ${version}...`, 'info');
  try {
    const result = await window.dshManager.switchDSHVersion(version);
    if (result.success) {
      showToast(`已切换到 DSH ${result.newVersion}`, 'success');
      await checkDSHStatus();
      renderVersionsPage();
      renderInstallPage();
    } else { showToast('切换失败', 'error'); }
  } catch (err) { showToast('切换失败: ' + err.message, 'error'); }
}

async function installVersion(version) {
  showToast(`正在安装 DSH ${version}...`, 'info');
  try {
    await window.dshManager.installDSH(version, null, 'auto');
    showToast(`✅ DSH ${version} 安装成功`, 'success');
    await refreshVersions();
  } catch (err) { showToast('安装失败: ' + err.message, 'error'); }
}

async function removeVersion(version) {
  if (!confirm(`确定删除 DSH ${version} 版本？`)) return;
  showToast('版本删除功能需要手动操作 npm', 'warning');
}

// ====== 检查更新（DSH Manager） ======
async function checkAppUpdateUI() {
  const existing = document.getElementById('updateResultCard');
  if (existing) existing.remove();
  showToast('正在检查更新...', 'info');
  try {
    const update = await window.dshManager.checkAppUpdate();
    console.log('更新检查结果:', update);
    if (!update.hasUpdate) {
      showToast('✔ 当前已是最新版本 (' + update.currentVersion + ')', 'success');
      return;
    }
    const card = document.createElement('div');
    card.id = 'updateResultCard';
    card.style.cssText = 'margin-bottom:16px;';
    const proxyLinks = (update.proxyUrls || []).map((url, i) => {
      const labels = ['🚀 官方 GitHub', '⚡ 加速站 gh-proxy', '🌐 GitHub Proxy 网站'];
      return '<a class="btn btn-sm btn-secondary" href="javascript:void(0)" onclick="window.dshManager.openExternal(\'' + url + '\')" style="margin:2px;">' + (labels[i] || '下载 ' + (i+1)) + '</a>';
    }).join('');
    card.innerHTML = '<div class="card" style="border-color:var(--primary);">' +
      '<div class="card-header"><span class="card-title">🆕 新版本可用</span><span class="badge badge-green">v' + update.latestVersion + '</span></div>' +
      '<div class="card-body">' +
      '<p style="margin-bottom:12px;color:var(--text-secondary);">当前版本: v' + update.currentVersion + ' → 最新版本: v' + update.latestVersion + '</p>' +
      (update.releaseNotes ? '<div style="margin-bottom:12px;font-size:13px;color:var(--text-muted);line-height:1.6;">' + update.releaseNotes + '</div>' : '') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + proxyLinks + '</div>' +
      '<div style="margin-top:8px;font-size:11px;color:var(--text-dim);">' +
      '<a href="javascript:void(0)" onclick="window.dshManager.openExternal(\'' + update.releaseUrl + '\')">查看 GitHub Release 页面</a> | ' +
      '<a href="javascript:void(0)" onclick="window.dshManager.openExternal(\'https://github.akams.cn/?url=' + encodeURIComponent(update.downloadUrl) + '\')">GitHub Proxy 加速站</a>' +
      '</div>' +
      '</div></div>';
    const toolbar = document.getElementById('dashToolbar');
    if (toolbar) toolbar.parentNode.insertBefore(card, toolbar.nextSibling);
    showToast('🆕 发现新版本 v' + update.latestVersion, 'info');
  } catch (err) {
    console.error('检查更新失败:', err);
    showToast('检查更新失败: ' + (err.message || '网络错误'), 'error');
  }
}

// ====== 键盘快捷键 ======
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    toggleDebugPanel();
  }
});

// ====== 调试面板（切换显示/隐藏调试日志） ======
function toggleDebugPanel() {
  const existing = document.getElementById('debugPanel');
  if (existing) {
    existing.remove();
    return;
  }
  const panel = document.createElement('div');
  panel.id = 'debugPanel';
  panel.style.cssText = 'position:fixed;right:16px;bottom:60px;width:480px;max-height:400px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);box-shadow:var(--shadow-lg);z-index:9999;display:flex;flex-direction:column;font-size:12px;font-family:var(--font-mono);overflow:hidden;';
  panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg-secondary);">' +
    '<span style="font-weight:600;font-family:var(--font-sans);">🐛 调试日志</span>' +
    '<div style="display:flex;gap:6px;">' +
    '<button class="btn btn-xs btn-ghost" onclick="refreshDebugLogUI()">🔄 刷新</button>' +
    '<button class="btn btn-xs btn-ghost" onclick="exportDebugLog()">📥 导出</button>' +
    '<button class="btn btn-xs btn-ghost" onclick="copyDebugLog()">📋 复制</button>' +
    '<button class="btn btn-xs btn-ghost" onclick="clearDebugLog()">🗑️ 清空</button>' +
    '<button class="btn btn-xs btn-ghost" onclick="this.closest(\'#debugPanel\').remove()">✕</button>' +
    '</div></div>' +
    '<div id="debugLogContent" style="flex:1;overflow-y:auto;padding:8px 12px;white-space:pre-wrap;word-break:break-all;color:var(--text-muted);">加载中...</div>';
  document.body.appendChild(panel);
  refreshDebugLogUI();
}

async function refreshDebugLogUI() {
  const el = document.getElementById('debugLogContent');
  if (!el) return;
  el.textContent = '加载中...';
  try {
    const log = await window.dshManager.getDebugLog();
    el.textContent = log || '（日志为空）';
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.textContent = '加载日志失败: ' + e.message;
  }
}

async function exportDebugLog() {
  try {
    const log = await window.dshManager.getDebugLog();
    const blob = new Blob([log], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dsh-manager-debug-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.log';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('调试日志已导出', 'success');
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

async function copyDebugLog() {
  try {
    const log = await window.dshManager.getDebugLog();
    await navigator.clipboard.writeText(log);
    showToast('调试日志已复制到剪贴板', 'success');
  } catch (e) {
    showToast('复制失败: ' + e.message, 'error');
  }
}

async function clearDebugLog() {
  try {
    await window.dshManager.clearDebugLog();
    const el = document.getElementById('debugLogContent');
    if (el) el.textContent = '（日志已清空）';
    showToast('调试日志已清空', 'success');
  } catch (e) {
    showToast('清空失败: ' + e.message, 'error');
  }
}
