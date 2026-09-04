<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# AI 生图功能设计（v1 文生图）

日期：2026-09-02
状态：用户已批准（2026-09-02）

## 目标
让 Manager 的生图能力真实可用：直接调用 OpenAI 兼容 /v1/images/generations 端点生成图片，保存到本地文件。绕开 DSH 0.1.2-alpha.4 适配器仅文本输出（不支持 assistant image 块）的上游限制。

## 背景
- DSH pi-ai 适配器不支持图片输出（case image: throw），无内建生图工具，能力路由的 image 映射是空中楼阁。
- GitHub 参考：dickpy/dsh-imagegen（OpenAI 兼容 images/generations + 保存本地）。
- 用户确认：独立「AI 生图」页面；复用现有 LLM provider 配置；仅文生图。

## 架构
- 主进程（electron/ipc-handlers.js）：
  - imagegen:generate：解析 provider、调 API、保存 base64 到本地、返回 path
  - imagegen:open-folder：用 shell.openPath 打开图片目录
- 渲染进程（src/assets/js/app.js + src/index.html）：
  - 侧边栏新增「AI 生图」nav-item + page-imagegen
  - pageManager.register('imagegen', render)
  - UI：provider 下拉 + 模型下拉 + 提示词输入 + 生成按钮 + 预览 + 打开文件夹按钮
- preload.cjs：暴露 imagegenGenerate / imagegenOpenFolder

## 数据流
1. renderer 调 window.dshManager.imagegenGenerate({ providerKey, model, prompt, size })
2. main：DSHConfig findProvider → baseURL + apiKeyEnv → 读真实密钥（env 前缀读 process.env，否则读 credentials[apiKeyEnv]）
3. fetch POST {baseURL}/images/generations，body { model, prompt, size:'1024x1024', response_format:'b64_json' }，240s 超时
4. 成功：解 base64 保存到 用户目录/dsh-manager/images/yyyyMMdd-HHmmss.png，返回 path
5. 失败：返回结构化错误（HTTP 状态/模型不支持/超时/无 provider/无 key）

## 错误处理
- 未配置 provider/模型 → NOT_FOUND：提示去 LLM 提供商配置
- 密钥缺失 → 提示重新保存 provider
- HTTP 非 2xx → 显示状态码+错误信息
- 超时 → 提示生图模型较慢请重试
- 响应无 b64_json/data → UNSUPPORTED：提示确认模型支持 images/generations

## 保存目录
用户目录/dsh-manager/images/（固定目录，用户易找）

## 测试
- packages/core 单元：provider 解析 + apiKey 解析
- mock fetch：验证请求体、base64 保存、错误分支
- 手动：test exe 用户实测（需 yang-newapi 支持生图端点）

## 范围外（后续）
图生图、尺寸选择、负面提示、历史画廊、并发队列