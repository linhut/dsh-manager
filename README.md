<p align="center">
  <img src="logo/dsh-manager-whale_v01_transparent-256.png" alt="DSH Manager Logo" width="128">
</p>

# 🐳 DSH Manager

> **DeepSeek Harness 桌面管理工具** — 像 ccswitch 一样，简单、直观、强大

🌐 **官网**: [https://dsh.linhut.cn/](https://dsh.linhut.cn/)

[![Build](https://github.com/linhut/dsh-manager/actions/workflows/build.yml/badge.svg)](https://github.com/linhut/dsh-manager/actions/workflows/build.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/linhut/dsh-manager/releases)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/linhut/dsh-manager/releases)
[![Linux](https://img.shields.io/badge/platform-Linux-orange)](https://github.com/linhut/dsh-manager/releases)
[![Website](https://img.shields.io/badge/website-dsh.linhut.cn-4F46E5)](https://dsh.linhut.cn/)
[![GitCode](https://img.shields.io/badge/GitCode-repo-4F46E5)](https://gitcode.com/linhut/dsh-manager)
[![AtomGit](https://img.shields.io/badge/AtomGit-repo-4F46E5)](https://atomgit.com/linhut/dsh-manager)

### 📦 镜像仓库

| 平台 | 地址 |
|------|------|
| 🐙 **GitHub** | [github.com/linhut/dsh-manager](https://github.com/linhut/dsh-manager) |
| 🔵 **GitCode** | [gitcode.com/linhut/dsh-manager](https://gitcode.com/linhut/dsh-manager) |
| 🟢 **AtomGit** | [atomgit.com/linhut/dsh-manager](https://atomgit.com/linhut/dsh-manager) |

---

## 📥 下载

从 [GitHub Releases](https://github.com/linhut/dsh-manager/releases) 下载最新版本：

| 平台 | 安装包 | 说明 |
|------|--------|------|
| 🪟 **Windows** | `.exe` | NSIS 安装程序，双击安装 |
| 🍎 **macOS** | `.dmg` | 磁盘映像，拖到 Applications |
| 🐧 **Linux** | `.AppImage` | 添加执行权限后运行 |

---

## 🚀 功能

### 🏠 DSH 控制台
- 安装后自动打开 DSH Web 界面
- 集成浏览器视图，直接在工具中管理 DSH
- 一键启动/停止 DSH 服务

### 📥 安装 / 升级
- 一键安装 DeepSeek Harness
- 自动检测 Node.js 环境
- 检查更新，一键升级
- 安全卸载

### 🔌 插件管理
- **插件市场**：自动搜索 GitHub 上 `dsh-plugin` 标签的仓库
- 一键安装/卸载插件
- 插件更新检测
  
### 📦 版本管理
- 查看当前 DSH 版本
- 浏览所有可用版本
- 检查更新

### ⚙️ 设置
- **Manager 设置**：自动启动 DSH 控制台、启动时检查更新、回复语言、界面主题
- **LLM 提供商管理**：可视化管理模型供应商（名称/类型/模型/API Key），支持添加/编辑/删除
- **YAML 编辑器**：直接编辑 ~/.dsh/settings.yaml，带语法解析、保存二次确认
- **Agent Presets**：查看已配置的 Agent 预设
- **系统管理**：MCP 服务端管理、Profile 管理、数据管理

---

## 🛠️ 技术栈

- **桌面框架**: Electron 33
- **前端**: 原生 HTML + CSS + JavaScript
- **核心逻辑**: Node.js (ESM)
- **打包**: electron-builder
- **CI/CD**: GitHub Actions (自动构建 Windows/macOS/Linux)

---

## 🔧 开发指南

```bash
# 克隆仓库
git clone https://github.com/linhut/dsh-manager.git
cd dsh-manager

# 安装依赖
npm install

# 启动开发模式
npm run dev

# 构建当前平台安装包
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

---

## 📦 项目结构

```
dsh-manager/
├── electron/           # Electron 主进程
│   ├── main.js         # 主进程入口
│   ├── preload.js      # 预加载脚本 (IPC 桥)
│   └── ipc-handlers.js # IPC 通信处理
├── src/                # 渲染进程 (GUI)
│   ├── index.html      # 主页面
│   └── assets/
│       ├── css/style.css
│       └── js/app.js
├── packages/           # 核心逻辑
│   ├── core/           # DSH 安装、配置、版本管理
│   └── marketplace/    # 插件市场
├── build/              # 构建资源
└── package.json
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

MIT License