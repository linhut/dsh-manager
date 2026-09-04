<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# DSH Manager 管理功能与安装渠道扩充设计

- 日期：2026-08-18
- 版本：v0.4.0 目标特性（当前基线 v0.3.0）
- 状态：待审阅

## 1. 背景与目标

DSH Manager v0.3.0 已具备 DSH 安装/升级/卸载、插件市场、版本管理、配置/MCP 管理、系统诊断等能力。
本次扩充两大方向：

1. **管理功能扩充**：新增数据管理、服务/进程管理、Profile 管理三项能力，补齐日常运维场景。
2. **组件安装渠道扩充**：DSH 本体安装增加指定版本、多镜像选择、corepack 渠道；插件安装增加 Git URL 直装、批量安装、本地目录安装。

所有新增功能遵循既有架构：核心逻辑进 `packages/core`（管理类）与 `packages/marketplace`（来源解析），
Electron 层仅加 IPC 薄封装，渲染层按现有模式加 UI 与按钮。

## 2. 管理功能扩充

### 2.1 数据管理

**目标**：查看 DSH 各数据目录占用，按需清理会话/缓存/存储。

**core 新增**（`packages/core/src/data-manager.js`，从 `index.js` 导出）：

- `getDSHStorageInfo()` → `Promise<{ total: number, dirs: Array<{ name, path, size }> }>`
  - 遍历 `DSH_PATHS.profiles / sessions / skills / storages / manager` 五个目录
  - 递归统计各目录字节数（`fs.readdir` + `stat` 求和）
- `cleanDSHData({ sessions, storages, cache })` → `Promise<{ cleaned: Array<string> }>`
  - 按开关清空对应目录内文件与子目录（**保留目录本身**）
  - 返回实际清理的目录名列表；不存在或已空的目录跳过不报错

**IPC 新增**（`electron/ipc-handlers.js`）：

- `dsh:storage-info` → `getDSHStorageInfo()`
- `dsh:clean-data` ← `{ sessions?: boolean, storages?: boolean, cache?: boolean }` → `cleanDSHData(...)`

**preload 新增**：

- `getDSHStorageInfo()`
- `cleanDSHData(opts)`

**UI（设置页）**：新增「数据管理」卡片：

- 展示五个目录各自占用（自动格式化 KB/MB/GB）
- 每项一个「清理」按钮，点击弹 `confirm` 二次确认后调用对应 IPC
- 清理成功后刷新占用数据并 toast 提示

### 2.2 服务/进程管理

**目标**：检测 DSH Web 服务端口/进程状态，辅助排查"已安装但连不上"类问题。

**core 新增**（`packages/core/src/data-manager.js` 或独立 `process-manager.js`）：

- `getDSHProcessInfo()` → `Promise<{ port: number, portInUse: boolean, pid: number|null, command: string|null }>`
  - 检测 `127.0.0.1:3080` 端口占用情况
  - Windows：`netstat -ano | findstr :3080` 提取 PID，`tasklist /FI "PID eq <pid>"` 取进程名
  - 非 Windows：`lsof -i :3080`（不存在则降级为端口探测）
  - 端口空闲时返回 `portInUse: false`

**IPC 新增**：

- `dsh:process-info` → `getDSHProcessInfo()`

**preload 新增**：

- `getDSHProcessInfo()`

**UI（控制台环境信息栏）**：

- 环境信息栏新增「端口 3080：空闲 / 占用(PID xxx)」状态行
- 端口被非 DSH 进程占用时显示黄色警告徽章与提示文案

### 2.3 Profile 管理

**目标**：管理 DSH profiles（web/dev/自定义多配置），支持列表、新建、备份。

**core 新增**（`packages/core/src/profile-manager.js`）：

- `class DSHProfileManager`
  - `list()` → `Array<{ name, path, mtime, size }>`：读取 `DSH_PATHS.profiles` 下的子目录
  - `create(name)`：校验名称（`[A-Za-z0-9_-]{1,32}`），在 profiles 下建目录（已存在则抛 `ALREADY_EXISTS`）
  - `backup(name)`：将 `profiles/<name>` 复制到 `DSH_PATHS.managerDir/backups/<name>-<时间戳>/`，返回备份路径
  - 不存在的 profile 在 `list/backup` 中返回空/抛 `NOT_FOUND`（`list` 静默跳过坏目录）

**IPC 新增**：

- `dsh:list-profiles` → `list()`
- `dsh:create-profile` ← `name` → `create(name)`
- `dsh:backup-profile` ← `name` → `backup(name)`

**preload 新增**：

- `listProfiles()`
- `createProfile(name)`
- `backupProfile(name)`

**UI（设置页）**：新增「Profile 管理」卡片：

- 列表展示每个 profile（名称、最后修改时间、大小）
- 「新建 Profile」输入框 + 按钮
- 每项「备份」按钮，成功后 toast 提示备份路径

## 3. DSH 安装渠道扩充

### 3.1 指定版本安装

- **纯 UI 改动**：安装卡片新增「版本号（留空=最新）」输入框
- 安装时把输入框值作为 `version` 传入已有 `dsh:install(version, registry, tool)`；空值传 `null` 保持现状
- `DSHInstaller.install` 已支持 `@deepseek-ai/dsh@<version>`，无需改 core

### 3.2 多镜像下拉

- **纯 UI 改动**：安装卡片的「🇨🇳 镜像源」按钮升级为下拉选择框
- 选项：官方 `https://registry.npmjs.org` / npmmirror `https://registry.npmmirror.com` / 腾讯 `https://mirrors.cloud.tencent.com/npm/` / 华为 `https://repo.huaweicloud.com/repository/npm/`
- 选中值作为 `registry` 传入已有 `dsh:install(version, registry, tool)`；core 的 `INSTALL_OPTIONS.mirrors` 已支持 registry 覆盖

