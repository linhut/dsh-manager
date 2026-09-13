/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * 模型配置中心前端模块（类似 cc-switch）
 * 档案 CRUD + 一键应用到 AtomCode / Claude Code / Codex CLI / WorkBuddy + 备份还原 + 导入导出。
 * 由 app.js 通过页面管理器调用 renderModelConfigPage()（普通脚本，非 ES Module）。
 */

// ====== 页面状态 ======
let mccState = { profiles: [], tools: [] };

// ====== 基础工具 ======
function mccEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function mccVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function mccNum(id) {
  const el = document.getElementById(id);
  if (!el || el.value === '') return 0;
  const n = Number(el.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function mccChecked(id) { const el = document.getElementById(id); return !!el && el.checked; }

// ====== 页面入口 ======
async function renderModelConfigPage() {
  const el = document.getElementById('modelConfigContent');
  if (!el) return;
  el.innerHTML = '<div style="padding:24px;color:var(--text-muted);">加载中…</div>';
  try {
    const [profiles, tools, llmHtml] = await Promise.all([
      window.dshManager.listModelProfiles(),
      window.dshManager.listModelConfigTools(),
      // LLM 提供商管理（原设置页「LLM 提供商」tab 同源复用，合并到本页）
      typeof renderLLMProvidersTab === 'function' ? renderLLMProvidersTab() : Promise.resolve(''),
    ]);
    mccState.profiles = profiles || [];
    mccState.tools = tools || [];
    el.innerHTML = `
      <div style="max-width:1100px;margin:0 auto;padding:0 8px 24px;">
        <div id="mccLlmSection" style="margin-bottom:24px;">${llmHtml}</div>
        <div id="mccArchiveSection">${renderMccLayout()}</div>
      </div>`;
    // 初始化 LLM 能力路由 UI（与设置页原「LLM 提供商」tab 同源）
    if (typeof loadLLMRoutingUI === 'function') loadLLMRoutingUI();
  } catch (e) {
    el.innerHTML = '<div class="card" style="margin:24px;padding:16px;color:var(--danger);">加载失败：' + mccEsc(e && e.message ? e.message : e) + '</div>';
  }
}

/** 重载页面数据并重绘（供各操作完成后调用） */
async function mccRefresh() {
  await renderModelConfigPage();
}

function renderMccLayout() {
  return `
    <!-- 顶部操作栏 -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="mccOpenProfileForm()">➕ 新建档案</button>
        <button class="btn" onclick="mccExportProfiles()">📤 导出</button>
        <button class="btn" onclick="mccImportProfiles()">📥 导入</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);">密钥仅保存在本机（~/.dsh/manager），应用时自动写入各工具配置并备份原文件</div>
    </div>

    <div class="mcc-section-title">📦 配置档案</div>
    <div id="mccProfileGrid">${renderMccProfiles()}</div>

    <div class="mcc-section-title" style="margin-top:28px;">🎯 应用目标工具</div>
    <div id="mccToolTable">${renderMccTools()}</div>`;
}

// ====== 档案列表 ======
function renderMccProfiles() {
  const ps = mccState.profiles;
  if (!ps.length) {
    return '<div class="card" style="padding:24px;text-align:center;color:var(--text-muted);">还没有档案，点击「➕ 新建档案」创建第一套模型配置</div>';
  }
  return '<div class="mcc-profile-grid">' + ps.map((p) => `
    <div class="card mcc-profile-card">
      <div class="mcc-profile-head">
        <div style="min-width:0;">
          <strong>${mccEsc(p.name)}</strong>
          ${p.setDefault ? ' <span class="badge badge-blue">默认</span>' : ''}
          ${p.supportsVision ? ' <span class="badge badge-gray">视觉</span>' : ''}
        </div>
        <span class="badge badge-gray" title="模型">${mccEsc(p.model)}</span>
      </div>
      <div class="mcc-meta">
        <div title="API 地址">🌐 ${mccEsc(p.baseUrl)}</div>
        <div>🔑 ${p.hasApiKey
          ? mccEsc(p.apiKeyMasked)
          : (p.apiKeyEnv ? '环境变量 $' + mccEsc(p.apiKeyEnv) : '<span class="mcc-warn-text">未设置密钥</span>')}</div>
        <div>📏 ${p.contextWindow ? '上下文 ' + Number(p.contextWindow).toLocaleString() : '上下文 -'}${p.maxTokens ? ' / 输出 ' + Number(p.maxTokens).toLocaleString() : ''}</div>
      </div>
      <div class="mcc-profile-actions">
        <button class="btn btn-sm btn-primary" onclick="mccApplyProfile('${mccEsc(p.id)}')">⚡ 应用</button>
        <button class="btn btn-sm" onclick="mccOpenProfileForm('${mccEsc(p.id)}')">✏️ 编辑</button>
        <button class="btn btn-sm btn-danger" onclick="mccDeleteProfile('${mccEsc(p.id)}')">🗑 删除</button>
      </div>
    </div>`).join('') + '</div>';
}

// ====== 工具列表 ======
function renderMccTools() {
  const ts = mccState.tools;
  if (!ts.length) return '<div class="card" style="padding:16px;">暂无可用工具适配器</div>';
  return `<div class="card" style="padding:0;overflow:hidden;">
    <table class="mcc-table">
      <thead><tr><th style="width:140px;">工具</th><th>配置文件</th><th style="width:200px;">当前状态</th><th style="width:150px;">操作</th></tr></thead>
      <tbody>${ts.map((t) => {
        const cur = t.current;
        let statusHtml;
        if (!t.exists) statusHtml = '<span class="mcc-status mcc-status-muted">未找到配置文件</span>';
        else if (cur && cur.error) statusHtml = '<span class="mcc-status mcc-status-warn" title="' + mccEsc(cur.error) + '">解析异常</span>';
        else if (cur && cur.appliedProfileId) statusHtml = '<span class="mcc-status mcc-status-ok">已应用：' + mccEsc(cur.appliedName || cur.appliedProfileId) + '</span>';
        else if (cur && cur.model) statusHtml = '<span class="mcc-status mcc-status-warn">其他配置：' + mccEsc(cur.model) + '</span>';
        else statusHtml = '<span class="mcc-status mcc-status-muted">未配置</span>';
        return `<tr>
          <td><strong>${mccEsc(t.name)}</strong></td>
          <td style="font-size:12px;color:var(--text-muted);word-break:break-all;">${mccEsc(t.file)}</td>
          <td>${statusHtml}</td>
          <td>
            <button class="btn btn-sm" onclick="mccRevertTool('${mccEsc(t.id)}')" title="还原到最近一次应用前的备份">↩ 还原</button>
            <button class="btn btn-sm" onclick="mccViewBackups('${mccEsc(t.id)}')" title="查看历史备份">📁 备份</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

// ====== 弹窗 ======
function mccOpenModal(title, bodyHtml) {
  mccCloseModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'mccModalOverlay';
  overlay.innerHTML = `
    <div class="modal" style="min-width:520px;max-width:640px;">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onclick="mccCloseModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:16px 20px;overflow:auto;">${bodyHtml}</div>
    </div>`;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) mccCloseModal(); });
  document.body.appendChild(overlay);
}

