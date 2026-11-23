<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# DSH Manager 优化设计
## 对齐 DSH 0.2.x 官方开发规范（基线 0.2.1-rc.5）

> 规范来源：`deepseek-ai/deepseek-harness` 官方 docs（固定 revision `b830ec950`）及其中文对照站 dshx.dev（核对日期 2026-11-01）。
> 本文只做设计，不改动现有行为；每条结论都标注了代码位置，可按阶段独立实施。

---

## 0. 规范适用性判定

DSH Manager 不是 DSH 插件包——它不上架 `dsh plugin add`，不声明 `dsh.bundle`，也不进 profile。它是 **DSH 的桌面宿主（Host）**：管理 DSH 的安装、进程、配置、技能与插件。因此官方规范不能整篇照搬，必须按"直接适用 / 转译适用 / 不适用"三类处理。

| 官方规范条款 | 原文要求 | 本项目映射 | 适用性 |
|:---|:---|:---|:---|
| 显式依赖（`inject`） | 服务名必须与消费名完全匹配，缺失依赖不上线 | IPC 通道即服务契约：通道名、入参、返回必须单一来源声明，禁止"渲染端猜通道名" | 直接适用 |
| 生命周期 100% 可逆 | 所有副作用登记 disposer，卸载后宿主行为完全还原 | 每个 handler 模块、每个页面、每个 webview 必须能完整卸载 | 直接适用 |
| 跨端物理隔离 | Browser 端不得调 Node 原生模块，Host Context 不得泄露前端 | 主进程 / preload / 渲染进程 / webview 四层边界 | 直接适用 |
| 配置必须 schema 校验 | Config 用 Standard Schema，非法输入明确报错 | IPC 入参校验 + `settings.yaml` 结构校验 | 直接适用 |
| 可取消、可卸载、可验证 | 长任务传 `signal`，交付附验证证据 | 安装/升级/同步等长任务支持取消；交付附可复现验收 | 直接适用 |
| 源码至上 | 以真实运行时代码与导出为准，不凭记忆 | 所有 DSH 版本适配以实际 CLI/配置契约为准，已由 `dsh-web-contract.js` 承担 | 直接适用 |
| 一切皆插件、单一职责 | 能力解耦为独立插件 | 147 个 IPC 通道按域拆为 handler 模块 | 转译适用 |
| Bundle / Profile / patch 层序 | `dsh.bundle` 声明、profile bundles 顺序 | 本项目是管理这些对象的**操作方**，不是被管理对象；仅需正确实现"层序可视化" | 转译适用 |
| `defineTool` / `presentCall` / UI 卡片 | 工具契约与卡片纯函数 | 不适用（本项目不注册模型工具） | 不适用 |

**判定结论**：本项目应遵循的是规范中的 **Host 侧纪律**——契约单一来源、资源可逆、跨端隔离、配置校验、验证可复现——而不是插件打包那一套。

---

## 1. 现状体检（量化）

| 维度 | 现状 | 规范要求 | 差距 |
|:---|:---|:---|:---|
| IPC 契约 | 147 个 `ipcMain.handle` 集中在一个 2856 行文件；`preload.cjs` 手写 140+ 个平铺方法 | 契约单一来源、显式声明、可校验 | **P0** |
| 入参校验 | 无统一校验，渲染进程可传任意对象/任意路径进主进程 | 非法输入必须明确拒绝 | **P0** |
| 错误语义 | 全文件仅 3 处 `throw new`；错误多为字符串，无错误码 | 异常与领域状态分离，错误可分类 | **P1** |
| webview 隔离 | `<webview>` 无 `partition`，与主窗口共享 default session；无 `will-attach-webview` 钩子 | 跨端物理隔离 | **P0** |
| 权限策略 | 无 `setPermissionRequestHandler`（摄像头/定位/通知默认走 Electron 默认值） | 默认拒绝、按需放行 | **P0** |
| 前端结构 | `app.js` 5733 行 / 186 个函数 / 10 个页面；模块用全局脚本加载，无 `export` | 单一职责、可卸载 | **P1** |
| DOM 安全 | `app.js` 中 100 处 `innerHTML` | 输出必须转义或走 DOM 构建 | **P1** |
| 资源生命周期 | `setInterval` 3 处（`app.js:208`、`ipc-handlers.js:422`、`main.js:264`）；`autoUpdater` 定时器无 disposer | 副作用必须可逆 | **P1** |
| 工程门禁 | 无 lint / format / typecheck 配置；25 个测试平铺在 `tests/`，无覆盖率门槛 | 门禁链 + 分层测试 | **P1** |
| 仓库卫生 | 工作区残留 `*.js.new`（2 个，均未跟踪）、`dist-check/`、`_trash/`、`_probe.txt` | 交付物与工作区分离 | **P2** |
| 评分卡 | 无统一"健康度"输出 | 可验证、可对照 | **P2** |

**一句话结论**：功能完整度高，但"契约、隔离、可逆"三条 Host 纪律尚未落地，导致每次迭代都在为隐性耦合付利息。

---

## 2. 目标架构

