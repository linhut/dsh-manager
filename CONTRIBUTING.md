# 🤝 贡献指南

感谢你考虑为 DSH Manager 贡献代码！

## 开发流程

### 1. 环境准备

```bash
# 克隆仓库
git clone https://github.com/dsh-manager/dsh-manager.git
cd dsh-manager

# 安装依赖
npm install
```

### 2. 开发

项目使用 Monorepo 结构，所有源代码在 `packages/` 目录下。

```bash
# 开发模式
npm run dev
```

### 3. 提交信息规范

我们使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 添加新功能
fix: 修复 Bug
docs: 文档更新
chore: 维护性工作
refactor: 重构
test: 测试相关
```

### 4. 创建 Pull Request

1. 确保你的代码通过 lint 检查
2. 更新相关文档
3. 创建 PR 时描述清楚改动内容

## 开发指南

### 添加新命令

1. 在 `packages/cli/src/commands/` 下创建新的命令文件
2. 在 `packages/cli/src/bin.js` 中注册命令
3. 在 `packages/cli/src/index.js` 中导出

### 扩展插件市场

1. 修改 `packages/marketplace/src/github-api.js` 增加新的 API 调用
2. 在 `packages/marketplace/src/registry.js` 中扩展搜索逻辑

## 代码风格

- 使用 ES Module (`import/export`)
- 使用 JSDoc 注释
- 遵循现有代码风格