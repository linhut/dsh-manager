# @dsh-manager/dsh-capability-router

按消息内容自动切换 LLM provider/model 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件。

| 消息内容 | 路由能力 | 说明 |
|---|---|---|
| 含图片块 | `vision`（识图） | 优先于其它判定 |
| 代码特征文本（围栏块 / 文件路径+语言扩展 / 编程关键词） | `code`（代码） | |
| 其它 | `defaultCapability` | 默认 `semantic`（语义理解） |

## 安装 / Installation

### 方式一：DSH Manager（推荐）

随 [dsh-manager](https://github.com/linhut/dsh-manager) 内置。在 Manager 的「能力路由」界面启用后，安装器会把本插件复制进 profile 的 `node_modules`，并按官方机制登记到 profile 清单的 `dsh.profile.bundles`。

### 方式二：命令行

```sh
dsh plugin --profile web add /path/to/dsh-manager/packages/plugins/dsh-capability-router
```

本包声明了官方 `dsh.bundle.patch`（`cordis.patch.yml`），`dsh plugin` 会把它自动加入 profile 的 bundle 补丁层栈。

## 配置 / Configuration

配置位于 profile 的 `settings.yaml` 的 `capability-router` 段（热加载，无需重启）：

```yaml
capability-router:
  enabled: true
  defaultCapability: semantic
  capabilities:
    semantic:
      provider: yang-newapi
      model: deepseek-v4-flash
    vision:
      provider: yang-newapi
      model: glm-5v-turbo
    code:
      provider: yang-newapi
      model: deepseek-v4-flash
```

- `enabled`：总开关，缺省 `true`。
- `defaultCapability`：无命中时的能力，缺省 `semantic`。
- `capabilities.<name>.provider/.model`：该能力对应的 provider 路由键与模型 id。

### 行为约定

- 仅当路由启用、对应能力已配置、且 provider 已被适配器注册时改写请求；否则原样透传。
- 模型目录（`llm.listModels`）为官方 advisory 语义：未列入目录不拒绝请求，最终由 DSH 的 `prepareCall` 兜底校验。
- 生图能力当前不可用：`defaultCapability: image` 时回退语义能力（未配置语义则透传）。
- 改写仅替换 `provider`/`model`，并抹除旧的 `reasoningEffort`，其余请求配置保留。

## 运行日志 / Runtime log

每次命中路由会写入 `~/.dsh/manager/capability-router.log`（`DSH_HOME` 存在时以它为准），
Manager 端通过 IPC 读取并在「能力路由」界面展示，便于确认"是否真的切换了模型"。

## 开发 / Development

- `cordis.patch.yml`：bundle 补丁层，为 profile 树插入 `capability-router` 条目。
- `lib/index.js`：插件主服务，监听 `agent/created` / `agent/request` 瀑布（`prepend: true` 最外层），
  并注册 `settings` 段实现热加载。
- 与官方 API 对齐的要点：`ctx.skills` 无关；依赖 `dsh-settings` 的 `installSection`、
  `dsh-llm` 的 `listProviders` / `listModels`、`dsh-agent` / `dsh-session` 的
  `agent/request` 瀑布与 `session.ownEvents()`。

## 许可证 / License

MIT © Jose AI（见 dsh-manager 仓库 [LICENSE](../../../LICENSE)）。