/** DSH Manager - DSH Control Module */
'use strict';

// ====== 启动时静默检查 DSH 更新 ======
async function checkDSHUpdateStartup() {
  try {
    const update = await window.dshManager.checkDSHUpdate();
    if (update && update.hasUpdate) {
      showToast(`发现 DSH 新版本 ${update.latest}（当前 ${update.current}），可到"安装/升级"页升级`, 'warning');
      showUpdateBanner(update.latest, update.current);
    }
  } catch {}
}

function showUpdateBanner(latest, current) {
  const old = document.getElementById('updateBanner');
  if (old) old.remove();
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;padding:10px 16px;background:var(--primary);color:white;text-align:center;font-size:13px;display:flex;align-items:center;justify-content:center;gap:12px;';
  banner.innerHTML = '🆕 发现 DSH <strong>' + escapeHtml(latest) + '</strong> 新版本（当前：' + escapeHtml(current) + '）' +
    '<button class="btn btn-sm" style="background:white;color:var(--primary);" onclick="dismissBannerAndUpgrade()">立即升级</button>' +
    '<button class="btn btn-sm btn-ghost" style="color:white;border-color:rgba(255,255,255,0.3);" onclick="dismissUpdateBanner()">稍后提醒</button>';
  document.body.prepend(banner);
  document.body.style.paddingTop = '44px';
}

// ====== DSH Web 界面加载 ======
// ====== DSH Web 界面加载 ======
// 尝试连接 DSH 并加载 webview，支持重试
async function tryConnectDSH(retriesLeft = 5) {
  const placeholder = document.getElementById('dshPlaceholder');
  const webview = document.getElementById('dshWebview');
  if (!placeholder || !webview) return;
  try {
    const resp = await fetchWithTimeout(state.dshUrl, 3000);
    if (resp.ok) {
      placeholder.style.display = 'none';
      webview.style.display = 'flex';
      state.dshRunning = true;
      dashInfoCollapsed = true;
      const dashInfoEl = document.getElementById('dashInfo');
      if (dashInfoEl) dashInfoEl.style.display = 'none';
      // 自动刷新 webview
      try {
        if (webview.src === state.dshUrl) {
          webview.reload();
        } else {
          webview.src = state.dshUrl;
        }
      } catch (e) {
        console.warn('webview 刷新失败:', e.message);
        webview.src = state.dshUrl;
      }
      renderDashToolbar();
      renderDashInfo();
      return;
    }
  } catch {}
  if (retriesLeft > 0) {
    setTimeout(function() { tryConnectDSH(retriesLeft - 1); }, 2000);
  } else {
    // 重试耗尽，显示启动提示
    state.dshRunning = false;
    placeholder.style.display = 'flex';
    webview.style.display = 'none';
    placeholder.innerHTML = [
      '<div class="placeholder-content">',
      '<img src="assets/images/logo-large.png" alt="DSH Manager" class="placeholder-icon" style="width:64px;height:64px;">',
      '<h2>DSH 已安装但未运行</h2>',
      '<p>DeepSeek Harness ' + state.dshVersion + ' 已安装，但服务未启动。</p>',
      '<p class="placeholder-hint">点击下方按钮由管理器托管启动（独立进程，不受终端会话影响）</p>',
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">',
      '<button class="btn btn-primary btn-lg" onclick="tryStartDSH()">🚀 启动 DSH</button>',
      '<button class="btn btn-secondary btn-lg" onclick="runDSHDiagnosis()">🩺 诊断服务</button>',
      '</div></div>',
    ].join('');
    renderDashToolbar();
    renderDashInfo();
  }
}

async function tryLoadDSHWeb(retries = 5) {
  renderDashToolbar();
  renderDashInfo();
  const placeholder = document.getElementById('dshPlaceholder');
  const webview = document.getElementById('dshWebview');
  if (!state.dshInstalled) {
    if (placeholder) placeholder.style.display = 'flex';
    if (webview) webview.style.display = 'none';
    return;
  }
  // 启动重试连接
  tryConnectDSH(retries);
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
      
      // 检查是否有无效插件导致启动失败，提供一键修复
      const invalidPlugins = data?.invalidPlugins;
      if (invalidPlugins && invalidPlugins.length > 0) {
        const names = invalidPlugins.map(function(p) { return p.id; }).join('、');
        const msg = '检测到 ' + invalidPlugins.length + ' 个无效插件（' + names + '），导致 DSH 无法启动。是否一键移除并重新启动？';
        if (confirm(msg)) {
          fixAndRestartDSH();
          return;
        }
      }
      showToast('❌ DSH 启动失败: ' + detail, 'error');
    });

    // 通过 IPC 让主进程启动 DSH（渲染进程无法直接访问 execa）
    const result = await window.dshManager.startDSH();
    
    if (!result.success) {
      showToast('启动失败: ' + (result.error || '未知错误'), 'error');
      return;
    }
    
    // 使用主进程返回的实际端口（可能因默认端口被占用而自动切换）
    if (result.port) {
      state.dshUrl = 'http://127.0.0.1:' + result.port;
    }
    if (result.portChanged) {
      showToast('端口 ' + result.preferredPort + ' 已被占用，已自动切换到 ' + result.port, 'warning');
    } else {
      showToast('DSH 启动命令已发送，正在等待服务就绪...', 'info');
    }
    
    // 如果主进程已确认就绪，直接加载
    if (result.reachable) {
      showToast('DSH 已启动！(' + state.dshUrl + ')', 'success');
      tryLoadDSHWeb(15);
      return;
    }
    
    // 使用共享重试连接逻辑
    showToast('正在等待 DSH 服务就绪...', 'info');
    tryLoadDSHWeb(15);
  } catch (err) {
    showToast('启动失败: ' + err.message, 'error');
  }
}

