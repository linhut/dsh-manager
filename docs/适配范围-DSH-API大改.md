<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# 🎯 适配范围声明 — DSH 新版本 API 大改（v1.3.20）

> 本文档声明 **DSH Manager v1.3.20** 对 **DeepSeek Harness（DSH）新版本 API** 的适配范围。
>
> DSH 自 `0.1.0-rc.7` 起对插件体系、LLM 适配层与 Web 鉴权做了**不向后兼容的大改**，
> 本版本（1.3.20）一次性完成适配，并将官方依赖补丁固化在 `vendor-patches/` 防止升级覆盖丢失。

## 一、适配目标版本

| 组件 | 适配版本 | 说明 |
|---|---|---|
| DeepSeek Harness 核心 | `>= 0.1.2-rc.1`（以 `0.1.2-rc.1` 为验证基线） | 官方最新 rc 版，插件/加载器/LLM API 全面重构 |
| `dsh-llm` | `0.1.2-rc.1`（vendor patch 固化） | 适配器契约缺失/崩溃时产出隔离事件 |
| `dsh-mcp-client` | `0.1.2-rc.1`（vendor patch 固化） | MCP 客户端补丁防升级覆盖丢失 |
| `dsh-web-app` | `0.1.2-rc.1`（vendor patch 固化） | Web UI 补丁防升级覆盖丢失 |

> 兼容下限：仍可运行 `0.1.0-rc.7` 及以上的旧版 DSH（能力路由按官方 advisory 语义放行），
> 但**强烈建议升级到 `0.1.2-rc.1`** 以完整获得本版本的新能力（插件崩溃隔离、契约漂移检测等）。

## 二、DSH API 大改点与适配内容

### 1. 插件安装机制：`cordis.patch.yml insert` → 官方 `dsh.profile.bundles`

**DSH 变更**：旧版通过手写 `cordis.patch.yml` 的 `- insert:` 条目注入插件补丁层；
新版由 profile 清单 `package.json` 的 `dsh.profile.bundles` 声明插件包，DSH boot 自动应用其
`dsh.bundle.patch`（`cordis.patch.yml`）补丁层。

**Manager 适配**（`packages/core/src/capability-router.js`）：

- 内置能力路由插件安装改为：复制包 → 登记 `dsh.profile.bundles` → 自动迁移旧的
  `cordis.patch.yml insert` 条目（幂等，可重复调用）。
- 卸载改为：从 `dsh.profile.bundles` 移除 + 清理旧 patch 残留。
- 旧的 `cordis.patch.yml insert` 安装方式在升级后自动迁移为官方 bundles 机制，
  避免 loader 重复注册导致启动失败。
- 修复了旧装缺 `cordis.patch.yml` 导致 DSH 启动 ENOENT 的历史问题（重装自动补齐）。

### 2. 插件清单格式：`dsh.profile.bundles` → `dsh.bundle.patch`

**DSH 变更**：插件包 `package.json` 中旧的 `dsh.profile.bundles` 声明废弃，
改为官方 `dsh.bundle.patch` 指向补丁文件，并声明 `peerDependencies`
（`@deepseek-ai/cordis` / `@deepseek-ai/dsh` / `@deepseek-ai/schemastery`）。

**Manager 适配**（`packages/plugins/dsh-capability-router/package.json`）：

- 内置能力路由插件改为官方清单格式（`dsh.bundle.patch: ./cordis.patch.yml` +
  peerDependencies），版本升至 `1.0.1`。
- 插件市场诊断识别「未声明 `dsh.bundle`」的条目时降级为低置信提示（`inspect`），
  不再误判为可移除的无效插件。

### 3. LLM 能力路由契约：`listProviders/listModels` → advisory 语义

**DSH 变更**：`llm.listProviders()` 返回 `LlmProviderInfo = { id, name }`（不再保证 model 列表）；
模型目录查询（`listModels`）是 **advisory** 建议而非硬校验——消费方不得以「模型未列入目录」
拒绝请求，真正的模型可用性由 DSH 的 `prepareCall` 兜底校验。

**Manager 适配**（`packages/plugins/dsh-capability-router/lib/index.js` v1.0.1）：

- 能力路由只校验 **provider 是否已注册**，模型不再参与硬校验（advisory 语义）。
- `listModels` 抛错视为不可解析（如 registration 失配）→ 透传不改写。
- 空目录/未列入模型一律放行，交给 `prepareCall` 兜底，杜绝「看得见但用不上」的悬空配置。

### 4. 设置面板 API：`installSettingsSection / settingsNamespace` 等导出被移除

**DSH 变更**：新版宿主移除了若干旧导出（典型如旧版皮肤插件 `ui-skin-stock`
import 的 `installSettingsSection` / `settingsNamespace`），升级后旧插件启动报
`does not provide an export named ...`。

