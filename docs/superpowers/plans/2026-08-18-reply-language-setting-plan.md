<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# 实施计划：DSH 回复语言设置（Reply Language Setting）

对应规格：`docs/superpowers/specs/2026-08-18-reply-language-setting-design.md`
日期：2026-08-18

## 目标

在设置页 Manager tab 新增「回复语言」下拉框（简体中文 / English / 跟随默认），控制 DSH 回复与思考语言。实现方式：写入/替换/移除 `~/.dsh/AGENTS.md` 中的语言指令块（HTML 注释标记，幂等），并将选择持久化到 `manager.reply-language` 配置键。

## 改动清单（按依赖顺序）

### 1. core：新增 `packages/core/src/reply-language.js`

- 常量：
  - `BLOCK_START = '<!-- dsh-manager:reply-language -->'`
  - `BLOCK_END = '<!-- /dsh-manager:reply-language -->'`
  - 语言指令模板对象 `LANG_DIRECTIVES = { 'zh-CN': '…', 'en': '…' }`（内容取自规格 3.3）
  - 合法取值 `LANG_VALUES = ['zh-CN', 'en', 'default']`
- 内部函数 `_buildBlock(lang)`：返回 `BLOCK_START + '\n' + 指令 + '\n' + BLOCK_END`（`default` 时返回 `null`）
- 内部函数 `_applyToAgentsMd(lang)`：
  1. 读 `DSH_PATHS.home/AGENTS.md`（不存在则视为空字符串）
  2. 用正则 `/\n?<!-- dsh-manager:reply-language -->[\s\S]*?<!-- \/dsh-manager:reply-language -->\n?/` 查找现有块
  3. 若 `lang === 'default'`：存在则移除（连同前后空行清理）；不存在则跳过
  4. 否则：存在则整体替换为新块；不存在则在末尾追加（`\n\n` + 新块 + `\n`）
  5. 结果与原内容相同则跳过写入；否则 `writeFileSync(AGENTS.md 路径, 结果, 'utf-8')`
- 导出：
  - `setReplyLanguage(lang)`：校验取值 → `_applyToAgentsMd(lang)` → `new DSHConfig().set('manager.reply-language', lang)`。若配置写失败，回滚 AGENTS.md（重新调用 `_applyToAgentsMd(原值)`）；若 AGENTS.md 写失败则抛错且不落配置。
  - `getReplyLanguage()`：`new DSHConfig().get('manager.reply-language') || 'default'`
  - `clearReplyLanguage()`：`_applyToAgentsMd('default')` + `new DSHConfig().delete('manager.reply-language')`

### 2. core：`packages/core/src/index.js` 导出

在现有 export 块追加：

```js
export { setReplyLanguage, getReplyLanguage, clearReplyLanguage } from './reply-language.js';
```

### 3. electron：`electron/ipc-handlers.js`

在「数据管理」区块附近追加：

```js
ipcMain.handle('dsh:set-reply-language', async (_, lang) => {
  const { setReplyLanguage } = await loadCore();
  return await setReplyLanguage(lang);
});
ipcMain.handle('dsh:get-reply-language', async () => {
  const { getReplyLanguage } = await loadCore();
  return await getReplyLanguage();
});
```

### 4. electron：`electron/preload.cjs`

在 window.dshManager 对象追加：

```js
setReplyLanguage: (lang) => ipcRenderer.invoke('dsh:set-reply-language', lang),
getReplyLanguage: () => ipcRenderer.invoke('dsh:get-reply-language'),
```

### 5. 前端：`src/assets/js/app.js`

- `openSettingsTab('manager')`：`Promise.all` 增加 `window.dshManager.getReplyLanguage()`，渲染时传入 `replyLang`（缺省 `'default'`）
- `renderSettingsManagerTab(autoStart, checkUpdates, replyLang)`：在主题选择后新增 setting-item，下拉框三个 `<option>`（简体中文 `zh-CN` / English `en` / 跟随默认 `default`，`selected` 按 `replyLang` 匹配），`onchange="setReplyLanguage(this.value)"`
- 新增函数：

```js
async function setReplyLanguage(lang) {
  try {
    await window.dshManager.setReplyLanguage(lang);
    showToast('已保存，新会话生效', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}
```

### 6. 样式（如需）

`.setting-item` 已适配 flex 布局；下拉框可复用现有 `.select`/原生 `<select>` 样式；若无现成样式则补一条轻量 CSS（`select { background: var(--bg-primary); color: var(--text-primary); … }`），并在 `style.css` 设置页区块内添加。

## 验证步骤

1. `node --check` 校验所有改动的 JS 文件语法（core 新文件、index.js、ipc-handlers.js、preload.cjs、app.js）
2. 手动验证（需运行 Electron 应用）：
   - 切到「简体中文」→ 检查 `~/.dsh/AGENTS.md` 含中文块、settings.yaml 含 `manager.reply-language: zh-CN`
   - 切「English」→ 块被替换为英文
   - 切「跟随默认」→ 块被移除、配置键被删除
   - 含用户自定义内容的 AGENTS.md 不被破坏；AGENTS.md 不存在时自动创建
   - 重开 DSH 会话观察回复语言
3. 回归：设置页其余选项（自动打开控制台 / 检查更新 / 主题）不受影响

## 提交策略

- 单次提交，message 前缀 `feat:`，主体描述「add reply language setting (AGENTS.md directive injection)」，附 `Co-Authored-By` trailer
