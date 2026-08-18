---
name: github-actions-docs
description: 当用户询问如何编写、解释、自定义、迁移、保护或排查 GitHub Actions 工作流、语法、触发器、矩阵、运行器、可复用工作流、制品、缓存、密钥、OIDC、部署、自定义操作或 Actions Runner Controller 时使用，尤其是需要官方文档、精确链接或基于文档的 YAML 指导时。
disable-model-invocation: false
user-invocable: true
---
# GitHub Actions Docs

## 何时使用

用户询问 GitHub Actions 相关主题：
- 编写/解释/自定义/迁移/保护/排查 workflow 与 workflow 语法
- 触发器、矩阵、运行器、可复用工作流、制品、缓存、密钥、OIDC、部署
- 自定义操作、Actions Runner Controller

尤其是当答案应来自官方 GitHub 文档、需要精确链接、或需要基于文档的 YAML 指导时。

## 核心原则

- **基于文档回答**：以官方 GitHub 文档为依据，给出精确链接
- 不猜测 API 或语法；查阅官方文档确认
- 提供可复制的 YAML 片段作为示例

## 流程

1. 确认用户的具体主题（语法 / 触发器 / 部署 / 安全等）
2. 检索或引用官方文档对应章节
3. 给出精确文档链接与要点说明
4. 如有需要，提供最小可用的示例 YAML
5. 说明版本/环境相关注意点（如自托管运行器、价格、限制）

## 常见主题速查

- 触发器：`on` 语法（push / pull_request / workflow_dispatch / schedule / repository_dispatch 等）
- 矩阵：`strategy.matrix` 跨版本/平台并行
- 运行器：GitHub 托管 vs 自托管，`runs-on`
- 可复用工作流：`workflow_call` 与 `workflow_dispatch` 组合
- 制品与缓存：`actions/upload-artifact`、`actions/cache`
- 密钥与 OIDC：`secrets`、`permissions`、`id-token`、OIDC 可信发布
- 自定义操作：composite / JavaScript / Docker 三类
- ARC：Actions Runner Controller（Kubernetes 自托管扩展）

## 注意

- 用户问"怎么写/怎么配/报错 X"时，先给结论再给依据
- 涉及第三方 action 时提示锁版本（pin）与安全审查