```
┌──────────────────────────────────────────────────────────────┐
│  Client（渲染进程，src/）                                      │
│  pages/*.js  ── 页面契约 { mount, unmount }                    │
│  core/ipc-client.js ── 唯一出口，按 contract 生成，带超时/重试   │
└───────────────────────────┬──────────────────────────────────┘
                            │ window.dshManager（生成物，非手写）
┌───────────────────────────▼──────────────────────────────────┐
│  Transport（preload.cjs，仅做转发 + 白名单）                    │
└───────────────────────────┬──────────────────────────────────┘
                            │ 统一信封 { ok, code, message, data }
┌───────────────────────────▼──────────────────────────────────┐
│  Host（主进程，electron/）                                     │
│  contract/channels.js ── 单一契约清单                          │
│  host/scope.js        ── 作用域与 disposer                     │
│  handlers/<domain>.js ── 按域注册，返回 disposer                │
│  Services（packages/core、packages/marketplace，无 Electron 依赖）│
└───────────────────────────┬──────────────────────────────────┘
                            │ 子进程 / 文件
┌───────────────────────────▼──────────────────────────────────┐
│  DSH Runtime（npx dsh web / 本地安装）                          │
└──────────────────────────────────────────────────────────────┘
```

目标目录（只列新增/调整部分）：

```
electron/
├── contract/
│   ├── channels.js          # 单一契约清单（唯一事实来源）
│   ├── validate.js          # 零依赖 schema 校验器
│   └── envelope.js          # 统一响应信封 + 错误码
├── host/
│   ├── scope.js             # HostScope：disposer 栈、异步 join、逆序释放
│   ├── router.js            # 注册器：校验 → 执行 → 信封 → 计时
│   └── security.js          # 导航/权限/webview 策略集中处
├── handlers/                # 由 ipc-handlers.js 拆分
│   ├── dsh.js  marketplace.js  config.js  skills.js
│   ├── mcp.js  prompts.js      system.js  model.js
└── main.js                  # 只做：单实例、窗口、scope 装配、退出清理

src/
├── index.html               # <script type="module">
├── core/
│   ├── ipc-client.js        # 由 channels.js 生成的方法封装
│   ├── dom.js               # h() / text() / escape()，替代 innerHTML
│   └── store.js             # 订阅即 effect，自动解绑
└── pages/                   # 每个页面一个模块，统一契约
```

---

## 3. 专项设计

### 3.1 契约单一来源（替代手写 preload）

**问题**：147 个通道、140+ 个 preload 方法、渲染端字符串直调，三处各写一遍。改名靠全局搜索，漏一处就是运行时 `No handler registered`。

**设计**：`electron/contract/channels.js` 作为唯一清单，preload 方法在启动时由清单生成。

```js
// electron/contract/channels.js
export const CHANNELS = {
  'dsh:get-info':        { domain: 'dsh', args: [], result: 'object', mutating: false },
  'dsh:install':         { domain: 'dsh', args: ['string?', 'string?', 'string?'], result: 'object',
                           mutating: true, longRunning: true, cancellable: true },
  'marketplace:install-plugin': { domain: 'marketplace', args: ['string'], result: 'object',
                           mutating: true, longRunning: true },
  'skills:update':       { domain: 'skills', args: ['string', 'object'], result: 'object', mutating: true },
  // …按域补全，共 147 条
};
```

```js
// electron/preload.cjs（生成逻辑，不再逐个手写）
const { contextBridge, ipcRenderer } = require('electron');
const { CHANNELS } = require('./contract/channels.cjs');

const api = {};
for (const [channel, spec] of Object.entries(CHANNELS)) {
  const name = toMethodName(channel);           // 'dsh:get-info' → getDshInfo
  api[name] = (...args) => {
    const checked = validateArgs(channel, spec, args);   // 失败即 reject，不发 IPC
    return ipcRenderer.invoke(channel, ...checked);
  };
}
contextBridge.exposeInMainWorld('dshManager', api);
```

配套三条硬规则：

1. **新增通道必须同时改三处**：`channels.js` 加条目、`handlers/<domain>.js` 注册实现、`tests/contract.test.mjs` 加用例。CI 校验"清单 ↔ 注册"双向一致，缺一即失败。
2. **渲染端禁止字符串直调**：`ipc-client.js` 只暴露 `api.getDshInfo()` 这类具名方法，不暴露 `invoke(channel)`。
3. **事件通道同样入清单**（`kind: 'event'`），并统一返回取消订阅函数，替代当前 `removeAllListeners(channel)` 这种"一刀切"清理。

**收益**：删掉 `preload.cjs` 里约 230 行重复代码；通道改名变成清单内一次改动；新增通道有编译期/测试期保护。

---

### 3.2 统一响应信封与错误码

**问题**：现在成功返回裸数据、失败靠 `throw` 穿透 IPC（Electron 会把 Error 序列化成 `Error invoking remote method` 字符串），渲染端只能 `catch` 后正则匹配文案。

**设计**：主进程统一包装，异常与领域状态分离（对齐规范"异常即错误、状态留给结果"）。

```js
// electron/contract/envelope.js
export const Code = {
  OK: 'OK',
  INVALID_ARGS: 'INVALID_ARGS',
  NOT_INSTALLED: 'NOT_INSTALLED',
  PORT_IN_USE: 'PORT_IN_USE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INTERNAL: 'INTERNAL',
};

export const ok = (data) => ({ ok: true, code: Code.OK, data });
export const fail = (code, message, detail) => ({ ok: false, code, message, detail });
```

```js
// electron/host/router.js（核心 30 行）
export function register(scope, ipcMain, channel, spec, impl) {
  const handler = async (_event, ...args) => {
    const parsed = validateArgs(channel, spec, args);
    if (!parsed.ok) return fail(Code.INVALID_ARGS, parsed.message);
    const ac = new AbortController();
    scope.effect(() => () => ac.abort());          // 卸载即取消
    try {
      return ok(await impl(...parsed.value, { signal: ac.signal }));
    } catch (err) {
      if (err?.code && Code[err.code]) return fail(err.code, err.message, err.detail);
      return fail(Code.INTERNAL, err?.message || String(err));
    }
  };
  ipcMain.handle(channel, handler);
  scope.effect(() => () => ipcMain.removeHandler(channel));
}
```

