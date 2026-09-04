<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# 设计文档：基础环境最小化安装方案（低配置可用性）

日期：2026-08-19
状态：待用户审阅

## 一、需求背景

用户反馈：低配置电脑上安装 DSH 的基础环境（Node.js/npm/pnpm/git）不可用或过慢。
现状：`installNodejs`/`installGit` 使用 `winget/brew/apt` 系统包管理器完整安装，
体积大（Node 数百 MB）、依赖多、需管理员权限、低配机耗时数分钟甚至卡死。

目标：让基础环境在低配置电脑上**可用且安装快**，支持**最小化安装**。

## 二、方案选择

**选定方案：综合方案 D —— 便携版 Node（镜像下载）+ 最小依赖集 + 分级安装选项。**

- 便携版：官方 zip 解压即用，免管理员权限、免系统残留、可整体删除
- 镜像下载：npmmirror 国内源，低配机下载提速
- 最小依赖：Node（含 npm）为唯一硬依赖；pnpm 用 Node 内置 corepack；git 按需
- 分级：默认便携版，保留系统包管理器作为高级选项

## 三、设计

### 3.1 便携版 Node 安装（核心）

- 版本选择：默认安装 **Node LTS**，从 `https://registry.npmmirror.com/-/binary/node/index.json`
  解析最新 LTS 版本号（`lts` 字段非空的最新条目），不硬编码版本
- 下载：`https://registry.npmmirror.com/-/binary/node/v<ver>/node-v<ver>-win-x64.zip`（win）
  （darwin/linux 对应 `.tar.gz` / `.tar.xz`，镜像同样提供）
- 解压：到 `~/.dsh/env/node/`
- 新增路径常量：`DSH_PATHS.envNodeDir`（`~/.dsh/env/node`）与 `DSH_PATHS.envDir`（`~/.dsh/env`）
- 配置：安装后不写系统 PATH，而是在调用 DSH 时**动态注入** `~/.dsh/env/node` 到子进程 PATH
  （`resolveDSHCommand` 已有 PATH 注入先例），避免污染系统
- 删除：整体删除 `~/.dsh/env/node` 即完成卸载，无残留

### 3.2 最小依赖集

| 依赖 | 策略 |
|---|---|
| node / npm | 便携版（硬依赖） |
| pnpm | `corepack enable` 启用（Node 内置，零下载） |
| git | **按需**：仅 GitHub 插件安装/更新时需要；缺失时给出提示，不阻塞 DSH 安装与启动 |

### 3.3 分级安装选项（设置页）

- **默认：便携版（推荐低配）**——镜像下载、解压即用、不污染系统
- **高级：系统包管理器**——保留现有 winget/brew/apt 路径
- 自动检测：若系统内存 < 4GB 或已有便携版环境，默认选中便携版

### 3.5 运行配置选择通道

低配置电脑可能同时存在「便携版 Node」与「系统 Node」，或需要为 DSH 运行时
调整资源配置。设置页新增「运行配置」区块，提供选择通道：

- **运行时选择**：
  - 自动（推荐）：优先便携版（若有），否则系统版
  - 便携版：强制用 `~/.dsh/env/node`
  - 系统版：强制用系统 PATH 中的 node
- **DSH 启动配置**：
  - 低资源模式（开关）：启动 `dsh web` 时注入 `NODE_OPTIONS=--max-old-space-size=<val>`
    与减少并发（供 <4GB 内存机器使用），默认值 512MB
  - 端口选择：自定义 DSH Web 端口（默认 3080），写入启动命令 `--port`
- **持久化**：选择结果存 `manager.runtime` 配置键（`{ node: 'auto'|'portable'|'system',
  lowMemory: bool, maxOldSpace: number, port: number }`）
- **生效**：`dsh:start` 与 `resolveDSHCommand` 读取该配置决定 PATH 注入与启动参数

### 3.4 与现有代码的衔接

- `env-check.js`：`checkNode/checkNpm` 增加便携版路径探测（`~/.dsh/env/node` 存在且可执行）
- `ipc-handlers.js`：新增 `app:install-nodejs-portable`（镜像下载+解压+校验），
  `app:install-nodejs` 保留为系统包管理器路径
- `installer.js`（DSH 安装器）：`requireNodeAndNpm` 时若系统 node 缺失但便携版存在则用便携版
- 前端：安装页环境检测区新增「便携版安装（推荐低配）」按钮；检测结果标注便携版来源

## 四、数据流

```
点击「便携版安装 Node」
  → IPC app:install-nodejs-portable
  → 下载 npmmirror zip（流式进度推送）
  → 解压到 ~/.dsh/env/node/
  → 校验 node --version / npm --version
  → 返回成功 → 前端刷新环境检测
后续 DSH 安装/启动：resolveDSHCommand 动态注入便携版 PATH
```

## 五、错误处理

- 下载失败（网络/镜像不可用）：回退提示用系统包管理器或官网下载
- 解压失败（zip 损坏）：删除残留目录，报错提示重试
- 校验失败（node 不可执行）：报错并清理
- 便携版与系统版并存：便携版优先（按需注入），不冲突

## 六、范围（YAGNI）

- 首期：仅 Windows 便携版（win-x64 zip）；darwin/linux 便携版留待后续（保留架构）
- 不做：自动版本更新、多版本管理（node 版本切换器）
- 不影响：DSH 安装、插件市场、现有系统包管理器路径

## 七、测试

- 低配环境：便携版安装后 node/npm 可执行、DSH 可安装启动
- 卸载：删除 `~/.dsh/env/node` 后系统无残留
- 并行：便携版与系统 Node 并存时优先便携版
- 回归：系统包管理器路径仍可用