// ====== 一键修复无效插件并重启 DSH ======
async function fixAndRestartDSH() {
  showToast('正在修复无效插件并重启 DSH...', 'info');
  try {
    const result = await window.dshManager.fixAndRestartDSH();
    if (result.success) {
      if (result.fixResult && result.fixResult.fixed && result.fixResult.fixed.length > 0) {
        showToast('已移除 ' + result.fixResult.fixed.length + ' 个无效插件，DSH 重新启动', 'success');
      } else {
        showToast('DSH 已重新启动', 'success');
      }
      if (result.reachable) {
        state.dshUrl = result.webUrl || state.dshUrl;
        showToast('DSH 已启动', 'success');
        tryLoadDSHWeb(15);
      } else {
        if (result.port) state.dshUrl = 'http://127.0.0.1:' + result.port;
        showToast('正在等待 DSH 服务就绪...', 'info');
        tryLoadDSHWeb(15);
      }
    } else {
      showToast('修复失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('修复失败: ' + err.message, 'error');
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
        <button class="btn btn-sm btn-ghost" onclick="runDSHDiagnosis()" title="诊断 DSH 端口/进程/HTTP 可达性">🩺 诊断</button>
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
      state.dshRunning = false;
      renderDashToolbar();
      // 已确认停止：立即刷新 webview 显示"未运行"占位（0 重试，不等待）
      tryLoadDSHWeb(0);
    } else {
      showToast('停止失败: ' + (result.error || '未知错误'), 'error');
      state.dshRunning = false;
      renderDashToolbar();
      // 停止可能未生效：按正常流程刷新（带重试，若 DSH 仍在运行则继续显示页面）
      tryLoadDSHWeb();
    }
  } catch (err) {
    showToast('停止失败: ' + err.message, 'error');
    state.dshRunning = false;
    renderDashToolbar();
    tryLoadDSHWeb();
  }
}

// ====== DSH 服务诊断 ======
async function runDSHDiagnosis() {
  try {
    showToast('正在诊断 DSH 服务...', 'info');
    const result = await window.dshManager.diagnoseDSH();
    
    // 构建诊断结果模态框
    // 构建诊断结果模态框
    const issuesHtml = result.issues && result.issues.length > 0
      ? result.issues.map(function(i) { return '<div style="color:var(--error);padding:4px 0;">⚠️ ' + escapeHtml(i) + '</div>'; }).join('')
      : '<div style="color:var(--success);padding:4px 0;">✅ 未发现问题</div>';
    
    const suggestionsHtml = result.suggestions && result.suggestions.length > 0
      ? '<div style="margin-top:8px;"><strong style="color:var(--text-secondary);font-size:13px;">💡 建议：</strong>' +
        result.suggestions.map(function(s) { return '<div style="padding:3px 0;font-size:12px;color:var(--text-muted);">• ' + escapeHtml(s) + '</div>'; }).join('') +
        '</div>'
      : '';
    
    const healthHtml = result.health
      ? '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">HTTP 探测: ' +
        (result.health.reachable
          ? '<span style="color:var(--success);">可达（' + escapeHtml(result.health.url) + '）</span>'
          : '<span style="color:var(--error);">不可达' + (result.health.error ? '（' + escapeHtml(result.health.error) + '）' : '') + '</span>') +
        '</div>'
      : '';
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.innerHTML = '<div class="modal" style="min-width:460px;max-width:560px;">' +
      '<div class="modal-header"><h3>🩺 DSH 服务诊断报告</h3><button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">×</button></div>' +
      '<div class="modal-body">' +
        '<div style="margin-bottom:12px;font-size:13px;">' +
          '<div>端口: <strong>' + escapeHtml(result.port) + '</strong></div>' +
          '<div>端口状态: ' + (result.portFree ? '<span class="badge badge-green">空闲</span>' : '<span class="badge badge-red">占用中</span>') + '</div>' +
          (result.pid ? '<div>进程 PID: <strong>' + escapeHtml(result.pid) + '</strong>' + (result.command ? ' (' + escapeHtml(result.command) + ')' : '') + '</div>' : '') +
        '</div>' +
        '<div style="border-top:1px solid var(--border);padding-top:8px;">' + issuesHtml + suggestionsHtml + healthHtml + '</div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-primary" onclick="this.closest(\'.modal-overlay\').remove()">我知道了</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(modal);
    
    if (result.issues && result.issues.length > 0) {
      showToast('⚠️ 发现 ' + result.issues.length + ' 个问题，请查看诊断报告', 'warning');
    } else {
      showToast('✅ DSH 服务运行正常', 'success');
    }
  } catch (err) {
    showToast('诊断失败: ' + err.message, 'error');
  }
}

// ====== DSH 控制台环境信息栏（自动折叠） ======
// ====== 获取当前 DSH Web 端口（从 state.dshUrl 提取） ======
function getCurrentDSHPort() {
  try {
    const url = new URL(state.dshUrl);
    const port = Number(url.port);
    if (port) return port;
  } catch {}
  return 3080;
}

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
        <div id="processStatusCell">🔌 端口 ${getCurrentDSHPort()}: <strong>检测中...</strong></div>
      </div>
    </div>
  `;

  // 异步检测
  try {
    const proc = await window.dshManager.getDSHProcessInfo(getCurrentDSHPort());
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