function mccCloseModal() {
  document.querySelectorAll('#mccModalOverlay').forEach((el) => el.remove());
}

// ====== 档案表单（新建 / 编辑） ======
function mccOpenProfileForm(id) {
  const p = id ? mccState.profiles.find((x) => x.id === id) : null;
  mccOpenModal(p ? '✏️ 编辑档案：' + mccEsc(p.name) : '➕ 新建配置档案', `
    <div class="mcc-form">
      <label>档案名称 *<input id="mccf-name" value="${mccEsc(p ? p.name : '')}" placeholder="如：Y 网关（DeepSeek）"></label>
      <label>API 地址（Base URL）*<input id="mccf-base" value="${mccEsc(p ? p.baseUrl : '')}" placeholder="http://192.168.1.9:65002/v1"></label>
      <label>API Key（留空保留原值）<input id="mccf-key" type="password" value="" placeholder="${mccEsc(p && p.apiKeyMasked ? p.apiKeyMasked : '输入明文密钥，或使用下方环境变量')}" autocomplete="off"></label>
      <label>或环境变量名（优先于密钥，AtomCode 写入为 $VAR）<input id="mccf-env" value="${mccEsc(p ? p.apiKeyEnv : '')}" placeholder="如：MY_API_KEY"></label>
      <label>模型名称 *<input id="mccf-model" value="${mccEsc(p ? p.model : '')}" placeholder="如：deepseek-v4-flash"></label>
      <div class="mcc-form-row">
        <label>上下文窗口（tokens）<input id="mccf-ctx" type="number" value="${p && p.contextWindow ? p.contextWindow : ''}" placeholder="1048576"></label>
        <label>最大输出（tokens）<input id="mccf-max" type="number" value="${p && p.maxTokens ? p.maxTokens : ''}" placeholder="393216"></label>
      </div>
      <div class="mcc-form-row">
        <label>供应商<input id="mccf-vendor" value="${mccEsc(p ? p.vendor : '')}" placeholder="如：DeepSeek / Zhipu"></label>
        <label>快速模型（Claude Code 用）<input id="mccf-small" value="${mccEsc(p ? p.smallModel : '')}" placeholder="可选"></label>
      </div>
      <label>温度（可选）<input id="mccf-temp" type="number" step="0.1" min="0" max="2" value="${p && p.temperature ? p.temperature : ''}" placeholder="留空则不写入"></label>
      <div class="mcc-form-row mcc-checks">
        <label class="mcc-check"><input type="checkbox" id="mccf-vision" ${p && p.supportsVision ? 'checked' : ''}> 支持视觉</label>
        <label class="mcc-check"><input type="checkbox" id="mccf-tool" ${!p || p.supportsToolCall !== false ? 'checked' : ''}> 支持工具调用</label>
        <label class="mcc-check"><input type="checkbox" id="mccf-default" ${p && p.setDefault ? 'checked' : ''}> 应用时设为默认</label>
      </div>
    </div>
    <div id="mcc-test-result" style="font-size:12px;line-height:1.6;margin-top:10px;word-break:break-all;"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button class="btn" onclick="mccTestConnection()">🔍 检测</button>
      <button class="btn" onclick="mccCloseModal()">取消</button>
      <button class="btn btn-primary" onclick="mccSubmitProfile('${mccEsc(id || '')}')">💾 保存</button>
    </div>`);
}