### 3.3 corepack 渠道

**core 改动**（`packages/core/src/installer.js` `_installWithTool`）：

- 新增分支 `tool === 'corepack'`，语义为「corepack 引导 + pnpm 安装」组合：
  - 先执行 `corepack enable`（启用 Node 内置包管理器分发），失败则提示 `npm install -g corepack`
  - 再走既有 pnpm 全局安装分支（`pnpm add -g @deepseek-ai/dsh@<version>`）
  - 说明：corepack 只能分发 yarn/pnpm 等包管理器、不能直接安装任意 npm 包，故核心安装仍由 pnpm 完成，corepack 仅负责兜底启用 pnpm
- `install()` 的 `tools` 列表在 `tool === 'auto'` 时加入 `'corepack'`（放在 pnpm 之后作最后兜底）

**UI**：安装方式按钮组新增「📦 corepack」

## 4. 插件安装渠道扩充

### 4.1 Git URL 直装

**marketplace 改动**（`packages/marketplace/src/installer.js`）：

- `_parseSource` 新增分支：
  - `https://github.com/<owner>/<repo>` / `git+https://...` / `git+ssh://...` → `{ type: 'git', url }`
- 新增 `_installFromGit(url, profile)`：
  - `git clone --depth 1 <url> <pluginCache>/<repoName>`
  - 读取包内 `package.json` 名称/版本
  - 注册本地插件（`type: 'git'`）
  - clone 失败抛 `PLUGIN_INSTALL_FAILED` 并给出校验提示

**IPC/preload**：复用已有 `marketplace:install-plugin` / `installPlugin(source)`，无需新增通道

**UI（插件管理页）**：市场区上方新增「插件来源」输入框 + 「安装」按钮，支持粘贴 `github:xxx`、`npm:xxx`、Git URL 任意格式，直接调 `installPlugin`

### 4.2 批量安装

- **后端已存在**：`PluginManager.batchInstall(sources[])`（逐条安装，单条失败不中断）
- **IPC 新增**：`marketplace:batch-install` ← `string[]` → `batchInstall(...)`
- **preload 新增**：`batchInstallPlugins(sources)`
- **UI**：插件管理页新增「批量安装」入口（textarea 每行一个来源 + 确认按钮），逐条 toast 结果

### 4.3 本地目录安装

**marketplace 改动**：

- `_parseSource` 新增分支：`file:<绝对路径>` 前缀 → `{ type: 'file', path }`（**仅 `file:` 前缀**识别，避免与 npm 分支的裸路径歧义）
- 新增 `_installFromFile(dir, profile)`：
  - 校验目录存在且含 `package.json`
  - 复制到 `pluginCache/<name>`（`fs.cpSync` 递归）
  - 注册本地插件（`type: 'file'`）

**IPC/preload**：复用 `marketplace:install-plugin`；本地路径选择用 Electron `dialog.showOpenDialog`

**UI**：插件来源输入框支持 `file:` 路径；另加「选择本地目录」按钮（经新 IPC `marketplace:pick-plugin-dir` 弹目录选择框返回路径）

## 5. 架构与数据流

```
渲染层 app.js ──dshManager.xxx──> preload ──ipcRenderer.invoke──> ipc-handlers.js ──import──> packages/core 或 packages/marketplace
                                                                                                     │
                                            新增管理类: data-manager / process-manager / profile-manager
                                            新增渠道逻辑: installer(corepack) / installer(git/file) / batch-install
```

- 所有新增 core 类在 `packages/core/src/index.js` 导出；marketplace 渠道逻辑在 `installer.js` 内部
- IPC 全部用 `ipcMain.handle` + `ipcRenderer.invoke` 对称命名，遵循现有 `dsh:*` / `marketplace:*` 前缀
- UI 全部走 `window.dshManager` 桥，不在渲染层直接 require Node 模块

## 6. 错误处理

- 新增 IPC 抛 `DSHError`（`DSHErrorCodes` 复用：`NOT_FOUND / ALREADY_EXISTS / PLUGIN_INSTALL_FAILED / DSH_INSTALL_FAILED`）
- 清理/备份/删除类操作一律先 `confirm` 二次确认
- `list` 类方法对损坏/缺失目录静默跳过，返回可渲染的空数组
- Git clone / corepack / 目录复制失败：抛错并带可操作修复建议（如"请确认已安装 git"）
- 安装类操作不真实跑 npm/pnpm 装包验证（测试环境无 DSH），验证参数传递与错误路径

## 7. 测试计划

- **core 冒烟**（临时 `DSH_HOME`，沿用现有方式）：
  - `getDSHStorageInfo` 各目录 size 求和正确
  - `cleanDSHData` 清空文件、保留目录、不存在目录跳过
  - `DSHProfileManager.list/create/backup` 全流程 + 名称校验 + 重复创建报错
  - `getDSHProcessInfo` 端口空闲分支返回结构正确
- **marketplace 冒烟**：
  - `_parseSource` 新增 git/file 分支解析正确
  - `batchInstall` 逐条失败不中断（mock 来源）
- **回归**：现有 10 项冒烟 + 搜索链路保持通过
- **语法**：`node --check` 全部 JS；`pwsh` 校验 install.ps1（如改动）

## 8. 范围外（YAGNI）

- 不做：日志实时 tail、DSH 进程树级管理、备份自动调度、插件多版本共存
- 不做：改动现有 IPC 命名（保持向后兼容）
