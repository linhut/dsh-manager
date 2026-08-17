/**
 * DSH Manager - 主应用逻辑
 * 
 * 管理所有页面渲染、DSH 状态、安装流程、插件管理
 */

// ====== 全局状态 ======
const state = {
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
};

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

// ====== 初始化 ======
document.addEventListener('DOMContentLoaded', async () => {
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

  // 检测 DSH 状态
  await checkDSHStatus();

  // 检测 pnpm 状态
  await checkPnpmStatus();

  // 读取 Manager 设置（自动打开控制台 / 启动时检查更新）
  let autoStartConsole = true;
  let checkUpdatesOnStartup = true;
  try {
    autoStartConsole = (await window.dshManager.getConfig('manager.auto-start-dsh')) !== false;
    checkUpdatesOnStartup = (await window.dshManager.getConfig('manager.check-updates')) !== false;
  } catch {}

  // 如果已安装且开启"自动打开控制台"，尝试加载 DSH Web
  if (state.dshInstalled && autoStartConsole) {
    tryLoadDSHWeb();
  }

  // 开启"启动时检查 DSH 更新"则静默检查一次
  if (checkUpdatesOnStartup) {
    checkDSHUpdateStartup();
  }

  // 渲染各页面
  renderInstallPage();
  renderPluginsPage();
  renderVersionsPage();
  renderSettingsPage();
  renderAboutPage();
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
  if (page === 'versions') renderVersionsPage();
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
      
      // 尝试检测 DSH 是否运行
      try {
        const resp = await fetch('http://127.0.0.1:3080', { signal: AbortSignal.timeout(2000) });
        state.dshRunning = resp.ok;
      } catch {
        state.dshRunning = false;
      }
    } else {
      dot.className = 'status-dot status-error';
      text.textContent = 'DSH 未安装';
    }
    renderDashToolbar();
    renderDashInfo();
  } catch (err) {
    console.error('状态检测失败:', err);
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
  }
}