// ====== 连通性检测（借鉴 Cherry Studio Check / cc-switch 速度检测） ======
async function mccTestConnection() {
  const resultEl = document.getElementById('mcc-test-result');
  if (!resultEl) return;
  const input = {
    baseUrl: mccVal('mccf-base'),
    apiKey: mccVal('mccf-key') || undefined,
    model: mccVal('mccf-model'),
  };
  if (!input.baseUrl) {
    resultEl.innerHTML = '⚠️ 请先填写 API 地址';
    return;
  }
  resultEl.innerHTML = '⏳ 检测中…（请求 /models 端点，超时 8s）';
  try {
    const res = await window.dshManager.testModelConnection(input);
    if (res && res.ok) {
      const ms = res.latencyMs != null ? `，延迟 ${res.latencyMs}ms` : '';
      let html = '✅ 连接成功' + ms;
      if (res.models && res.models.length) {
        const shown = res.models.slice(0, 5).map((m) => '<code>' + mccEsc(m) + '</code>').join('、');
        html += `<br>发现 ${res.models.length} 个可用模型：${shown}${res.models.length > 5 ? '…' : ''}`;
        const modelEl = document.getElementById('mccf-model');
        if (modelEl && !modelEl.value) {
          modelEl.value = res.models[0];
          html += `<br>已自动填入首个模型：<code>${mccEsc(res.models[0])}</code>`;
        }
      }
      resultEl.innerHTML = html;
    } else {
      resultEl.innerHTML = '❌ 检测失败：' + mccEsc((res && res.error) || '未知错误');
    }
  } catch (e) {
    resultEl.innerHTML = '❌ 检测异常：' + mccEsc(e && e.message ? e.message : String(e));
  }
}

