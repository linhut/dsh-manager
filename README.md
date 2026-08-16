# ⚡ DSH Manager

> **DeepSeek Harness 安装与管理工具** — DSH 生态的瑞士军刀

[![npm version](https://img.shields.io/badge/npm-v0.1.0-blue)](https://www.npmjs.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/dsh-manager/dsh-manager/pulls)

---

## 📦 安装

### 一键安装

```bash
# 通过 npm 全局安装（推荐）
npm install -g @dsh-manager/cli

# 或使用 npx 直接运行
npx @dsh-manager/cli
```

### 快速启动

```bash
# 启动交互式管理界面
dshm

# 或使用完整命令
dsh-manager
```

---

## 🚀 功能概览

### 🔧 DSH 安装管理
- 一键安装/卸载/升级 DeepSeek Harness
- 支持指定版本安装
- 多版本并行管理
- 自动检测系统环境

### 🛒 插件市场
- 自动扫描 GitHub 上带有 `dsh-plugin` 标签的仓库
- 可视化插件浏览和搜索
- 一键安装/卸载插件
- 自动更新检测

### 🩺 系统诊断
- 全面的环境检查（Node.js、npm、DSH 等）
- 网络连通性测试
- 配置完整性验证
- 问题修复建议

### ⚙️ 配置管理
- 查看/编辑 DSH 配置
- 管理 LLM 提供商
- 配置项快速查询

### 💻 交互式 TUI
- 美观的终端菜单界面
- 无需记忆命令
- 实时状态显示

---

## 📋 命令参考

### 基础命令

| 命令 | 说明 |
|------|------|
| `dshm` | 启动交互式 TUI（默认） |
| `dshm status` | 查看 DSH 状态 |
| `dshm doctor` | 系统诊断 |
| `dshm marketplace` | 浏览插件市场 |
| `dshm versions` | 版本管理 |

### 安装管理

| 命令 | 说明 |
|------|------|
| `dshm install dsh` | 安装最新版 DSH |
| `dshm install dsh --version 0.1.0-rc.3` | 安装指定版本 |
| `dshm install dsh --registry https://registry.npmmirror.com` | 使用镜像源 |
| `dshm uninstall` | 卸载 DSH |

### 插件管理

| 命令 | 说明 |
|------|------|
| `dshm plugin list` | 列出已安装插件 |
| `dshm plugin search <query>` | 搜索插件市场 |
| `dshm plugin info <id>` | 查看插件详情 |
| `dshm install plugin <source>` | 安装插件 |
| `dshm plugin remove <id>` | 卸载插件 |
| `dshm plugin update <id>` | 更新插件 |
| `dshm plugin check-updates` | 检查所有插件更新 |

### 配置管理

| 命令 | 说明 |
|------|------|
| `dshm config show` | 显示全部配置 |
| `dshm config show --key llm.provider` | 查看特定配置 |
| `dshm config set llm.provider openai` | 设置配置项 |
| `dshm config list-providers` | 列出 LLM 提供商 |

---

## 🏗️ 项目架构

```
dsh-manager/
├── packages/
│   ├── core/              # 核心库
│   │   └── src/
│   │       ├── index.js          # 入口
│   │       ├── installer.js      # DSH 安装器
│   │       ├── config.js         # 配置管理
│   │       ├── dsh-utils.js      # 工具函数
│   │       ├── version-manager.js # 版本管理
│   │       └── errors.js         # 错误处理
│   ├── cli/               # 命令行工具
│   │   └── src/
│   │       ├── bin.js            # CLI 入口
│   │       ├── tui.js            # 交互式终端界面
│   │       └── commands/
│   │           ├── install.js    # 安装命令
│   │           ├── status.js     # 状态命令
│   │           ├── doctor.js     # 诊断命令
│   │           ├── plugin.js     # 插件管理
│   │           ├── marketplace.js # 插件市场
│   │           ├── config.js     # 配置管理
│   │           ├── versions.js   # 版本管理
│   │           └── self-upgrade.js # 自我升级
│   └── marketplace/       # 插件市场模块
│       └── src/
│           ├── index.js          # 入口
│           ├── github-api.js     # GitHub API 封装
│           ├── registry.js       # 插件注册表
│           ├── installer.js      # 插件安装器
│           └── manager.js        # 插件管理器
├── website/               # 官网
│   ├── index.html
│   └── assets/
│       ├── css/style.css
│       └── js/main.js
├── package.json
└── README.md
```

---

## 🔌 插件市场机制

DSH Manager 的插件市场通过以下机制工作：

1. **自动发现**：使用 GitHub API 搜索带有 `dsh-plugin` 主题标签的仓库
2. **信息聚合**：获取仓库的 README、Stars、版本、语言等信息
3. **一键安装**：通过 `dsh plugin --profile <name> add <package>` 命令安装
4. **本地管理**：在 `~/.dsh/manager/plugins.json` 中维护本地插件注册表

### 如何发布插件

1. 在 GitHub 上创建仓库，添加 `dsh-plugin` 主题标签
2. 确保仓库包含有效的 `package.json`
3. 提交到 npm 注册表（可选）
4. 插件将自动出现在 DSH Manager 插件市场中

---

## 🌐 官网

项目官网为静态站点，位于 `website/` 目录，可部署到 GitHub Pages。

访问地址：https://dsh-manager.github.io

---

## 🤝 贡献指南

我们欢迎所有形式的贡献！

1. Fork 本仓库
2. 创建你的特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交你的改动 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### 开发指南

```bash
# 克隆仓库
git clone https://github.com/dsh-manager/dsh-manager.git
cd dsh-manager

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

---

## 📄 许可证

本项目基于 MIT 许可证开源 — 详见 [LICENSE](LICENSE) 文件。

---

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) - 强大的 AI 应用开发框架
- [Cordis](https://github.com/cordiverse/cordis) - 插件化应用框架
- 所有 DSH 插件开发者

---

<div align="center">
  <strong>DSH Manager</strong> — Making DeepSeek Harness management simple.
</div>