渲染端只判断 `res.ok / res.code`，不再解析文案；UI 文案集中在 `src/core/errors.js` 一处映射。

**注意**：这会改变 147 个通道的返回形状，属于**破坏性变更**。迁移策略见 §5：先在 `router` 里加 `legacy: true` 兼容层（原样返回），按域逐个切换，全部切换后删除兼容层。

---

### 3.3 安全边界（P0）

当前主窗口 `sandbox: false` + `webviewTag: true`，且 webview 无 `partition`、无附加钩子。这意味着被嵌入的 DSH 页面与本应用共享同一个 session（cookie / localStorage / 缓存），且任何能触发 webview 挂载的路径都能继承默认 webPreferences。

| 措施 | 实现位置 | 说明 |
|:---|:---|:---|
| webview 独立会话 | `src/index.html` 的 `<webview partition="persist:dsh-web">` | 与主窗口隔离；副作用是用户需在 DSH 页面重新登录一次，需在更新说明中告知 |
| 挂载前强校验 | `main.js` 增加 `app.on('web-contents-created')` 内 `contents.on('will-attach-webview', (e, prefs, params) => …)` | 删除 `prefs.preload`、强制 `nodeIntegration=false`、`src` 必须命中 `127.0.0.1/localhost` 白名单，否则 `e.preventDefault()` |
| 权限默认拒绝 | `session.fromPartition('persist:dsh-web').setPermissionRequestHandler((_, __, cb) => cb(false))` | 摄像头/麦克风/定位/通知一律拒绝；将来需要时按 origin 白名单放行 |
| 渲染进程加固 | `webPreferences.sandbox` 评估开启 | 当前 preload 只用 `contextBridge`/`ipcRenderer`，开启 sandbox 可行；需实测 `require('electron')` 之外的模块是否被 preload 使用 |
| CSP | `index.html` meta + `onHeadersReceived` 注入 | `default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'`（现有内联样式需要 `unsafe-inline`，需评估后收紧） |
| 路径沙箱 | `contract/validate.js` 的 `path` 类型 | 所有接受路径的通道（`imagegen:read-image`、`skills:import-dir`、`marketplace:pick-plugin-dir` 等）必须 `realpath` 后校验是否在允许根内，拒绝 `..` 与符号链接逃逸 |
| 命令执行 | `packages/core` 全部 execa 调用 | 禁止 `execa(\`cmd ${userInput}\`)` 字符串拼接，统一 `execa(file, args[])`；对 `registry`、`version` 这类外部输入做白名单/正则约束 |

**验收**：`tests/security-boundary.test.mjs` 覆盖四条——非法 `src` 被拒、`prefs.preload` 被剥离、越界路径被拒、非法版本号被拒。

---

### 3.4 生命周期与资源所有权

对齐规范"effect/disposer"：**谁申请，谁登记，卸载必须可等待**。

```js
// electron/host/scope.js
export function createScope(name = 'root') {
  const disposers = [];
  const children = new Set();
  let disposed = false;

  const scope = {
    name,
    effect(fn) {                       // fn 返回 disposer
      if (disposed) throw new Error(`scope ${name} already disposed`);
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    child(childName) {
      const c = createScope(`${name}/${childName}`);
      children.add(c);
      scope.effect(() => () => { children.delete(c); return c.dispose(); });
      return c;
    },
    async dispose() {
      if (disposed) return;            // 重复 dispose 幂等
      disposed = true;
      await Promise.all([...children].map(c => c.dispose()));
      for (const d of disposers.reverse()) await d();   // 逆序、逐个 await
    },
  };
  return scope;
}
```

需要登记的资源清单（逐项对照现状）：

| 资源 | 现状位置 | 处理 |
|:---|:---|:---|
| `ipcMain.handle` | `ipc-handlers.js` 全量 | 注册时 `scope.effect(() => () => ipcMain.removeHandler(ch))` |
| webContents 事件 | `main.js:102/109/126/215` | 绑定到窗口子 scope，`closed` 时统一释放 |
| `nativeTheme.on('updated')` | `main.js:85` | 已手工移除，改为 scope 托管 |
| webview 实例 | `dsh-control.js` | 页面卸载时 `remove()` 并解绑 `dom-ready/did-fail-load` |
| `setInterval` | `app.js:208`、`ipc-handlers.js:422`、`main.js:264` | 前两个入页面/模块 scope；最后一个入 app scope |
| 子进程（DSH、npm） | `process-manager.js`、`installer.js` | 进程句柄入 scope，退出时 `kill` 并等待 `exit`；长任务挂 `AbortSignal` |
| `fs.watch`（如有） | `config.js` | 入 scope |
| `autoUpdater` 监听 | `main.js:242-264` | 入 app scope；`quitAndInstall` 前先 `dispose` |

**验收脚本**（对齐规范"提前卸载后确认资源没有留下"）：启动应用 → 打开再关闭每个页面 → 卸载全部 handler scope → 断言 `ipcMain` 通道数为 0、活跃定时器为 0、子进程为 0、`process.listenerCount('uncaughtException')` 不增长。

---

### 3.5 DSH 运行时状态机

当前启动/停止散落在 `dsh-control.js` 与多个 IPC 通道中，状态由布尔值拼凑，重复点击会产生并发启动。

