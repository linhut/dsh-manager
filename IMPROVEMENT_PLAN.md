<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# DSH Manager 改进计划

## 已完成审计（2026-02 更新）
- ✅ 53/53 检查通过 (verify.mjs)
- ✅ 67/67 测试通过 (run-tests.mjs，含新增 T7/T8 架构与安全测试、T9 核心修复回归)
- ✅ 101 个 IPC 处理器与 101 个 preload 调用一致
- ✅ 版本一致性: 根 1.3.5, core 1.3.5, marketplace 1.3.5, package-lock 1.3.5
- ✅ IPC 事件收发一致性（send ↔ on 全匹配）
- ✅ 无原生 confirm()/alert()/eval()/Function() 调用
- ✅ XSS 审计通过（innerHTML 动态值全部转义）
- ✅ MCP 审计 43/43 PASS (audit-mcp-prompts.mjs)
- ✅ 测试构建通过 (build-test.cjs)

## 问题清单（全部已完成 ✅）

### 1. 架构问题 ✅
- [x] app.js 单文件 → 已抽取为模块化架构（modules/ 目录 + PageManager + constants + shortcuts）
- [x] 页面模块化 → PageManager 管理页面生命周期（注册/懒加载/渲染）
- [x] 类型安全 → 关键模块补充 JSDoc 注释
- [x] IPC 统一通信层 → utils.js callIPC（超时 + 错误规范化 + 可选重试）

### 2. 用户体验问题 ✅
- [x] 异步加载状态 → showLoading/骨架屏样式
- [x] Toast 通知增强 → 支持堆叠、类型、操作按钮、点击关闭
- [x] 原生 confirm() → 全部替换为 showConfirm() 模态确认框（17 处）
- [x] 键盘快捷键 → shortcuts.js 模块（Ctrl+1~8 页面切换、Ctrl+F 搜索、F5 刷新、Escape 关闭、Ctrl+Shift+D 调试）
- [x] 搜索反馈 → debounce 搜索 + 结果计数显示

### 3. 性能问题 ✅
- [x] 页面懒加载 → PageManager.register + navigate 按需渲染
- [x] 请求缓存 → utils.js cachedRequest（带 TTL）
- [x] DOM 操作 → 批量更新（DocumentFragment/createElement）
- [x] 超时管理 → TimeoutManager.timeoutPromise 统一管理（消除 4 处重复 Promise.race）
- [x] netstat 缓存 → process-manager 3s TTL 缓存（findAvailablePort 探测 20 端口时避免重复跑 netstat）
- [x] 目录大小统计异步化 → data-manager dirSize 深度限制 + 分批让出事件循环
- [x] 便携版 Node 流式下载 → 不整包载入内存（OOM 防护）+ Content-Length 校验 + 背压处理
- [x] 技能导入排除大目录 → importFromDirectory 排除 .git/node_modules/.DS_Store

### 4. 代码质量问题 ✅
- [x] XSS 修复 → 所有 innerHTML 动态插值转义（escapeHtml/escapeAttr），img src scheme 白名单
- [x] 错误处理 → 统一全局 error/unhandledrejection 处理器
- [x] 重复代码 → 提取为共享函数（状态更新、超时检测等）+ listDSHVersions 复用 registry 参数
- [x] 魔法字符串 → constants.js 集中管理（页面 ID、存储键、主题键等）
- [x] 代码风格 → config.js 全部 var → const/let，arrow function 统一

### 5. 安全与健壮性问题 ✅
- [x] zip64 检测 → skill-manager 拒绝超大 zip 格式并明确报错
- [x] zip 截断校验 → 中央目录条目数与实际解析数比对
- [x] AbortSignal.timeout 兼容 → 全部替换为 AbortController + setTimeout（Node <17.3）
- [x] YAML 下划线键保留 → toYAML 仅跳过 _comment/_order 元键，不再静默丢配置
- [x] 对称引号剥离 → MCP parseKvLine 仅剥首尾相同的引号
- [x] PNPM_NOT_FOUND 错误码 → pnpm-check 使用语义化错误码
- [x] DSHError cause 链 → 保留原始错误链
- [x] Node 最低版本校验 → requireNodeAndNpm 检查 >= 20.1
- [x] stderr 版本输出识别 → checkCommand 从 stderr 提取版本
- [x] readdirSync recursive 兼容 → installer 手动遍历（Node <20.1）
- [x] profile 备份排除大目录 → 排除 node_modules/.git 等
- [x] AGENTS.md 写入错误包装 → reply-language 失败转 DSHError
- [x] isDSHInPath 语义修正 → 检查 PATH 而非安装状态
- [x] 便携版 Node 解压提示 → Windows 低版本给出明确指引
- [x] LTS 过滤兼容 → 接受 lts: true 布尔值