async function mccSubmitProfile(id) {
  const input = {
    id: id || undefined,
    name: mccVal('mccf-name'),
    baseUrl: mccVal('mccf-base'),
    apiKey: mccVal('mccf-key'),
    apiKeyEnv: mccVal('mccf-env'),
    model: mccVal('mccf-model'),
    vendor: mccVal('mccf-vendor'),
    smallModel: mccVal('mccf-small'),
    contextWindow: mccNum('mccf-ctx'),
    maxTokens: mccNum('mccf-max'),
    temperature: mccNum('mccf-temp'),
    supportsVision: mccChecked('mccf-vision'),
    supportsToolCall: mccChecked('mccf-tool'),
    setDefault: mccChecked('mccf-default'),
  };
  try {
    await window.dshManager.saveModelProfile(input);
    mccCloseModal();
    showToast('档案已保存', 'success');
    await mccRefresh();
  } catch (e) {
    showToast('保存失败：' + (e && e.message ? e.message : e), 'error', 6000);
  }
}

// ====== 删除档案 ======
function mccDeleteProfile(id) {
  const p = mccState.profiles.find((x) => x.id === id);
  if (!p) return;
  mccOpenModal('🗑 删除档案', `
    <div style="font-size:13px;line-height:1.6;color:var(--text-muted);">确定删除档案「<strong>${mccEsc(p.name)}</strong>」吗？<br>删除后其密钥一并移除（已应用到各工具的配置不受影响，可手动还原）。</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button class="btn" onclick="mccCloseModal()">取消</button>
      <button class="btn btn-danger" onclick="mccDoDeleteProfile('${mccEsc(id)}')">🗑 确认删除</button>
    </div>`);
}

async function mccDoDeleteProfile(id) {
  try {
    await window.dshManager.deleteModelProfile(id);
    mccCloseModal();
    showToast('档案已删除', 'success');
    await mccRefresh();
  } catch (e) {
    showToast('删除失败：' + (e && e.message ? e.message : e), 'error', 6000);
  }
}

// ====== 应用档案 ======
function mccApplyProfile(profileId) {
  const p = mccState.profiles.find((x) => x.id === profileId);
  if (!p) return;
  mccOpenModal('⚡ 应用档案：' + mccEsc(p.name), `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;line-height:1.6;">
      将 <strong>${mccEsc(p.name)}</strong>（模型 ${mccEsc(p.model)}）写入以下工具的本地配置文件：
      <br>⚠️ 写入前自动备份原配置，可在工具行点击「↩ 还原」恢复。
    </div>
    ${mccState.tools.map((t) => `
      <label class="mcc-check" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border-light);border-radius:8px;margin-bottom:8px;cursor:pointer;">
        <input type="checkbox" class="mcc-apply-tool" value="${mccEsc(t.id)}" checked>
        <span style="min-width:0;"><strong>${mccEsc(t.name)}</strong><br><span style="font-size:12px;color:var(--text-muted);word-break:break-all;">${mccEsc(t.file)}</span></span>
      </label>`).join('')}
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button class="btn" onclick="mccCloseModal()">取消</button>
      <button class="btn btn-primary" onclick="mccDoApply('${mccEsc(profileId)}')">⚡ 应用</button>
    </div>`);
}