**Manager 适配**（`packages/marketplace/src/registry.js` / `electron/ipc-handlers.js` /
`src/assets/js/modules/dsh-control.js`）：

- 新增**契约漂移检测**：解析 stderr 中的 `does not provide an export named` / SyntaxError，
  自动定位漂移插件并标记 `action='adapt'`（包体完好、依赖完整，remove/repair 均无效）。
- 前端启动失败弹窗区分三类处理：
  - **契约漂移** → 提示「升级插件版本或停用」，自动移除/修复被禁用（避免误导）；
  - **包体损坏**（`remove`）→ 确认后移除并可在市场重装；
  - **依赖缺失**（`repair`）→ 自动补齐安装，不卸载。

### 5. 插件崩溃自动隔离（quarantine）— 新增能力

**适配内容**（`packages/core/src/plugin-quarantine.js` + `electron/ipc-handlers.js` +
`src/assets/js/app.js`）：

- DSH 侧 `dsh-llm` vendor patch 在适配器契约缺失/崩溃时向
  `~/.dsh/manager/plugin-quarantine.jsonl` 追加事件（provider/model/stage/message）。
- Manager 监听该文件（watch + 3s 轮询兜底），按 provider 启发式定位本地插件
  （精确 → 前缀逐段 → startsWith），**自动暂停（disable）** 崩溃插件，防循环崩溃刷屏
  （同一 provider 30 分钟冷却）。
- 系统/核心 provider（deepseek / pi-ai / ark / dashscope / @deepseek-ai）**永不自动暂停**，
  仅提示并记录。
- 插件管理页新增「🛡️ 插件崩溃自动隔离」横幅：已暂停插件可「恢复并信任」，隔离历史可清空。

### 6. link 安装插件的宿主依赖自动补齐

**DSH 变更**：`link:` 方式安装的插件（如 gongwen-skill 开发目录挂载）在 profile 中
缺少 `@deepseek-ai/*` 宿主依赖副本时启动失败（历史上被误判为「无效插件」）。

**Manager 适配**（`packages/core/src/dependency-integrity.js` 新增
`repairLinkPluginHostDeps`）：

- 检测 profile 中指向外部的 symlink 插件，收集其 `@deepseek-ai/*` peer/dep，
  自动把宿主副本注入 link 目标目录的 `node_modules`。
- 依赖修复/无效插件修复流程接入该能力，UI 显示「补齐 link 插件宿主依赖 N 个」。

### 7. 无效插件治理安全护栏

**适配内容**（`packages/marketplace/src/registry.js`）：

- `diagnoseInvalidPlugins` 输出带 `{ source: runtime|static, action: remove|repair|inspect|adapt }`
  的判定元数据；`fixInvalidPlugins` **默认只移除 `action=remove`**（包体损坏/缺失），
  `repair` / `inspect` / `adapt` 一律跳过并计入 `skipped`，防止把健康或可修复插件误卸载。
- flow：stderr 运行时失败 → 包体探活（probePluginBrokenness）细分 remove/repair；
  契约漂移（adapt）优先级最高，避免漂移插件落入 remove/repair。

### 8. Web 鉴权：`?token=` 与健康探测

**DSH 变更**：`0.1.2-alpha.4+` Web 服务需要 token 鉴权，无 token 访问根路径返回 401。

**Manager 适配**（既有能力，随本版回归验证）：

- token URL 捕获与持久化（重启后仍可识别已运行的 DSH）。
- 被动健康探测失败静默化（v1.3.20），消除无谓的 4s 日志刷屏。

## 三、内置技能/插件同步（本版本新增）

| 技能 | 说明 | 仓库 |
|---|---|---|
| `web-search` | 联网搜索（DuckDuckGo 零配置）：search + fetch | `linhut/dsh-skills` |
| `gongwen-skill` | 公文全流程处理（GB/T 9704）：check/optimize/模板/样式学习/md2docx/版头版记页码注入 | `linhut/dsh-skills`（内置最新版） |
| `ppt-studio` | PPT 全能工坊：PPTD+JSON 双引擎原生 .pptx（20 套配色、18 复合组件、Python-PPTX 内核） | `linhut/dsh-skills` |
| `@dsh-manager/dsh-capability-router` 1.0.1 | 能力路由插件（官方 bundles 机制重新打包） | dsh-manager 随包内置 |

> 安装方式：DSH Manager 插件/技能市场安装 `linhut/dsh-skills` 即得九个技能；
> 开发模式（仓库内）启动 Manager 时，`dsh-skills/skills` 直接作为内置技能根生效。

## 四、兼容性边界（明确不适配/不支持）

- ❌ **不兼容 DSH `0.1.2-rc.1` 之前基于旧 export 的第三方插件**（如旧版设置面板/皮肤插件）。
  此类插件会被检测为「契约漂移」，需升级插件版本或停用——Manager 不负责改写第三方源码。
