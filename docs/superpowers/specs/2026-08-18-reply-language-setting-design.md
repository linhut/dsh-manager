# 设计文档：DSH 回复语言设置（Reply Language Setting）

日期：2026-08-18
状态：待用户审阅

## 一、需求背景

用户希望在 dsh-manager 工具的设置页面中增加一个「语言选择」设置项，用于控制 DSH（DeepSeek Harness）回复时使用的语言——例如让 DSH 的所有回复内容均为简体中文。

**关键事实**：DSH 原生没有「回复语言」配置开关（官方明确说明不存在强制推理/回复语言的开关）。社区控制回复语言的方式有三种：

1. 写入 `~/.dsh/AGENTS.md`（全局指令注入，最简单）
2. 挂载语言插件到 profile（每轮强化指令）
3. 使用中文预设（`agent-presets`）

本项目已具备 `~/.dsh/settings.yaml` 读写链路、设置页（manager/llm/yaml/presets 四个 tab）、`agent-presets` 配置支持等基础设施。

## 二、方案选择

**选定方案：方案 A —— AGENTS.md 指令注入**（改动最小、全局生效、不装任何插件、贴合「设置页选个语言」的诉求）。

理由：
- DSH 通过 `dsh-agent-instructions` 将 `~/.dsh/AGENTS.md` 注入会话，无需安装插件。
- 复用现有 `manager.*` 配置键模式与设置页 Manager tab。
- 方案 B（本地语言插件）约束最强但代码量大、按 profile 挂载/卸载复杂，留作后续增强。
- 方案 C（中文预设）改动超过语言本身（人设/模式都变），易造成用户困惑。

## 三、设计

### 3.1 配置键

- 键：`manager.reply-language`（写入 `~/.dsh/settings.yaml`，与现有 `manager.auto-start-dsh`、`manager.check-updates` 同模式）
- 取值：
  - `zh-CN`：简体中文指令
  - `en`：英文指令
  - `default`（或缺省）：不注入任何语言指令（跟随模型默认）
- 未设置时默认 `default`，行为与现状一致。

### 3.2 核心模块（新增）

新增 `packages/core/src/reply-language.js`，导出：

- `setReplyLanguage(lang)`：
  1. 写/改 `~/.dsh/AGENTS.md` 中的语言指令块（见 3.3）；
  2. 写 `manager.reply-language` 到 settings.yaml（复用 `DSHConfig.set`）。
  失败时回滚已完成的写入（文件写失败则不落配置；配置写失败则回滚 AGENTS.md）。
- `getReplyLanguage()`：返回当前配置值（缺省为 `default`）。
- `clearReplyLanguage()`：移除 AGENTS.md 中的指令块并删除配置键（等价于 `setReplyLanguage('default')`，保留为内部辅助）。

### 3.3 AGENTS.md 指令块格式

使用 HTML 注释标记块，支持幂等替换/移除，不破坏用户已有的 AGENTS.md 内容：

```markdown
<!-- dsh-manager:reply-language -->
# 语言规则
- 默认始终使用简体中文进行思考（reasoning）与所有最终回答。
- 计划、工具调用、总结、代码注释同样使用简体中文。
- 仅代码、命令、文件路径、变量名、API 名称等必须原样保留的内容使用英文。
<!-- /dsh-manager:reply-language -->
```

- `zh-CN`：写入上述中文块。
- `en`：写入英文等价块（"Always think and reply in English..."）。
- `default`：移除整块（含空行清理）。

替换逻辑：查找 `<!-- dsh-manager:reply-language -->` 与 `<!-- /dsh-manager:reply-language -->` 之间的内容并整体替换；未找到则追加到文件末尾（文件不存在则创建）。

### 3.4 IPC 与 preload

- `electron/ipc-handlers.js` 新增：
  - `dsh:set-reply-language`（参数：lang）
  - `dsh:get-reply-language`（无参，返回当前值）
- `electron/preload.cjs` 暴露：
  - `dshManager.setReplyLanguage(lang)`
  - `dshManager.getReplyLanguage()`

### 3.5 设置页 UI

在设置页 Manager tab（`renderSettingsManagerTab`）新增「回复语言」下拉框：

- 选项：简体中文（`zh-CN`）/ English（`en`）/ 跟随默认（`default`）
- 说明文案：控制 DSH 回复与思考使用的语言；改动需新开会话或重启 DSH 生效；指令为引导级，优先级低于系统提示词与直接用户指令。
- `openSettingsTab('manager')` 读取 `manager.reply-language` 传入渲染；onchange 调用 `setReplyLanguage(lang)`，成功 toast「已保存，新会话生效」。

## 四、数据流

```
下拉选择 zh-CN → setReplyLanguage('zh-CN')
  → IPC dsh:set-reply-language
  → core setReplyLanguage()
    → 写/替换 ~/.dsh/AGENTS.md 指令块
    → 写 settings.yaml manager.reply-language
  → 返回成功 → toast「已保存，新会话生效」
```

## 五、错误处理

- AGENTS.md 写入失败：抛出错误，不落配置，前端 toast「保存失败」。
- settings.yaml 写入失败：回滚 AGENTS.md 到写入前状态，toast「保存失败」。
- AGENTS.md 不存在：自动创建（保证不破坏 `~/.dsh` 其他内容）。
- 指令块之外的用户自定义内容：一律保留不动。

## 六、生效约束（如实说明）

- DSH 会话启动时读取 AGENTS.md，改动需新开会话/重启 DSH 生效（UI 文案注明）。
- 指令为 guidance 级，优先级低于系统提示词；模型可能不完全遵守（尤其技术任务），UI 文案如实说明。

## 七、测试

- 单元级：`setReplyLanguage` 三种取值的注入/替换/移除幂等性；AGENTS.md 不存在时创建；含用户自定义内容的文件不被破坏。
- 手动：设置页切换三个选项 → 检查 `~/.dsh/AGENTS.md` 与 settings.yaml 内容；重开 DSH 会话观察回复语言。

## 八、范围（YAGNI）

- 不做：自定义语言文本输入、按 profile 细分语言、语言插件自动安装（留待后续）。
- 不影响：主题、LLM 提供商、presets、yaml 编辑器等现有功能。