```js
// 状态：IDLE → CHECKING → STARTING → READY → STOPPING → IDLE
//       任一环节失败 → FAILED（保留 lastError，可重试，不自动无限重试）
const transitions = {
  IDLE:     { start: 'CHECKING', stop: 'IDLE' },
  CHECKING: { ok: 'STARTING', fail: 'FAILED', stop: 'STOPPING' },
  STARTING: { ready: 'READY', fail: 'FAILED', stop: 'STOPPING' },
  READY:    { stop: 'STOPPING', crash: 'FAILED' },
  STOPPING: { done: 'IDLE' },
  FAILED:   { start: 'CHECKING', reset: 'IDLE' },
};
```

配套规则：

1. **幂等**：`start` 在 `STARTING/READY` 时直接返回当前状态，不重复拉起进程。
2. **重启必须进入正确工作状态**（对齐 rc.4 教训）：`restart` = 等待 `stop` 完成 → 重新 `start` → 健康检查通过才算 `READY`，不允许"只看进程存在"。
3. **错误分类**：把 DSH 的 `CONTENT_REFUSED / AUTH / QUOTA / RATE_LIMIT / TRANSPORT / TIMEOUT` 映射为 UI 上的处置建议，而不是统一"启动失败"。
4. **端口**：`findAvailablePort` 结果写入状态，`READY` 后再暴露 `dsh:get-web-url`，避免拿到过期端口。
5. **崩溃恢复**：`child-process-gone` / 进程退出码非 0 → `FAILED`，最多自动重启一次，第二次失败只提示不重试。

---

### 3.6 前端可维护性

**问题**：`app.js` 5733 行、186 个函数，10 个页面共用一个文件；模块靠 `<script>` 顺序加载，依赖顺序即隐式契约；100 处 `innerHTML`。

**分三步，不做大爆炸重写**：

1. **模块化（低风险）**：`modules/*.js` 改为 ESM（加 `export`），`index.html` 改 `<script type="module" src="assets/js/app.js">`。全局类保留挂到 `window` 作为过渡，页面模块逐个迁移。
2. **页面契约（中风险）**：每个页面导出 `{ id, mount(container, ctx), unmount() }`；`PageManager` 在切换时调用 `unmount()`，把该页的定时器、订阅、webview 引用一并释放。这样"切页面"天然成为一次资源回收验收。
3. **去 innerHTML（分批）**：
   - 第一批：所有拼接了外部数据的位置（插件名、技能名、GitHub 返回值、错误信息）——这是 XSS 面，必须先做；
   - 第二批：静态模板改 `h()`；
   - 第三批：复杂表格/列表用 `h()` + `DocumentFragment`。
   - 新增 `src/core/dom.js`：`h(tag, props, ...children)`、`text(s)`、`escapeHtml(s)`，禁止新代码再用 `innerHTML`（可用 lint 规则 `no-restricted-syntax` 拦住）。

**暂不引入前端框架**：项目卖点是零依赖、包体小，引入 React/Vue 会破坏 `files` 白名单与启动性能预算，收益不匹配。用 `h()` + 页面契约已能解决 80% 的结构问题。

---

### 3.7 工程门禁与仓库卫生

现状：没有任何 lint / format / typecheck 配置；测试 25 个平铺；CI 只有构建。

| 门禁 | 工具 | 门槛 | 落地方式 |
|:---|:---|:---|:---|
| 格式 | Prettier | 全仓一次性格式化，之后 `--check` | `npm run format:check` |
| 静态检查 | ESLint flat config | `no-unused-vars`、`no-restricted-syntax`（禁 `innerHTML`、禁字符串 execa）、`no-floating-promises` | `npm run lint` |
| 类型 | `jsconfig.json` + `checkJs` | 先只覆盖 `electron/contract/**`、`packages/core/**`，逐步扩大 | `npm run typecheck`（`tsc --noEmit`） |
| 契约一致性 | 自研脚本 | `channels.js` ↔ `ipcMain` 注册 ↔ preload 方法三方一致 | `npm run check:contract` |
| 测试 | `node --test` | 现有 25 个保留；新增契约、校验、隔离、生命周期四类 | `npm test` |
| 覆盖率 | `--experimental-test-coverage` | 新增/改动行 ≥80% | CI 报告，暂不设硬门 |
| 打包产物 | `scripts/assert-bundled-resources.mjs` | `files` 白名单与实际产物一致 | 已有，接入 CI |
| 发布 | release job | `contents: write` 只给发布 job，构建 job 只读 | 对齐规范 CI 权限分离 |

**测试纪律（对齐规范禁止项）**：不 mock 被测模块内部函数；不写"源码里必须出现某符号"的正则守卫；不测私有字段与调用次数；一个测试只围绕一个可解释行为。现存 `security-audit-fixes.test.mjs` 等如有正则守卫，按"改到即替换"处理，不新增。

**仓库卫生**（一次性，5 分钟）：

- `*.js.new`（`electron/ipc-handlers.js.new`、`src/assets/js/app.js.new`）确认内容已被主文件吸收后删除；`.gitignore` 增加 `*.new`。
- `_probe.txt`、`*.probe-replace` 删除并加入忽略。
- `dist-check/`、`_trash/` 已在忽略或不跟踪，确认后清理。
- `docs/` 下 24 个 md 中，`DEBUG_*`/`AUDIT_*` 已有忽略规则，未跟踪的按"归档到 docs/archive/"或删除处理。

---

## 4. 实施路线

