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

  // 如果已安装，尝试加载 DSH Web
  if (state.dshInstalled) {
    tryLoadDSHWeb();
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
  } catch (err) {
    console.error('状态检测失败:', err);
  }
}

// ====== DSH Web 界面加载 ======
async function tryLoadDSHWeb() {
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
            ? `<button class="btn btn-primary btn-lg" onclick="installDSH()" id="installBtn">
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
      </div>
    </div>
  `;
}

// ====== 安装 DSH ======
async function installDSH() {
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
    // 真实进度提示（不再使用模拟进度条卡在80%）
    text.textContent = '正在安装 DSH（可能需要几分钟，请耐心等待）...';
    fill.style.width = '30%';

    const result = await window.dshManager.installDSH(null, null);
    
    fill.style.width = '100%';
    text.textContent = '✅ DSH 安装成功！';

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
      text.innerHTML = `❌ 安装失败：网络超时<br><span style="font-size:12px;color:var(--text-dim);">请检查网络连接后重试，或使用镜像源安装</span>`;
      showToast('安装失败：网络超时，请检查网络连接', 'error');
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

      grid.innerHTML = fallback.map(p => renderPluginCard(p)).join('');
      // 添加提示
      grid.innerHTML += '<div style="grid-column:1/-1;text-align:center;padding:12px;color:var(--text-dim);font-size:12px;border-top:1px solid var(--border);margin-top:8px;">⚠️ 无法连接到 GitHub API，以上为精选插件推荐。请检查网络后 <a href="javascript:void(0)" onclick="showMarketplace()" style="color:var(--primary-light);">刷新重试</a></div>';
      return;
    }

    grid.innerHTML = results.map(p => renderPluginCard(p)).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">加载失败</div><div class="empty-state-desc">${err.message || '请检查网络连接后刷新'}</div></div>`;
  }
}

function renderPluginCard(p) {
  return `
    <div class="card" style="cursor:default;">
      <div class="card-header" style="margin-bottom:8px;flex-wrap:wrap;">
        <span class="card-title" style="font-size:13px;display:flex;align-items:center;gap:6px;">
          ${p.fullName}
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
        <button class="btn btn-sm btn-primary" onclick="installMarketPlugin('${p.fullName}')">
          📥 安装
        </button>
      </div>
    </div>
  `;
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
    const result = await window.dshManager.installPlugin(`github:${fullName}`);
    showToast(`插件 ${result.name} 安装成功！`, 'success');
    renderPluginsPage();
  } catch (err) {
    showToast('安装失败: ' + err.message, 'error');
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
      infoEl.innerHTML = `
        <p style="margin-bottom:8px;">📋 可用版本: <strong>${data.versions?.length || 0}</strong> 个</p>
        <p style="margin-bottom:8px;">📦 已安装版本记录: <strong>${data.installed?.length || 0}</strong> 个</p>
        <div style="margin-top:16px;max-height:200px;overflow-y:auto;">
          ${(data.versions || []).slice(0, 10).map(v => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
              <span>${v}</span>
              <span class="badge ${v === state.dshVersion ? 'badge-green' : 'badge-gray'}">${v === state.dshVersion ? '当前' : ''}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  } catch {}
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
            <input type="checkbox" id="autoStartDSH" checked>
            <span>启动时自动打开 DSH 控制台</span>
          </label>
          <label style="display:flex;align-items:center;gap:12px;cursor:pointer;">
            <input type="checkbox" id="checkUpdates" checked>
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
  `;

  // 加载 LLM 提供商
  try {
    const providers = await window.dshManager.getLLMProviders();
    const listEl = document.getElementById('llmProviderList');
    if (providers.length > 0) {
      listEl.innerHTML = providers.map(p => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
          <span><strong>${p.name}</strong></span>
          <span style="color:var(--text-muted);">${p.provider} / ${p.model}</span>
        </div>
      `).join('');
    } else {
      listEl.innerHTML = '<p style="color:var(--text-dim);">暂无配置的 LLM 提供商</p>';
    }
  } catch {}

  // 加载 MCP 服务端列表
  await mcpRenderList();
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