- ⚠️ `listModels` 目录查询为 advisory：Manager 不自行做模型白名单硬校验，模型报错以
  DSH `prepareCall` 为准。
- ⚠️ vendor patches 针对 `0.1.2-rc.1` 固化；DSH 再升级新 rc 版时需重新验证并更新
  `scripts/sync-vendor-patches.mjs`。
- ✅ 龙芯/申威等无 Electron 支持的架构：继续使用浏览器访问 DSH 网页（纯 Web 模式），本版本不受影响。

## 五、验证清单（v1.3.20 发布前）

- [x] `npm test` 176 项全部通过（含能力路由 bundles 机制、安全审计、内置技能完整性）
- [x] 内置技能测试：web-search / gongwen-skill / ppt-studio frontmatter 与运行时文件齐全
- [x] 能力路由：安装 → bundles 登记 → 旧 patch 迁移 → 卸载 → 幂等，全部覆盖
- [x] 契约漂移检测：`does not provide an export named` 识别与 adapt 分类
- [x] 插件崩溃隔离：事件落盘 → 自动暂停 → UI 横幅/恢复 → 清空历史
- [x] link 插件宿主依赖注入：符号链接插件缺 `@deepseek-ai/*` 自动补齐

## 六、v1.3.21 热修复记录（线上安装报错）

v1.3.20 发布后在全新/升级机器上出现 DSH 无法启动与功能告警，定位到三处问题，v1.3.21 修复：

| # | 现象（用户日志） | 根因 | v1.3.21 修复 |
|---|---|---|---|
| 1 | `dsh: overlay .../cordis.patch.yml must be a top-level YAML array of loader patch entries`（DSH 完全无法启动） | 能力路由安装器迁移旧 `cordis.patch.yml insert` 条目后，若文件只剩注释/空行，写回内容不是顶层数组，DSH `loadOverlayPatches` 拒绝启动 | 迁移后强制保证顶层数组（无条目时补 `[]`）；并对已损坏（非数组）的 patch 文件**自动自愈**为合法空数组 |
| 2 | `ignored error: getDSHPath is not a function`（安装/切换 DSH 版本后记录版本失败） | `electron/ipc-handlers.js` 用 `const { getDSHPath } = await loadCore()` 解构，但 `packages/core/src/index.js` 未 re-export `getDSHPath`（dsh-utils 已导出） | core index.js 补导出 `getDSHPath` 及其余 dsh-utils 实用函数 |
| 3 | `ignored error: JSON.parse(...).replace is not a function`（插件页/隔离概览更新检查报错） | `registry.js` 对 `npm view --json` 输出直接 `JSON.parse(stdout).replace(...)`，输出为 JSON 对象/非 JSON 时抛错 | 新增防御式解析 `parseNpmViewVersion()`：兼容字符串字面量、`{version}` 对象、纯文本/空值 |

> 已损坏 `cordis.patch.yml` 的机器：升级到 v1.3.21 后，Manager 启动/安装能力路由时会自动检测并修复为合法数组，无需手动编辑文件。

## 七、v1.3.22 热修复记录（link 插件缺宿主依赖）

v1.3.21 修复 patch 数组问题后，用户机器（pnpm 严格布局）仍因 **link 安装的插件缺宿主依赖** 无法启动 DSH：

| # | 现象（用户日志） | 根因 | v1.3.22 修复 |
|---|---|---|---|
| 1 | `failed to import loader entry ui-skin-stock (@linxin666/dsh-client-ui-skin-stock): Cannot find package '@deepseek-ai/schemastery' imported from ...\plugin-cache\dsh-stock-terminal\lib\index.js` | 插件以 `link:` 方式安装在 profile 外部（`~/.dsh/manager/plugin-cache/...`），运行时 import 宿主依赖时 Node 从 link 目标向上找不到；旧 `repairLinkPluginHostDeps` 只从 profile 顶层 `node_modules/@deepseek-ai/` 找宿主包，**pnpm 严格布局下传递依赖在 `.pnpm` 虚拟店，顶层没有 → 注入 0 项**，且只注入单个包不处理该包自身的依赖闭包 | **重构 `repairLinkPluginHostDeps`**：① 多级来源查找（顶层 `.pnpm` 虚拟店 → 宿主包嵌套 → 全局 DSH）；② BFS 递归闭包注入（插件缺的依赖 + 其自身依赖全部复制到 link 目标 `node_modules/`，不限 `@deepseek-ai` 命名空间）；③ visited 防循环、100 包上限防失控 |

> link 安装插件的机器：升级到 v1.3.22 后，Manager 启动自愈会自动检测 link 插件缺失的宿主依赖并递归补齐（含 schemastery 的依赖 cosmokit、@standard-schema/spec 等），无需手动操作。