| 阶段 | 项目 | 主要改动 | 验收标准 |
|:---|:---|:---|:---|
| **P0-1** | webview 隔离与权限 | `src/index.html`、`main.js`、`host/security.js` | 非法 `src` 被拒；`prefs.preload` 为空；权限请求默认拒绝；DSH 页面可正常使用 |
| **P0-2** | IPC 契约清单 | `contract/channels.js`、`contract/validate.js`、生成版 preload | 三方一致性脚本通过；非法入参返回 `INVALID_ARGS` |
| **P0-3** | 统一信封 | `host/router.js`、`contract/envelope.js` | 147 通道返回形状统一（先 legacy 兼容）；错误码覆盖 10 类 |
| **P1-1** | 作用域与 disposer | `host/scope.js`、`handlers/*` 拆分 | 卸载验收脚本通过（通道 0、定时器 0、子进程 0） |
| **P1-2** | DSH 状态机 | `packages/core/process-manager.js`、`dsh-control.js` | 连点启动只拉起 1 个进程；重启后健康检查通过才算 READY |
| **P1-3** | 前端 ESM + 页面契约 | `src/core/*`、`src/pages/*`、`index.html` | 10 个页面均可独立 mount/unmount；切换无泄漏 |
| **P1-4** | 去 innerHTML（第一批） | 外部数据拼接点 | 插件名/技能名/错误信息含 `<img onerror>` 不执行 |
| **P2-1** | 门禁链 | eslint/prettier/jsconfig/CI | `typecheck → lint → test → check:contract → verify` 全绿 |
| **P2-2** | 仓库卫生与文档 | `.gitignore`、docs 归档 | 工作区无未跟踪垃圾；README 与目录结构一致 |

依赖关系：P0-2 必须先于 P0-3 与 P1-1（契约是路由与作用域的基础）；P1-4 独立，可随时插入。

---

## 5. 取舍与风险

| 决策 | 代价 | 缓解 |
|:---|:---|:---|
| 不全面重写 TypeScript | 类型收益延后 | 用 `jsconfig` + JSDoc 在契约层先拿到类型保护，收益最高、成本最低 |
| 不引入前端框架 | 复杂列表仍需手写渲染 | `h()` + `DocumentFragment` 足够；页面数量稳定在 10 个，没有框架刚需 |
| 信封改造属破坏性变更 | 147 个通道返回形状变化 | `legacy` 兼容层 + 按域切换；每域切换后跑该域测试 |
| webview 改独立 partition | 用户需重新登录 DSH | 更新说明明示；提供"沿用旧会话"设置项作为过渡 |
| 开 `sandbox: true` | 需实测 preload 依赖 | 单独分支验证，失败则保持 `false` 但补齐其余隔离措施 |

---

## 6. 验收清单（可直接勾选）

**契约**
- [ ] `channels.js` 条目数 = `ipcMain` 注册数 = preload 方法数
- [ ] 非法入参返回 `INVALID_ARGS`，且不进入业务实现
- [ ] 渲染端无 `invoke('任意字符串')` 调用

**隔离**
- [ ] webview 使用独立 partition
- [ ] `will-attach-webview` 剥离 preload、校验 src
- [ ] 权限请求默认拒绝
- [ ] 越界路径被拒（含 `..` 与符号链接）

**可逆**
- [ ] 卸载 scope 后无残留通道 / 定时器 / 子进程
- [ ] 反复 dispose 幂等
- [ ] 页面切换 10 次后内存无单调增长

**运行时**
- [ ] 连点"启动"只产生 1 个 DSH 进程
- [ ] 重启后健康检查通过才显示 READY
- [ ] 端口占用 / 未安装 / 依赖缺失有独立错误码与处置建议

**工程**
- [ ] `typecheck → lint → test → check:contract → verify` 全绿
- [ ] 新增/改动行覆盖率 ≥80%
- [ ] 工作区无 `*.new`、`*.probe*`、`dist-check/` 残留

---

## 附：与官方规范的差异声明

1. 本项目不是 DSH 插件，不声明 `dsh.bundle` / `dsh.profile`，因此**不参与** bundle 层序与 profile 激活。
2. 本项目不注册模型工具，因此**不涉及** `defineTool`、`presentCall/presentResult`、UI 卡片契约。
3. 官方规范中"版本以目标运行时真实源码为准"这一条，本项目通过 `packages/core/src/dsh-web-contract.js` 与 `docs/适配范围-DSH-API大改.md` 落地；本次设计不改变该适配层。

---

## 九、实施记录（2026-11-23）

本轮只做"最小改动、最高杠杆"的两项：P0-1 安全隔离、P0-2 契约护栏。其余项按 §4 路线保留。

### 9.1 已完成

**P0-1 webview 隔离与权限默认拒绝**

| 文件 | 变更 | 说明 |
|:---|:---|:---|
| `electron/host/security.js` | 新增 | 纯函数策略层：src 白名单、prefs 加固、挂载判定、session 权限策略 |
| `electron/main.js` | 修改 3 处 | import；`web-contents-created` 内接管 `will-attach-webview` 与 guest `window.open`；`whenReady` 中安装 default/guest 两套 session 策略 |
| `src/index.html` | 修改 1 处 | `<webview partition="persist:dsh-web">` |
| `tests/security-boundary.test.mjs` | 新增 | 13 项：协议伪装、后缀伪装、preload 剥离、权限回调、空输入 |

关键判定不依赖 `startsWith`：`127.0.0.1.evil.com`、`localhost.evil.com` 均被拒绝；`file:`、`javascript:`、`data:` 全部拒绝。guest 权限默认全拒，仅放行 `clipboard-sanitized-write`。

**P0-2 契约单一事实来源（护栏先行）**

| 文件 | 变更 | 说明 |
|:---|:---|:---|
| `electron/contract/channels.cjs` | 新增 | 159 条契约（invoke 147 / event 9 / send 3），记录 channel、method、kind |
| `scripts/check-contract.mjs` | 新增 | 三方一致性校验：清单 ↔ preload ↔ 主进程注册，双向比对 |
| `scripts/verify.mjs` | 修改 | 追加 4b 项，纳入既有审计流程 |
| `package.json` | 修改 | 新增 `npm run check:contract` |