// ====== 一键安装 pnpm ======
async function installPnpm() {
  showToast('正在安装 pnpm，请稍候...', 'info');
  try {
    const result = await window.dshManager.installPnpm();
    if (result.success) {
      showToast(`✅ pnpm ${result.version} 安装成功！`, 'success');
    } else {
      const detail = result.message || result.error || '未知错误';
      showToast(`❌ pnpm 安装失败: ${detail}`, 'error');
    }
    await checkPnpmStatus();
    renderInstallPage();
  } catch (err) {
    showToast('❌ pnpm 安装失败: ' + err.message, 'error');
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
    const resp = await fetch('http://127.0.0.1:3080', { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      placeholder.style.display = 'none';
      webview.style.display = 'flex';
      webview.src = 'http://127.0.0.1:3080';
      state.dshRunning = true;
      return;
    }
  } catch {}

  // DSH 未运行，显示启动提示
  placeholder.style.display = 'flex';
  webview.style.display = 'none';
  placeholder.innerHTML = `
    <div class="placeholder-content">
      <span class="placeholder-icon">⚡</span>
      <h2>DSH 已安装但未运行</h2>
      <p>DeepSeek Harness ${state.dshVersion} 已安装，但服务未启动。</p>
      <p class="placeholder-hint">请在终端中运行 <code>dsh web</code> 启动 Web 界面</p>
      <button class="btn btn-primary btn-lg" onclick="tryStartDSH()">
        🚀 尝试启动 DSH
      </button>
    </div>
  `;
}

// ====== 尝试启动 DSH ======
async function tryStartDSH() {
  showToast('正在尝试启动 DSH...', 'info');
  try {
    // 通过 IPC 让主进程启动 DSH（渲染进程无法直接访问 execa）
    const result = await window.dshManager.startDSH();
    
    if (!result.success) {
      showToast('启动失败: ' + (result.error || '未知错误'), 'error');
      return;
    }
    
    showToast('DSH 启动命令已发送，请稍候...', 'info');
    
    // 等待几秒后重试连接
    setTimeout(async () => {
      try {
        const resp = await fetch('http://127.0.0.1:3080', { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          showToast('DSH 已启动！', 'success');
          tryLoadDSHWeb();
        } else {
          showToast('DSH 启动可能需要一些时间，请稍后再试', 'warning');
        }
      } catch {
        showToast('DSH 启动失败，请手动运行 dsh web', 'error');
      }
    }, 5000);
  } catch (err) {
    showToast('启动失败: ' + err.message, 'error');
  }
}

// ====== DSH 控制台工具条（启动/停止） ======
function renderDashToolbar() {
  const bar = document.getElementById('dashToolbar');
  if (!bar) return;
  if (!state.dshInstalled) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = state.dshRunning
    ? `<span style="font-size:13px;color:var(--text-secondary);">🟢 DSH 运行中</span>
       <button class="btn btn-sm btn-danger" onclick="stopDSH()">🛑 停止 DSH</button>`
    : `<span style="font-size:13px;color:var(--text-secondary);">🟡 DSH 未运行</span>
       <button class="btn btn-sm btn-primary" onclick="tryStartDSH()">🚀 启动 DSH</button>`;
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

// ====== DSH 控制台环境信息栏 ======
async function renderDashInfo() {
  const el = document.getElementById('dashInfo');
  if (!el) return;
  const info = state.dshInfo || {};
  if (!state.dshInstalled) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <div class="card" style="margin-bottom:12px;">
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
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
        <button class="btn btn-sm btn-secondary" onclick="window.dshManager.openExternal('${state.dshUrl}')">🌐 浏览器打开</button>
        ${state.dshRunning
          ? `<button class="btn btn-sm btn-danger" onclick="stopDSH()">🛑 停止 DSH</button>`
          : `<button class="btn btn-sm btn-primary" onclick="tryStartDSH()">🚀 启动 DSH</button>`}
        <button class="btn btn-sm btn-secondary" onclick="upgradeDSH()">🔄 检查更新</button>
        <button class="btn btn-sm btn-ghost" onclick="switchPage('install')">📥 安装/升级</button>
      </div>
    </div>
  `;

  // 异步检测端口/进程状态
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
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-primary);border-radius:var(--radius-sm);font-size:12px;flex-wrap:wrap;">
            <span>📦 pnpm:</span>
            ${state.pnpmAvailable
              ? `<span class="badge badge-green">${state.pnpmVersion}</span>`
              : `<span class="badge badge-red">未安装</span>`
            }
            ${!state.pnpmAvailable ? `<span style="color:var(--text-dim);">插件管理需要 pnpm</span>` : ''}
            ${!state.pnpmAvailable ? `<button class="btn btn-sm btn-primary" onclick="installPnpm()">⚡ 一键安装 pnpm</button>` : ''}
          </div>
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
}

// ====== 安装 DSH ======
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
async function renderPluginsPage() {
  const el = document.getElementById('pluginsContent');
  if (!el) return;

  let localPlugins = [];
  try {
    localPlugins = await window.dshManager.getLocalPlugins();
  } catch {}

  el.innerHTML = `
    <div style="margin-bottom:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="showMarketplace()">
        🛒 浏览插件市场
      </button>
      <button class="btn btn-secondary" onclick="checkPluginUpdates()">
        🔄 检查更新
      </button>
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
      ${localPlugins.length === 0
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
                 ${localPlugins.map(p => `
                   <tr>
                     <td><strong>${p.name || p.id}</strong></td>
                     <td><span class="badge badge-blue">${p.version}</span></td>
                     <td style="color:var(--text-dim);font-size:12px;">${p.type === 'github' ? 'GitHub' : 'npm'}</td>
                     <td><span class="badge ${p.enabled !== false ? 'badge-green' : 'badge-gray'}">${p.enabled !== false ? '已启用' : '已禁用'}</span></td>
                     <td>
                       <button class="btn btn-sm btn-ghost" onclick="togglePlugin('${p.id}', ${p.enabled !== false})">${p.enabled !== false ? '禁用' : '启用'}</button>
                       <button class="btn btn-sm btn-ghost" onclick="uninstallPlugin('${p.id}')">卸载</button>
                     </td>
                   </tr>
                 `).join('')}
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
          <div class="search-box" style="max-width:100%;margin-bottom:16px;">
            <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input type="text" id="marketplaceSearch" placeholder="搜索插件 (如: agent, file, web)..." onkeydown="if(event.key==='Enter')loadMarketplace(this.value)">
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

// ====== 插件市场 ======
async function showMarketplace() {
  const section = document.getElementById('marketplaceSection');
  section.style.display = 'block';
  await loadMarketplace('');
}

function closeMarketplace() {
  document.getElementById('marketplaceSection').style.display = 'none';
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

      grid.innerHTML = fallback.map(p => renderPluginCard(p)).join('');
      // 添加提示
      grid.innerHTML += '<div style="grid-column:1/-1;text-align:center;padding:12px;color:var(--text-dim);font-size:12px;border-top:1px solid var(--border);margin-top:8px;">⚠️ 无法连接到 GitHub API，以上为精选插件推荐。请检查网络后 <a href="javascript:void(0)" onclick="showMarketplace()" style="color:var(--primary-light);">刷新重试</a></div>';
      return;
    }

    state.marketResults = results;
    grid.innerHTML = results.map(p => renderPluginCard(p)).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">加载失败</div><div class="empty-state-desc">${err.message || '请检查网络连接后刷新'}</div></div>`;
  }
}

function renderPluginCard(p) {
  return `
    <div class="card" style="cursor:pointer;" onclick="showPluginDetails('${p.fullName}')">
      <div class="card-header" style="margin-bottom:8px;flex-wrap:wrap;">
        <span class="card-title" style="font-size:13px;display:flex;align-items:center;gap:6px;">
          ${p.fullName}
          ${p._source === 'npm' ? '<span class="badge badge-gray" title="来源：npm registry">📦 npm</span>' : ''}
          ${p.recommended ? '<span class="badge badge-recommended" style="background:linear-gradient(135deg,#F59E0B,#D97706);color:white;font-size:10px;padding:1px 6px;border-radius:3px;">⭐ 推荐</span>' : ''}
        </span>
        <span style="font-size:13px;color:var(--warning);font-weight:700;">★ ${p.stars}</span>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.4;">${(p.description || '暂无描述').slice(0, 80)}</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">
        ${p.language ? `<span class="badge badge-gray">${p.language}</span>` : ''}
        ${(p.topics || []).slice(0, 3).map(t => `<span class="badge badge-blue">${t}</span>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;color:var(--text-dim);">🍴 ${p.forks}  ⚡ ${(p.stars || 0) + (p.forks || 0)} 活跃</span>
        <span style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();showPluginDetails('${p.fullName}')">👁 详情</button>
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();installMarketPlugin('${p.fullName}')">
            📥 安装
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
      <h3 class="modal-title">⚡ ${p.fullName} ${p.recommended ? '<span class="badge badge-recommended" style="background:linear-gradient(135deg,#F59E0B,#D97706);color:white;font-size:10px;padding:1px 6px;border-radius:3px;">⭐ 推荐</span>' : ''}</h3>
      <div class="modal-body">
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:13px;color:var(--text-dim);">
          <span>⭐ <strong>${p.stars}</strong></span>
          <span>🍴 <strong>${p.forks}</strong></span>
          ${p.language ? `<span>🔤 ${p.language}</span>` : ''}
          ${p.license ? `<span>📄 ${p.license}</span>` : ''}
          ${p.issues ? `<span>🐞 ${p.issues}</span>` : ''}
        </div>
        <p style="font-size:13px;color:var(--text-muted);line-height:1.6;margin-bottom:12px;">${p.description || '暂无描述'}</p>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">
          ${(p.topics || []).map(t => `<span class="badge badge-blue">${t}</span>`).join('')}
        </div>
        <div id="pluginDetailExtra">
          <p style="color:var(--text-dim);font-size:13px;">⏳ 正在加载 README 与版本信息...</p>
        </div>
      </div>
      <div class="modal-footer">
        ${ghUrl ? `<button class="btn btn-secondary" onclick="window.dshManager.openExternal('${ghUrl}')">🌐 项目地址</button>` : ''}
        <button class="btn btn-primary" onclick="installMarketPlugin('${p.fullName}');document.querySelector('.modal-overlay.active')?.remove();">📥 安装</button>
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
    // README 预览（最多 600 字）
    if (info.readme) {
      const plain = info.readme.replace(/```[\s\S]*?```/g, '').replace(/[#>*_`~\[\]()!-]/g, '').replace(/\s+/g, ' ').trim();
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
                <button class="btn btn-sm btn-ghost" onclick="togglePlugin('${p.id}', ${p.enabled !== false})">${p.enabled !== false ? '禁用' : '启用'}</button>
                <button class="btn btn-sm btn-ghost" onclick="uninstallPlugin('${p.id}')">卸载</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${q ? `<p style="margin-top:12px;color:var(--text-dim);font-size:13px;">找到 ${filtered.length} 个匹配插件</p>` : ''}
  `;
}

async function installMarketPlugin(fullName) {
  try {
    showToast(`正在安装 ${fullName}...`, 'info');
    // 按来源选择前缀：npm 包用 npm:，GitHub 仓库用 github:
    const p = (state.marketResults || []).find(x => x.fullName === fullName);
    const source = (p && p._source === 'npm') ? `npm:${fullName}` : `github:${fullName}`;
    const result = await window.dshManager.installPlugin(source);
    showToast(`插件 ${result.name} 安装成功！`, 'success');
    renderPluginsPage();
  } catch (err) {
    showToast('安装失败: ' + err.message, 'error');
  }
}

// ====== 插件来源直装 ======
async function installPluginSource() {
  const input = document.getElementById('pluginSource');
  const source = input?.value.trim();
  if (!source) { showToast('请输入插件来源', 'error'); return; }
  showToast(`正在安装 ${source}...`, 'info');
  try {
    const result = await window.dshManager.installPlugin(source);
    showToast(`插件 ${result.name} 安装成功！`, 'success');
    if (input) input.value = '';
    renderPluginsPage();
  } catch (err) {
    showToast('安装失败: ' + err.message, 'error');
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

  showToast(`正在批量安装 ${sources.length} 个插件...`, 'info');
  try {
    const results = await window.dshManager.batchInstallPlugins(sources);
    const ok = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);
    showToast(`批量安装完成：${ok}/${results.length} 成功${failed.length ? `，${failed.length} 失败` : ''}`, failed.length ? 'warning' : 'success');
    if (failed.length > 0) {
      const detail = failed.map(r => `${r.source}: ${r.error || '未知错误'}`).join('\n');
      alert(`以下插件安装失败：\n\n${detail}`);
    }
    renderPluginsPage();
  } catch (err) {
    showToast('批量安装失败: ' + err.message, 'error');
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

// ====== 版本管理页面 ======
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
  try {
    config = await window.dshManager.getAllConfig();
  } catch {}

  el.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <span class="card-title">DSH 配置</span>
        </div>
        <div class="card-body">
          <p style="margin-bottom:12px;color:var(--text-dim);">配置文件位于: ~/.dsh/settings.yaml</p>
          <pre style="background:var(--bg-primary);padding:16px;border-radius:var(--radius-sm);font-size:12px;max-height:300px;overflow-y:auto;color:var(--text-muted);font-family:var(--font-mono);">${JSON.stringify(config.settings, null, 2) || '暂无配置'}</pre>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">LLM 提供商</span>
        </div>
        <div class="card-body" id="llmProviderList">
          <p>正在加载...</p>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-header">
        <span class="card-title">DSH Manager 设置</span>
      </div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <p style="margin-bottom:8px;color:var(--text-secondary);font-size:13px;font-weight:600;">🎨 界面主题</p>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-sm theme-option ${(localStorage.getItem(THEME_KEY) || 'system') === 'light' ? 'theme-option-active' : ''}" data-theme-choice="light" onclick="selectThemeOption('light')">
                ☀️ 浅色
              </button>
              <button class="btn btn-sm theme-option ${(localStorage.getItem(THEME_KEY) || 'system') === 'dark' ? 'theme-option-active' : ''}" data-theme-choice="dark" onclick="selectThemeOption('dark')">
                🌙 深色
              </button>
              <button class="btn btn-sm theme-option ${(localStorage.getItem(THEME_KEY) || 'system') === 'system' ? 'theme-option-active' : ''}" data-theme-choice="system" onclick="selectThemeOption('system')">
                🖥️ 跟随系统
              </button>
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:12px;cursor:pointer;">
            <input type="checkbox" id="autoStartDSH">
            <span>启动时自动打开 DSH 控制台</span>
          </label>
          <label style="display:flex;align-items:center;gap:12px;cursor:pointer;">
            <input type="checkbox" id="checkUpdates">
            <span>启动时检查 DSH 更新</span>
          </label>
        </div>
      </div>
    </div>
    <!-- ====== MCP 服务端管理 ====== -->
    <div class="card" style="margin-top:16px;">
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
    <!-- ====== Profile 管理 ====== -->
    <div class="card" style="margin-top:16px;">
      <div class="card-header">
        <span class="card-title">📂 Profile 管理</span>
      </div>
      <div class="card-body" id="profileList">
        <p style="color:var(--text-dim);">正在加载...</p>
      </div>
    </div>
    <!-- ====== 数据管理 ====== -->
    <div class="card" style="margin-top:16px;">
      <div class="card-header">
        <span class="card-title">🗂️ 数据管理</span>
      </div>
      <div class="card-body" id="dataManagement">
        <p style="color:var(--text-dim);">正在加载...</p>
      </div>
    </div>
  `;

  // 加载 Manager 设置（自动打开控制台 / 启动时检查更新）并绑定事件
  try {
    const autoStart = (await window.dshManager.getConfig('manager.auto-start-dsh')) !== false;
    const checkUpd = (await window.dshManager.getConfig('manager.check-updates')) !== false;
    const autoEl = document.getElementById('autoStartDSH');
    const updEl = document.getElementById('checkUpdates');
    if (autoEl) {
      autoEl.checked = autoStart;
      autoEl.addEventListener('change', () => {
        window.dshManager.setConfig('manager.auto-start-dsh', autoEl.checked);
      });
    }
    if (updEl) {
      updEl.checked = checkUpd;
      updEl.addEventListener('change', () => {
        window.dshManager.setConfig('manager.check-updates', updEl.checked);
      });
    }
  } catch {}

  // 加载 LLM 提供商
  try {
    const providers = await window.dshManager.getLLMProviders();
    const listEl = document.getElementById('llmProviderList');
    if (providers.length > 0) {
      listEl.innerHTML = providers.map(p => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <span><strong>${p.name}</strong></span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span style="color:var(--text-muted);">${p.provider} / ${p.model}</span>
            <button class="btn btn-sm btn-ghost" style="color:var(--error);" onclick="removeLLMProvider('${p.name}')">删除</button>
          </span>
        </div>
      `).join('');
    } else {
      listEl.innerHTML = '<p style="color:var(--text-dim);">暂无配置的 LLM 提供商</p>';
    }
    // 添加提供商表单
    listEl.innerHTML += `
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
        <input class="input" id="llmName" placeholder="名称（如 deepseek）" style="flex:1;min-width:100px;">
        <input class="input" id="llmProvider" placeholder="提供商（如 deepseek）" style="flex:1;min-width:100px;">
        <input class="input" id="llmModel" placeholder="模型（如 deepseek-chat）" style="flex:1;min-width:120px;">
        <button class="btn btn-sm btn-primary" onclick="addLLMProvider()">＋ 添加</button>
      </div>`;
  } catch {}

  // 加载 MCP 服务端列表
  await mcpRenderList();

  // 加载 Profile 列表与数据管理
  await renderProfiles();
  await renderDataManagement();
}

// ====== LLM 提供商管理 ======
async function addLLMProvider() {
  const name = document.getElementById('llmName')?.value.trim();
  const provider = document.getElementById('llmProvider')?.value.trim();
  const model = document.getElementById('llmModel')?.value.trim();
  if (!name || !provider || !model) {
    showToast('请填写名称、提供商和模型', 'error');
    return;
  }
  try {
    await window.dshManager.setConfig(`llm.${name}.provider`, provider);
    await window.dshManager.setConfig(`llm.${name}.model`, model);
    showToast(`LLM 提供商 ${name} 已添加`, 'success');
    renderSettingsPage();
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  }
}

async function removeLLMProvider(name) {
  if (!confirm(`确定要删除 LLM 提供商 "${name}" 吗？`)) return;
  try {
    await window.dshManager.deleteConfig(`llm.${name}`);
    showToast(`已删除 ${name}`, 'success');
    renderSettingsPage();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
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

  el.innerHTML = `
    <div class="card" style="text-align:center;max-width:500px;margin:0 auto;">
      <div style="padding:40px 20px;">
        <div style="font-size:64px;margin-bottom:16px;">⚡</div>
        <h2 style="font-size:24px;font-weight:700;margin-bottom:8px;">DSH Manager</h2>
        <p style="color:var(--text-muted);margin-bottom:4px;">DeepSeek Harness 安装与管理工具</p>
        <p style="color:var(--text-dim);font-size:13px;">版本 ${version}</p>
        <div style="margin:24px 0;display:flex;justify-content:center;gap:12px;">
          <a class="btn btn-secondary" href="javascript:void(0)" onclick="window.dshManager.openExternal('https://github.com/linhut/dsh-manager')">
            GitHub
          </a>
          <a class="btn btn-secondary" href="javascript:void(0)" onclick="window.dshManager.openExternal('https://github.com/linhut/dsh-manager/issues')">
            反馈问题
          </a>
        </div>
        <div style="color:var(--text-dim);font-size:12px;line-height:1.8;">
          <p>MIT License</p>
          <p>由 Jose AI 编写 · <a href="javascript:void(0)" onclick="window.dshManager.openExternal('https://www.linhut.cn')" style="color:var(--primary-light);">www.linhut.cn</a> 出品</p>
          <p>Made with ❤️ for the DSH community</p>
        </div>
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