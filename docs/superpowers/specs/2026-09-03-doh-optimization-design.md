<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# DoH 无污染解析优化设计

> 日期：2026-09-03
> 状态：已批准并实施完成（2026-09-03）
> 实施：packages/core/src/doh-resolver.js + **六处接入** + tests/doh-resolver.test.mjs（148/148 单测通过）
> 六处接入：github-api.js 竞速链 / 更新检查 / 连通性检测 / 插件搜索 / version-manager / skill-manager（默认分支+zip 下载）
> 修复：UA 硬编码动态化、版本读取路径错误（version-manager/skill-manager 曾读不存在的 packages/package.json）、loadCore 失败降级、竞速 timer 清理、in-flight 并发去重、raceTimeoutMs 热点预算、DNS wire header 缺 ARCOUNT
> 端到端验证：resolveViaDoh(github.com)=20.205.243.166（157ms）；fetchViaDoh(api.github.com/rate_limit)=200 OK；tryFetchViaDoh=200 OK
> 关联：用户发现安全 DNS（DoH）可无污染解析 GitHub 等域名，解决 DNS 污染机器上访问失败/超时问题

## 1. 背景与目标

**问题**：多数用户机器 DNS 被污染（GFW 投毒或代理 fake-ip 接管，本机实测解析 github.com 得到 `198.18.0.64`），导致应用内直连 GitHub 失败/超时，只能依赖 gh-proxy 镜像链，镜像不可用时功能失效。

**目标**：应用内置 DoH（DNS over HTTPS）解析真实 IP，用 Node `https.request({ lookup })` 直连（SNI 保持域名），作为候选序列新增一路，**透明生效、失败自动降级**，不做 UI 改动。

## 2. 已验证的技术事实（2026-09-03 实测）

| 项 | 结果 |
|----|------|
| 用户端点 `linhut.ddd.oaifree.com/query-dns` | POST `application/dns-message` 返回真实 IP `140.82.113.3` |
| 阿里 `223.5.5.5/resolve`、`dns.alidns.com/resolve` | 返回 `20.205.243.166`（209ms） |
| `dns.google/resolve`、`cloudflare-dns.com/dns-query` | 返回同一真实 IP（215~799ms） |
| Node `https.request({hostname: IP, servername: 域名, lookup})` 直连 github.com | **HTTP 200，573KB** ✅ |
| 本机系统 DNS 解析 github.com | `198.18.0.64`（fake-ip 保留段，污染/接管证据） |
| Electron 33 主进程全局 `fetch` | Chromium 网络栈，**无法自定义 DNS lookup** → 必须用 `node:https` |

**结论**：链路「DoH 解析真实 IP → Node lookup 直连」完整可行，且 DoH 端点本身国内可达（阿里 223.5.5.5）。

## 3. 架构

新增一个 core 模块，接入三处调用点：

```
packages/core/src/doh-resolver.js（新增）
  ├─ DOH_ENDPOINTS     端点列表（json 型公共端点 + wire 型用户端点）
  ├─ resolveViaDoh()   多端点并行竞速解析，返回 IPv4 列表，带 TTL 缓存
  ├─ fetchViaDoh()     node:https + lookup 直连，封装 fetch 兼容响应
  └─ 导出至 packages/core/src/index.js

接入点（三处，全面集成）：
  1. packages/marketplace/src/github-api.js  _fetchWithRetry（插件市场/搜索/下载/更新源）
  2. electron/ipc-handlers.js  L2115 更新检查
  3. electron/ipc-handlers.js  L1207 连通性检测
```

## 4. 组件设计

### 4.1 `DOH_ENDPOINTS`（常量）

```js
[
  { type: 'json', url: 'https://223.5.5.5/resolve?name={host}&type=A' },        // 阿里，国内快
  { type: 'json', url: 'https://dns.alidns.com/resolve?name={host}&type=A' },
  { type: 'json', url: 'https://dns.google/resolve?name={host}&type=A' },
  { type: 'json', url: 'https://cloudflare-dns.com/dns-query?name={host}&type=A' },
  { type: 'wire', url: 'https://linhut.ddd.oaifree.com/query-dns' },            // 用户端点，POST dns-message
]
```

- json 型：GET + `Accept: application/dns-json`，解析 `Answer[].data`（type=1 即 A 记录）
- wire 型：POST `application/dns-message`，解析 DNS 响应 A 记录（手写 wire 解析，~40 行，已在本机验证）
- 端点内部超时 5s，失败静默跳过

### 4.2 `resolveViaDoh(hostname)` → `Promise<string[] | null>`

- 并行请求全部端点，**首个返回 IP 列表者胜出**（竞速）
- 只收集 IPv4（A 记录）；AAAA 不做（v4 直连为主，避免 IPv6 不可达拖慢）
- 结果缓存 TTL 300s（Map<hostname, {ips, expires}>），避免每次请求重复解析
- 全部失败返回 `null`（调用方忽略该候选，不影响其他链）