**本步骤刻意不改 preload**：现有 147 个方法名是渲染端公开 API（100+ 处调用），自动生成需要人工命名映射表，属于 P1 的破坏性改造。当前用"清单 + 校验"拿到约束收益，行为零变化。

### 9.2 验证结果

| 验证 | 结果 |
|:---|:---|
| 安全边界测试 | 13 / 13 通过 |
| 契约一致性 | PASS：清单 159 = preload 159；主进程 handle 147 / on 3 |
| 负例（把 `dsh:get-info` 改成 `dsh:get-info-TYPO`） | 如期 FAIL，报 2 项不一致；恢复后 PASS |
| `npm run verify` | 61 PASS / 0 FAIL |
| 全量 `npm test` | 331 项：326 pass / 3 fail / 2 cancelled |

全量测试的 3 项失败均为**既有问题**，与本轮改动无关：

1. `vision-rules-consistency.test.mjs` —— `packages/core/src/config.js` 中不存在 `VISION_MODEL_NAME_RULES` 导出（该文件近期无改动，属测试与实现脱节）。
2. `model-persistence-e2e.test.mjs` —— 端到端用例失败，依赖模型配置迁移链路。
3. 另 1 项与 2 项 cancelled 集中在依赖真实环境的用例。

建议单独开一轮"测试债清理"，不要混进安全改造。

### 9.3 已知影响

- **DSH 页面会重新登录一次**：webview 改用独立分区后，旧的 default session 中的 localStorage/cookie 不再可见。这是隔离的必然代价，需在更新说明中告知用户。
- `sandbox: true` 未开启：需实机验证 preload 依赖后再定，本轮保持 `false`，但其余隔离措施已到位。
- 契约清单的 `args` 字段暂为空：入参校验（§3.1）需逐通道补 schema，属 P0-3 范围。

### 9.4 第三轮：测试基线转绿 + P0-3 灰度 + P1-1 基线

#### 测试债清理（4 项，含 2 个真实 bug）

| 问题 | 性质 | 处理 |
|:---|:---|:---|
| `config.js` 的 `cleanPiEntry` 只读 `baseURL` | **数据丢失**：旧配置写 `baseUrl`，迁移时被当成空地址直接丢弃，用户提供商配置消失 | 大小写兼容，统一写成 `baseURL` 后删除 `baseUrl` |
| `model-config-center.js` 的 `_applyWorkBuddy` 缺规格表回退 | **功能回归**：`deepseek-v4-flash` 的 1M 上下文被写成 200K | 容量三级回退：显式值 → `lookupModelSpec` → 通用默认 |
| `vision-rules-consistency.test.mjs` 引用不存在的导出 | 测试与实现脱节（双实现已归一为 `DSHConfig.isVisionModelName`） | 重写为纯行为测试，保留正反例与大小写覆盖 |
| `link-host-deps.test.mjs` 在网络盘建 junction 失败 | 环境能力限制（TEMP 指向 Y 盘网络盘） | 新增 junction 能力探测，不支持时整组跳过并说明原因 |

前两项是真实缺陷，不是"测试过时"——修复后分别恢复了配置迁移与小上下文规格回退。

#### P0-3 统一信封（app 域灰度）

| 文件 | 变更 |
|:---|:---|
| `electron/contract/envelope.cjs` | 新增：`CODE`（10 类）、`ok/fail`、`isEnvelope`、`fromError`、`unwrap`、`usesEnvelope` |
| `electron/main.js` | 全局 handle 包装按 `usesEnvelope(channel)` 决定是否包信封；异常走 `fromError` |
| `electron/preload.cjs` | 新增 `invokeIpc()` 解包层，147 处调用统一替换 |
| `tests/envelope.test.mjs` | 新增 12 项：结构、异常收敛、解包语义、灰度范围 |

关键设计：**信封在传输层解包**。渲染进程成功仍拿 `data`、失败抛带 `code` 的 `Error`，调用方式与返回值形状零变化，因此可以逐域灰度而无需同步改前端。首轮只接 `app:*`（11 个通道），验证后再扩域。

`fromError` 只回传 `message`，不外泄堆栈；未知异常统一 `INTERNAL`。

#### P1-1 HostScope 基线

| 文件 | 变更 |
|:---|:---|
| `electron/host/scope.js` | 新增：`effect` 登记、子作用域、逆序释放、异步等待、幂等、失败隔离 |
| `electron/main.js` | 窗口子作用域托管 `nativeTheme` 监听；应用作用域托管自动更新定时器；`before-quit` 统一释放 |
| `tests/host-scope.test.mjs` | 新增 9 项：逆序、异步、定时器停止、递归释放、幂等、部分失败 |

修掉的两个真实泄漏点：反复开关窗口会累积 `nativeTheme` 监听；自动更新的 `setTimeout/setInterval` 原本永不清理。

#### 验证结果

| 验证 | 结果 |
|:---|:---|
| 安全边界 | 13 / 13 |
| 信封语义 | 12 / 12 |
| HostScope | 9 / 9 |
| 契约一致性 | PASS（159 / 159 / handle 147 / on 3） |
| `npm run verify` | 61 PASS / 0 FAIL |
| 全量 `npm test` | **352 / 352 通过，0 失败、0 取消** |

#### 本轮未做（有意保留）