### 6. 功能完整性 ✅
- [x] MCP 管理、提示词管理、技能管理功能已通过测试验证
- [x] 插件市场、版本管理、设置页面所有操作已通过测试验证
- [x] master-prompt render 增加 yaml 格式支持
- [x] 内容类型防御 → list() 过滤非字符串 content 不崩溃

## 新增架构组件

| 组件 | 位置 | 说明 |
|------|------|------|
| PageManager | modules/page-manager.js | 页面生命周期管理（注册/懒加载/导航） |
| constants.js | modules/constants.js | 集中管理页面 ID、存储键、主题键等魔法字符串 |
| shortcuts.js | modules/shortcuts.js | 键盘快捷键管理（Ctrl+1~8、Ctrl+F、F5 等） |
| TimeoutManager | modules/utils.js | 统一超时管理（timeoutPromise） |
| Toast 系统 | modules/utils.js | 类型化通知（成功/错误/警告/信息），支持堆叠与操作 |
| 模态确认 | modules/utils.js | showConfirm/showAlert 替代原生 dialogs |
| callIPC | modules/utils.js | IPC 统一通信层（超时 + 错误规范化 + 可选重试） |

## 新增审计测试

- **T7 架构检查**（tests/architecture.test.mjs）：IPC 事件一致性、新模块存在性、无原生 confirm、无 eval/Function、lock 版本一致、timeoutManager 使用、快捷键初始化
- **T8 安全审计**（tests/full-functional.test.mjs）：innerHTML 裸插值检测（XSS）、原生 confirm/alert 检测
- **T9 核心修复回归**（tests/core-fixes.test.mjs）：19 项核心修复回归测试（流式下载、zip64、YAML 下划线键、IPC 层等）

## 后续建议（可选）

1. 为 renderer 端引入 TypeScript 或 JSDoc 类型标注（渐进式）
2. 将 app.js 中剩余的页面渲染函数（约 1200 行）进一步拆分到 pages/ 目录
3. 添加单元测试覆盖 IPC handler 的业务逻辑
4. 添加 E2E 测试（Playwright + Electron）

## 本轮改进（2026-08 更新）
- ✅ 版本一致性修复: root/core/marketplace/lock 统一为 1.3.6
- ✅ 提示词页面增强: 添加搜索框（关键词过滤）、分类过滤按钮、批量启用/禁用/删除已禁用操作、按分类分组显示（可折叠）
- ✅ 修复核心包 40+ 处空 catch 块：添加 console.warn 日志记录错误信息
- ✅ 提取魔法字符串 `@deepseek-ai/dsh` 为 `DSH_PACKAGE_NAME` 常量（dsh-utils.js）
- ✅ 修复 IPC 事件命名一致性：`plugin-install-progress` → `dsh:plugin-install-progress`，`env-install-progress` → `dsh:env-install-progress`
- ✅ 修复 marketplace manager.js `getStats()` 中 `needsUpdate` 硬编码为 0 的问题
- ✅ 所有审计通过：67/67 测试、53/53 verify、43/43 MCP
- ✅ 修复 gongwen-skill 安装/更新问题：
  - getPackageJson 使用仓库实际默认分支而非硬编码 main
  - _getGitHubPluginInfo 返回 defaultBranch 并传递正确分支
  - git clone 降级路径使用 info.defaultBranch 而非硬编码 main
  - featured 插件 gongwen-skill defaultBranch → master
  - checkPluginUpdate 增加 npm registry 兜底版本检测
  - getPluginDetails 传递 defaultBranch 给 getPackageJson
  - skill-manager importFromGitHub 通过 API 获取仓库实际默认分支
  - app.js README 图片 URL 使用 info.defaultBranch 而非硬编码 main
  - 版本号 1.3.6 → 1.3.7
- ✅ 新增"安装完成后重启提示"功能（v1.3.8）：
  - installer.js 所有成功返回（安装/卸载）新增 needsRestart: true 标志
  - preload.cjs 新增 restartDSH（组合 dsh:stop + dsh:start）
  - app.js 安装进度模态框支持"重启 DSH 以生效"按钮
  - 插件安装（市场/自定义源/批量安装）完成后若需要重启自动提示
  - 插件卸载完成后 toast 提示"重启后生效"并提供重启按钮
  - 技能导入（GitHub/目录）完成后提示"新会话生效"并提供重启按钮
  - 版本号 1.3.7 → 1.3.8
