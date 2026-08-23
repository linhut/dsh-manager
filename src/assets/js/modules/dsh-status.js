/** DSH Manager - Status Module */
'use strict';

// ====== 状态更新辅助函数 ======
function updateStatusToError(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('.status-text');
  if (dot) dot.className = 'status-dot status-error';
  if (text) text.textContent = message;
}

/** 切换到"检测中"状态：状态点显示旋转动画，文案回显检测进度 */
function updateStatusToDetecting(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('.status-text');
  if (dot) dot.className = 'status-dot status-detecting';
  if (text) text.textContent = message;
}

// ====== DSH 状态检测 ======
async function checkDSHStatus() {
  const statusEl = document.getElementById('dshStatus');
  if (!statusEl) return;

  // 检测开始：状态点旋转动画 + 回显"检测中"
  updateStatusToDetecting('dshStatus', '检测中...');

  try {
    const info = await window.dshManager.getDSHInfo();
    state.dshInstalled = info.installed;
    state.dshVersion = info.version;
    state.dshInfo = info;

    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');

    if (info.installed) {
      dot.className = 'status-dot status-ok';
      text.textContent = 'DSH ' + info.version;
      // 移除旧诊断按钮（如果有）
      const oldDiag = document.getElementById('dshDiagnostic');
      if (oldDiag) oldDiag.remove();
    } else {
      dot.className = 'status-dot status-error';
      text.textContent = 'DSH 未安装';
      // 添加诊断按钮（点击显示检测详情）
      let diagEl = document.getElementById('dshDiagnostic');
      if (!diagEl) {
        diagEl = document.createElement('span');
        diagEl.id = 'dshDiagnostic';
        diagEl.style.cssText = 'cursor:pointer;font-size:11px;color:var(--text-dim);margin-left:8px;text-decoration:underline;';
        diagEl.textContent = '📋 检测详情';
        diagEl.onclick = async () => {
          try {
            const detail = await window.dshManager.getDSHDetectionDetail();
            const lines = detail.attempts.map(a =>
              '[' + (a.exists ? 'O' : 'X') + (a.valid ? ' O' : '') + '] ' + (a.path || '(空)') + ' -> ' + a.reason
            );
            showAlert('DSH 检测诊断', lines.join('\n'), 'info');
          } catch (e) {
            showToast('获取诊断详情失败: ' + e.message, 'error');
          }
        };
        if (statusEl.parentNode) {
          statusEl.parentNode.insertBefore(diagEl, statusEl.nextSibling);
        }
      }
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

// ====== npm 状态检测 ======
async function checkNpmStatus() {
  const statusEl = document.getElementById('npmStatus');
  if (!statusEl) return;

  // 检测开始：旋转动画 + 回显
  updateStatusToDetecting('npmStatus', '检测中...');

  try {
    const env = await window.dshManager.checkEnvironment();
    const npm = env?.npm || {};
    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');

    if (npm.installed) {
      dot.className = 'status-dot status-ok';
      text.textContent = `npm ${(npm.version || '').replace(/^v/, '')}`;
      statusEl.style.cursor = 'default';
      statusEl.title = '';
      statusEl.onclick = null;
    } else {
      dot.className = 'status-dot status-error';
      text.textContent = 'npm 未安装';
      statusEl.style.cursor = 'pointer';
      statusEl.title = 'npm 随 Node.js 一起提供，请先安装 Node.js';
      statusEl.onclick = null;
    }
  } catch (err) {
    console.error('npm 检测失败:', err);
    updateStatusToError('npmStatus', 'npm 检测失败');
  }
}

// ====== pnpm 状态检测 ======
async function checkPnpmStatus() {
  const statusEl = document.getElementById('pnpmStatus');
  if (!statusEl) return;

  // 检测开始：旋转动画 + 回显
  updateStatusToDetecting('pnpmStatus', '检测中...');

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
        showConfirm('安装 pnpm', 'pnpm 未安装，插件管理功能不可用。\n是否立即一键安装 pnpm？（npm install -g pnpm）', { confirmText: '一键安装' })
          .then((ok) => { if (ok) installPnpm(); });
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

// ====== 依赖完整性检查与修复 ======
// 检查 DSH profile 的 node_modules 完整性
async function checkDepsHealth() {
  const statusEl = document.getElementById('depsHealthStatus');
  if (!statusEl) return;
  const dot = statusEl.querySelector('.status-dot');
  const text = statusEl.querySelector('.status-text');

  // 检测开始：旋转动画 + 回显
  updateStatusToDetecting('depsHealthStatus', '依赖检测中...');

  try {
    const health = await window.dshManager.getDepsHealth('web');
    if (health.healthy) {
      dot.className = 'status-dot status-online';
      text.textContent = '依赖健康 (' + (health.ok || 0) + ')';
      statusEl.title = '依赖完整性检查通过';
    } else {
      dot.className = 'status-dot status-error';
      text.textContent = '依赖异常 (' + (health.issues || 0) + ')';
      statusEl.title = '点击查看/修复：' + health.issues + ' 个问题';
    }
  } catch (e) {
    dot.className = 'status-dot status-unknown';
    text.textContent = '依赖检测失败';
    statusEl.title = '无法检测依赖完整性：' + (e.message || '');
  }
}

// 一键修复依赖（从 UI 触发）
async function repairDepsFromUI() {
  try {
    const health = await window.dshManager.getDepsHealth('web');
    if (health.healthy) {
      showToast('依赖完整性检查通过，无需修复', 'success');
      return;
    }
    const issues = health.issues || 0;
    const ok = await showConfirm('修复依赖', '依赖完整性检查发现 ' + issues + ' 个问题。\n\n点击确定将从 DSH 全局安装副本复制缺失/损坏的包文件到当前 profile。\n\n此操作不会影响已安装的插件和配置。', { confirmText: '开始修复' });
    if (!ok) return;
    showToast('正在修复依赖...', 'info');
    const result = await window.dshManager.repairDeps('web', {});
    const fixed = result.repaired ? result.repaired.length : 0;
    const failed = result.failed ? result.failed.length : 0;
    const skipped = result.skipped ? result.skipped.length : 0;
    if (fixed > 0) {
      showToast('已修复 ' + fixed + ' 个包（失败 ' + failed + '，跳过 ' + skipped + '）', 'success');
    } else if (failed > 0) {
      showToast('修复失败：' + failed + ' 个包无法修复，请尝试重新安装 DSH', 'error');
    } else {
      showToast('无需修复，所有依赖正常', 'success');
    }
    await checkDepsHealth();
  } catch (e) {
    showToast('修复失败: ' + (e.message || '未知错误'), 'error');
  }
}