- 信封扩域到 `dsh:*` / `marketplace:*`：需逐域回归，`app:*` 跑稳后再扩。
- `ipcMain.handle` 通过 scope 登记注销：当前进程退出即回收，收益低于改动成本，留到拆分 handlers 时一并做。
- 前端 `innerHTML` 清理与页面 `unmount` 契约：属 P1-3 / P1-4，改动面大，单独一轮。

### 9.5 第四轮：P1-2 启动幂等 + P2-2 仓库卫生 + P1-4 评估

#### P1-2 DSH 启动幂等（真实双开隐患）

**问题**：`dsh:start`、`dsh:restart`、`dsh:fix-and-restart` 三个入口都直接调用 `spawnDSHWeb`。并发点击时，第一次还没 spawn 完成、端口尚未被占用，第二次同样通过"端口空闲"检查，于是各自拉起一个实例——表现为双开、随机换端口、webview 连不上。

**修复**：新增 `electron/host/single-flight.js`，两层锁：

| 层 | 位置 | 作用 |
|:---|:---|:---|
| 流程级 | `dsh:start` → `startDSHOnce` | 合并并发启动请求，凭据迁移、插件安装等副作用只跑一次 |
| 调用级 | `spawnDSHWeb` → `spawnDSHWebImpl` | 覆盖 `restart` / `fix-and-restart` 等所有调用点，确保任何路径都不双开 |

单飞锁的关键约束是**失败必须解锁**：一次启动失败不能把后续重试永久挡在门外。测试覆盖了并发只执行一次、失败传播并解锁、底层同步抛错、合流回调。

| 文件 | 变更 |
|:---|:---|
| `electron/host/single-flight.js` | 新增 |
| `electron/ipc-handlers.js` | `dsh:start` 抽为 `startDSHImpl` + 单飞包装；`spawnDSHWeb` 加调用级锁 |
| `tests/single-flight.test.mjs` | 新增 6 项 |

#### P1-4 去 innerHTML：评估结论（本轮不改代码）

对 4 个文件做了两轮扫描：

- 123 处 `innerHTML` 赋值，37 处含插值或拼接；
- 对"外部字段未转义"的 4 个候选逐一核查，**全部是误报或已转义**：`showToast` 用 `textContent`，诊断报告的命令行已 `escapeHtml`，生图错误已 `escapeHtml`，插件比较逻辑不在 HTML 内。

结论：历史安全审计的转义覆盖良好，静态扫描已无法可靠定位剩余风险（继续扫只会产生噪声）。**有意暂缓批量改造**，触发条件写在这里：

1. 先补运行时验证——用 Electron 冒烟测试或 jsdom 对渲染函数做注入断言（`<img src=x onerror=...>` 不执行）；
2. 结构改造与数据转义分开做——去内联 `onclick`（改为事件委托）后才能上 `script-src 'self'` 的严格 CSP，这一步收益最大、风险也最大，应单独一轮。

#### P2-2 仓库卫生

| 动作 | 明细 |
|:---|:---|
| 归档残留副本 | `electron/ipc-handlers.js.new`、`src/assets/js/app.js.new`、`src/assets/js/_probe.txt`、`src/assets/css/style.css.new` → `_trash/` |
| 补忽略规则 | `.gitignore` 增加 `*.new`、`*.probe*`、`.probe-replace`、`_trash/` |

#### 验证结果

| 验证 | 结果 |
|:---|:---|
| 单飞锁 | 6 / 6 |
| 契约一致性 | PASS |
| `npm run verify` | 61 PASS / 0 FAIL |
| 全量 `npm test` | **358 / 358 通过** |

#### 剩余 P 级

| 项 | 状态 | 说明 |
|:---|:---|:---|
| P1-2 完整状态机 | 部分 | 已解决"双开"；`IDLE→READY` 显式状态机与错误分类仍待做，建议先补 Electron 冒烟测试再改 |
| P1-3 前端 ESM + 页面契约 | 未开始 | 10 个页面、5733 行，需独立一轮，先做页面 `unmount` 再迁 ESM |
| P1-4 去 innerHTML | 评估完成 | 见上，等运行时验证到位再动 |
| P2-1 门禁链 | 未开始 | ESLint/Prettier 需引入依赖；建议先加 `check:contract` 到 CI，再逐步上 lint |

---

### 9.6 第五轮：P1-2 状态机接入 + P2-1 门禁 + P1-3a 页面契约

#### P1-2 收尾：状态机接入四个运行时入口

`packages/core/src/dsh-state-machine.js` 在第四轮已完成，本轮把它接进真实调用链。

`registerIpcHandlers` 内构造单例，并提供三个语义明确的辅助函数（避免各入口各自拼顺序）：

| 辅助 | 作用 |
|:---|:---|
| `transition(event, payload)` | 推进状态；非法转换只记 `debug` 日志不抛错（重复点"停止"属正常操作） |
| `beginStop()` | 进入停止流程；已是 `IDLE` 时跳过（`STOP` 在 `IDLE` 上是自环，推它只污染历史） |
| `settleStopped()` / `settleStarted()` | STOP 后统一收口回 `IDLE`；启动后**只有健康检查通过才 READY**，进程在但不可达按 FAILED 留痕 |

接入点：

| 入口 | 事件序列 |
|:---|:---|
| `dsh:start` | `START → (复用)READY` 或 `START → PROCEED → READY/FAIL` |
| `dsh:restart` | `STOP → STOPPED → START → PROCEED → READY/FAIL` |
| `dsh:stop` | `STOP → STOPPED`（失败转 `FAIL`，不再假装已停） |
| `dsh:fix-and-restart` | 同 restart，起点可为 `FAILED` |
| 启动失败自愈重启 | `FAILED → START → PROCEED → READY/FAIL` |