### 4.3 `fetchViaDoh(url, { ip, timeoutMs, headers, method, body })` → `Promise<ResponseLike>`

```js
const req = https.request({
  hostname: ip,            // DoH 解析的真实 IP
  servername: hostname,    // SNI 保持域名（关键）
  path: pathname + search,
  method,
  headers: { Host: hostname, ...headers },   // Host 头保持域名
  lookup: (h, opts, cb) => cb(null, { address: ip, family: 4 }),
  timeout: timeoutMs || 15000,
});
```

- 封装 fetch 兼容响应：`{ ok, status, statusText, headers, json(), text() }`
- `signal` 支持：监听 abort → `req.destroy()`
- 使用 `node:https`（ESM：`import https from 'node:https'`），不走全局 fetch

### 4.4 接入点改造

**① github-api.js `_fetchWithRetry`**（改动核心）

```js
// 原：candidates = githubProxyUrls(url) → [直连, 镜像1, 镜像2, 镜像3]
// 新：GitHub 域名时，先 resolveViaDoh 取 IP，有 IP 则：
//   candidates = [直连(系统), DoH直连(若解析成功), 镜像1, 镜像2, 镜像3]
// 竞速逻辑不变；DoH 候选走 fetchViaDoh，其余走 fetch
```

注意：DoH 解析**先于竞速**，但解析失败不阻塞（null 则不加该候选）；解析成功但直连失败，竞速结果仍可选镜像。为控制竞速整体时延，DoH 解析并行于首个直连尝试（或解析超时 5s 内）。

**② ipc-handlers.js 更新检查（L2115）**

- 候选序列从 `[GitHub, gh-proxy]` 扩展为 `[GitHub, DoH直连(解析成功时), gh-proxy]`
- 复用 `fetchViaDoh`；改动集中在 URL 候选循环

**③ ipc-handlers.js 连通性检测（L1207）**

- 直连失败后追加 DoH 直连兜底，状态文案可标注「(DoH 解析直连)」

## 5. 数据流

```
用户操作（插件市场/更新检查/连通性检测）
  → 目标 URL（api.github.com / github.com / codeload…）
  → 候选序列构建
       ├─ 系统直连（原逻辑）
       ├─ DoH 直连（resolveViaDoh 成功时新增）
       └─ gh-proxy 镜像 1..3（原逻辑）
  → Promise.allSettled 并行竞速
  → 取最快 2xx 响应返回；无 2xx 取 4xx；全败重试→DSHError
```

## 6. 错误处理与降级

| 场景 | 行为 |
|------|------|
| 所有 DoH 端点不可达 | `resolveViaDoh` 返回 null，候选不含 DoH 直连，行为与现状一致 |
| 单个 DoH 端点超时/失败 | 静默跳过，其他端点继续 |
| DoH 直连 TLS/超时失败 | 竞速中该候选 settle 为 error，其余候选照常 |
| 解析到 IP 但已失效（TTL 内） | 直连失败 → 自动落入镜像链，下次解析刷新缓存 |
| 缓存 TTL 过期 | 重新解析（300s） |

## 7. 测试计划

新增单测文件 `tests/doh-resolver.test.mjs`：

1. **resolveViaDoh**：mock 端点（本地 http server）返回 IP/失败/慢响应，验证：竞速取最快、全败返回 null、TTL 缓存生效
2. **fetchViaDoh**：本地 https server（自签证书）+ `NODE_TLS_REJECT_UNAUTHORIZED=0`，验证：lookup 注入的 IP 被使用、响应封装 `ok/status/json()` 正确、abort 生效
3. **github-api 集成**：mock `resolveViaDoh` 有 IP 时候选含 DoH 直连；无 IP 时与现状一致
4. **回归**：现有 128 单测全部通过

## 8. 不做的事（YAGNI）

- ❌ 不写系统 hosts（用户已选应用内置方案，避免系统级副作用）
- ❌ 不做设置页/UI 开关（透明生效；调试信息走现有日志）
- ❌ 不接管系统 git clone（installer.js 的 git 命令不走 Node fetch，超出本轮范围，文档标注）
- ❌ 不做 IPv6（AAAA）解析（v4 直连优先，避免双栈超时）

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| DoH 端点在国内部分网络不可达 | 多端点竞速（阿里国内可达为主），失败静默降级 |
| 用户端点（oaifree）依赖第三方稳定性 | 仅作候选之一，非唯一依赖；公共端点兜底 |
| lookup 直连被 TLS SNI 阻断（IP 级封锁） | 直连失败自动落入镜像链，不劣于现状 |
| 竞速整体时延增加 | DoH 解析与首个直连并行发起，端点超时 5s 封顶 |

---

## 待确认

1. 设计是否 OK？
2. DoH 端点列表是否加入用户端点（已包含，作为 wire 型候选）？
3. 是否同意「先实施 core 模块 + 三处接入 + 单测」，验证通过后随下个版本发布？