async function mccDoApply(profileId) {
  const tools = Array.from(document.querySelectorAll('.mcc-apply-tool:checked')).map((c) => c.value);
  if (!tools.length) { showToast('请至少选择一个工具', 'warning'); return; }
  try {
    const r = await window.dshManager.applyModelProfile(profileId, tools);
    mccCloseModal();
    const ok = r.results.filter((x) => x.ok).length;
    const bad = r.results.filter((x) => !x.ok);
    if (bad.length) {
      showToast('应用完成：成功 ' + ok + ' 个，失败 ' + bad.length + ' 个（' + bad.map((b) => b.error).join('；') + '）', 'warning', 8000);
    } else {
      showToast('已应用到 ' + ok + ' 个工具', 'success');
    }
    await mccRefresh();
  } catch (e) {
    showToast('应用失败：' + (e && e.message ? e.message : e), 'error', 6000);
  }
}

// ====== 还原 / 备份 ======
function mccRevertTool(toolId) {
  const t = mccState.tools.find((x) => x.id === toolId);
  if (!t) return;
  mccOpenModal('↩ 还原配置', `
    <div style="font-size:13px;line-height:1.6;color:var(--text-muted);">确定将 <strong>${mccEsc(t.name)}</strong> 的配置还原到最近一次应用前的备份吗？<br>当前配置文件将被备份覆盖，此操作不可撤销。</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button class="btn" onclick="mccCloseModal()">取消</button>
      <button class="btn btn-danger" onclick="mccDoRevertTool('${mccEsc(toolId)}')">↩ 确认还原</button>
    </div>`);
}

async function mccDoRevertTool(toolId) {
  try {
    const r = await window.dshManager.revertModelConfigTool(toolId);
    mccCloseModal();
    if (r && r.ok) showToast('已还原：' + r.restoredFrom, 'success');
    else showToast((r && r.error) || '没有可还原的备份', 'warning');
    await mccRefresh();
  } catch (e) {
    showToast('还原失败：' + (e && e.message ? e.message : e), 'error', 6000);
  }
}

async function mccViewBackups(toolId) {
  const t = mccState.tools.find((x) => x.id === toolId);
  if (!t) return;
  let backups = [];
  try { backups = await window.dshManager.listModelConfigBackups(toolId) || []; } catch (e) { /* ignore */ }
  mccOpenModal('📁 历史备份：' + mccEsc(t.name), `
    ${backups.length
      ? backups.map((b) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border-light);border-radius:8px;margin-bottom:8px;font-size:12px;">
          <span style="font-family:monospace;">${mccEsc(b.file)}</span>
          <span class="badge badge-gray">${b.size ? Math.round(b.size / 1024) + ' KB' : '—'}</span>
        </div>`).join('')
      : '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">暂无备份</div>'}
    <div style="display:flex;justify-content:flex-end;margin-top:16px;">
      <button class="btn" onclick="mccCloseModal()">关闭</button>
    </div>`);
}

// ====== 导入 / 导出 ======
async function mccExportProfiles() {
  try {
    const json = await window.dshManager.exportModelProfiles();
    await window.dshManager.copyToClipboard(json);
    showToast('已导出 ' + mccState.profiles.length + ' 个档案（含密钥），JSON 已复制到剪贴板', 'success', 6000);
  } catch (e) {
    showToast('导出失败：' + (e && e.message ? e.message : e), 'error', 6000);
  }
}

function mccImportProfiles() {
  mccOpenModal('📥 导入档案', `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">粘贴导出的 JSON（含 profiles 数组），同 id 档案将被覆盖：</div>
    <textarea id="mccf-import" rows="10" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;" placeholder='{"profiles":[...]}'></textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button class="btn" onclick="mccCloseModal()">取消</button>
      <button class="btn btn-primary" onclick="mccDoImport()">📥 导入</button>
    </div>`);
}

async function mccDoImport() {
  const text = mccVal('mccf-import');
  if (!text) { showToast('请粘贴 JSON 内容', 'warning'); return; }
  try {
    const n = await window.dshManager.importModelProfiles(text);
    mccCloseModal();
    showToast('导入成功：' + n + ' 个档案', 'success');
    await mccRefresh();
  } catch (e) {
    showToast('导入失败：' + (e && e.message ? e.message : e), 'error', 6000);
  }
}