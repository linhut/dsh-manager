# DSH Manager vs dsh-desktop-hub 功能对比分析

> 对比日期：2026-08-20
> 参考项目：[FlashingChen/dsh-desktop-hub](https://github.com/FlashingChen/dsh-desktop-hub) (v0.1.0, 34 stars)
> 本项目：dsh-manager (v1.3.3)

## 核心架构对比

| 维度 | dsh-manager | dsh-desktop-hub |
|------|------------|-----------------|
| 语言 | JavaScript (ESM) | TypeScript |
| 包管理 | npm workspaces | npm |
| 构建 | electron-builder | electron-builder |
| 类型系统 | 无（纯 JS） | 强类型（多 tsconfig） |
| 测试 | node --test | node --test + smoke scripts |
| 验证 | scripts/verify.mjs | scripts/verify.mjs + verify-m1.mjs |
| 版本 | 1.3.3 (稳定版) | 0.1.0 (早期开发版) |

## 功能矩阵

| 功能 | dsh-manager | dsh-desktop-hub | 备注 |
|------|------------|-----------------|------|
| DSH 安装/升级 | ✅ | ✅ | 两者均支持 |
| DSH 启动/停止/诊断 | ✅ | ✅ | |
| 内嵌 Web UI | ✅ | ✅ | dsh-manager 用 webview |
| 插件市场 | ✅ | ✅ | 两者均支持 GitHub 搜索 |
| MCP 管理 | ✅ | ✅ | dsh-hub 有 MCP 市场 |
| Skills 管理 | ✅ | ✅ | 两者均支持导入/编辑 |
| 版本管理 | ✅ | ✅ | |
| 回复语言设置 | ✅ | ❌ | dsh-manager 独有 |
| 便携 Node.js | ✅ | ✅ (bundled ~586MB) | dsh-hub 捆绑运行时 |
| 原子写入备份 | ✅ (新增) | ✅ | dsh-hub 原生支持 |
| 自动化验证 | ✅ (新增) | ✅ | dsh-hub 有完整审计 |
| 单元测试 | ✅ (新增) | ✅ | |
| 多 Tab 工作区 | ❌ | ✅ | dsh-hub 5-tab 布局 |
| TypeScript | ❌ | ✅ | |
| 安全审计 | ✅ (已修复) | ✅ (AUDIT_REPORT.md) | |

## 本项目的优势

1. **成熟稳定**：v1.3.3 已发布多版本，经过实际使用验证
2. **回复语言设置**：通过 AGENTS.md 注入语言指令，支持中文/英文/跟随系统
3. **便携 Node.js**：支持安装便携版 Node.js，无需系统级安装
4. **Profile 管理**：完善的 profile 备份/恢复/创建功能
5. **依赖完整性检查**：自动修复损坏的 profile 依赖
6. **模块化架构**：通过 refactoring 将 4351 行 app.js 拆分为 6 个独立模块

## 参考项目的优势

1. **TypeScript 支持**：强类型带来更好的 IDE 支持和代码维护性
2. **捆绑运行时**：~586MB 捆绑 Node.js + DSH，真正"开箱即用"
3. **多 Tab 工作区**：5 个标签页提升多任务效率
4. **MCP 市场**：统一管理 MCP 服务器
5. **安全审计报告**：AUDIT_REPORT.md 记录了完整的 P0-P3 问题修复
6. **原子写入**：所有写操作自动备份 .bak-<ts>，可随时回滚

## 已采纳的改进

基于参考项目的最佳实践，以下改进已应用到 dsh-manager：

1. ✅ **自动化验证脚本** (scripts/verify.mjs)：53 项检查覆盖骨架、语法、IPC、版本、CSS、页面契约
2. ✅ **单元测试** (tests/skeleton.test.mjs)：9 个测试覆盖核心模块加载和基本功能
3. ✅ **原子写入备份** (packages/core/src/config.js)：Config 写入时自动创建 .bak 备份，保留最近 5 个
4. ✅ **XSS 安全修复**：修复了模型选择下拉框、技能卡片 onclick 处的跨站脚本漏洞
5. ✅ **CSS 修复**：修复了样式表中损坏的注释块，添加了缺失的 select 样式
6. ✅ **模块化架构**：将 4351 行 app.js 拆分为 6 个独立模块

## 后续建议

1. 考虑迁移到 TypeScript（渐进式，先迁移 core 包）
2. 实现多 Tab 工作区布局
3. 添加 MCP 市场功能
4. 考虑捆绑 Node.js 运行时以提供"开箱即用"体验
5. 增加更多安全审计覆盖（路径遍历、DOM XSS 等）
