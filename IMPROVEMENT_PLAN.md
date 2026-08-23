# DSH Manager 改进计划

## 已完成审计（2026-02 更新）
- ✅ 53/53 检查通过 (verify.mjs)
- ✅ 48/48 测试通过 (run-tests.mjs，含新增 T7/T8 架构与安全测试)
- ✅ 100 个 IPC 处理器与 100 个 preload 调用一致
- ✅ 版本一致性: 根 1.3.5, core 1.3.5, marketplace 1.3.5, package-lock 1.3.5
- ✅ IPC 事件收发一致性（send ↔ on 全匹配）
- ✅ 无原生 confirm()/alert()/eval()/Function() 调用
- ✅ XSS 审计通过（innerHTML 动态值全部转义）

## 问题清单（全部已完成 ✅）

### 1. 架构问题 ✅
- [x] app.js 单文件 → 已抽取为模块化架构（modules/ 目录 + PageManager + constants + shortcuts）
- [x] 页面模块化 → PageManager 管理页面生命周期（注册/懒加载/渲染）
- [x] 类型安全 → 关键模块补充 JSDoc 注释

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

### 4. 代码质量问题 ✅
- [x] XSS 修复 → 所有 innerHTML 动态插值转义（escapeHtml/escapeAttr），img src scheme 白名单
- [x] 错误处理 → 统一全局 error/unhandledrejection 处理器
- [x] 重复代码 → 提取为共享函数（状态更新、超时检测等）
- [x] 魔法字符串 → constants.js 集中管理（页面 ID、存储键、主题键等）

### 5. 功能完整性 ✅
- [x] MCP 管理、提示词管理、技能管理功能已通过测试验证
- [x] 插件市场、版本管理、设置页面所有操作已通过测试验证

## 新增架构组件

| 组件 | 位置 | 说明 |
|------|------|------|
| PageManager | modules/page-manager.js | 页面生命周期管理（注册/懒加载/导航） |
| constants.js | modules/constants.js | 集中管理页面 ID、存储键、主题键等魔法字符串 |
| shortcuts.js | modules/shortcuts.js | 键盘快捷键管理（Ctrl+1~8、Ctrl+F、F5 等） |
| TimeoutManager | modules/utils.js | 统一超时管理（timeoutPromise） |
| Toast 系统 | modules/utils.js | 类型化通知（成功/错误/警告/信息），支持堆叠与操作 |
| 模态确认 | modules/utils.js | showConfirm/showAlert 替代原生 dialogs |

## 新增审计测试

- **T7 架构检查**（tests/architecture.test.mjs）：IPC 事件一致性、新模块存在性、无原生 confirm、无 eval/Function、lock 版本一致、timeoutManager 使用、快捷键初始化
- **T8 安全审计**（tests/full-functional.test.mjs）：innerHTML 裸插值检测（XSS）、原生 confirm/alert 检测

## 后续建议（可选）

1. 将 IPC 调用封装为统一通信层（错误码 + 超时 + 重试）
2. 为 renderer 端引入 TypeScript 或 JSDoc 类型标注（渐进式）
3. 将 app.js 中剩余的页面渲染函数（约 1200 行）进一步拆分到 pages/ 目录
4. 添加单元测试覆盖 IPC handler 的业务逻辑