`dsh:get-info` 附带 `runtime: snapshot()`（**ADDITIVE**，旧消费方忽略即可），渲染端不必再用布尔值拼"是否正在启动"。状态每次变化都进 `debug-logger`，形如 `[runtime] READY --STOP--> STOPPING`，排障时能直接看到时序。

**并发语义**：`IDLE` 之外重复 `START` 会被拒绝——这正好兜住单飞锁覆盖不到的场景（例如 `READY` 时用户再点启动，不会再走一遍 spawn 逻辑后仍显示"启动中"）。

#### P2-1 门禁链（CI 层）

| 文件 | 变更 |
|:---|:---|
| `.github/workflows/ci.yml` | 新增：PR/push 触发 `quality`（`check:contract` → `verify` → `test`） |
| `.github/workflows/build.yml` | 新增 `quality` job，`build` 的 `needs` 改为 `[check-version, quality]`；发布 job 仍独占 `contents: write` |

发布链现在是"版本一致 → 质量门禁 → 构建 → 发布"，打 tag 前不可能跳过测试。

ESLint / Prettier / `tsc --checkJs` 未引入：三者都要新增依赖并全仓格式化一次，会产生数千行无行为变更的 diff，和本次发布混在一起无法 review。留作独立提交（`chore: 引入 lint 链`）。

#### P1-3a 页面生命周期契约

`PageManager` 此前只有 `register(id, { render })`，页面**没有 unmount 出口**，"切页面"无法作为资源回收验收点。

本轮把契约补全（向后兼容，旧写法 `{ render }` 仍然有效）：

```js
pageManager.register('id', {
  render(params, ctx),        // 进入/刷新
  mount(params, ctx),         // 首次挂载一次性初始化
  unmount(ctx),               // 离开时释放（可 async）
  onActivate(params, ctx),    // 每次激活
});
```

`ctx` 是受管资源登记口：`ctx.disposer(fn)`、`ctx.on(target, ev, fn)`、`ctx.interval(fn, ms)`、`ctx.timeout(fn, ms)`。页面不再自己记定时器，离开时由 PageManager 统一回收。

回收纪律（与 `electron/host/scope.js` 同构）：

| 约束 | 实现 |
|:---|:---|
| 顺序 | 先 `unmount()`，再释放登记资源，且**逆序**执行 |
| 隔离 | 单个清理函数抛错不影响其余，`unmount` 抛错也照常回收并完成切换 |
| 幂等 | 先摘除再执行，重复 `disposePage` 返回 `{disposed: 0, failed: 0}` |
| 自刷新不自杀 | 重复 `navigate` 同一页不触发 `unmount`，也不释放自己的资源 |
| 契约校验 | 钩子不是函数、id 非法、页面不是对象 → 立即 `TypeError` |

同时去掉从未生效的 `lazy` 参数（10 个页面全部走首次进入懒渲染，该参数是死选项）。

| 文件 | 变更 |
|:---|:---|
| `src/assets/js/modules/page-manager.js` | 重写：契约 + disposer 回收 + ctx |
| `src/assets/js/app.js` | `switchPage` 接住 `navigate()` 的 Promise 拒绝 |
| `tests/page-lifecycle.test.mjs` | 新增 18 项 |

**测试方式说明**：渲染层尚未 ESM 化，`page-manager.js` 仍是传统 `<script>`，无法 `import`。测试用 `new Function` 加载**真实源码**执行，`window`/`document`/定时器/`console` 全部由测试注入——不是把逻辑复制到测试里，也没有 mock 被测模块的内部函数。

#### P1-3b 渲染层 ESM 化：本轮不做（附理由）

拆分后的 ESM 化需要动：10 个模块文件加 `import/export`、`app.js` 5733 行改为模块、`index.html` 11 个 `<script>` 合并为 1 个 `type="module"`、以及 **16 处内联 `onclick` 全部改写**（模块作用域下 `switchPage` 不再是全局函数，不改就是一片死按钮）。

三个约束叠在一起，使它不适合紧跟发布：

1. **没有前端自动化测试**——`node --test` 覆盖不到渲染，改完只能靠手点 10 个页面，回归风险无法量化；
2. **与 P1-4 强耦合**——去内联 `onclick` 是严格 CSP 的前置条件，应先做事件委托 + 注入断言，再迁 ESM；
3. **收益是结构性的，不是用户可见的**——发布前做它，等于用"可能坏"换"更好维护"。

顺序建议：`去内联 onclick（事件委托）→ 运行时注入断言 → 模块 ESM 化 → 严格 CSP`，每步单独可回滚。

#### 验证结果

| 验证 | 结果 |
|:---|:---|
| 状态机单测（含四个入口的事件序列） | 21 / 21 |
| 页面契约单测 | 18 / 18 |
| 契约一致性 `check:contract` | PASS |
| `npm run verify` | 61 PASS / 0 FAIL |
| 全量 `npm test` | **397 / 397 通过**（fail 0 / cancelled 0） |

#### P 级总账

| 项 | 状态 |
|:---|:---|
| P0-1 webview 隔离与权限 | 完成 |
| P0-2 IPC 契约单一来源 | 完成 |
| P0-3 统一信封（app 域灰度） | 完成 |
| P1-1 作用域与 disposer | 完成 |
| P1-2 启动幂等 + 状态机 | 完成 |
| P1-3a 页面生命周期契约 | 完成 |
| P1-3b 渲染层 ESM 化 | 明确推迟（见上） |
| P1-4 去 innerHTML | 评估完成，等运行时验证 |
| P2-1 门禁链（CI） | 完成；lint/prettier 待独立提交 |
| P2-2 仓库卫生 | 完成 |


