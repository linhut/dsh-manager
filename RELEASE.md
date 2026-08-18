# 发布流程（Release Process）

本文档定义 DSH Manager 的**版本规范、发布流程与构建流程**。所有发布操作遵循本流程，保证 Release list 整洁、版本可追溯、构建可复现。

## 1. 版本规范（SemVer）

遵循 [语义化版本 2.0.0](https://semver.org/)：

| 版本段 | 含义 | 示例 |
|--------|------|------|
| `MAJOR` | 不兼容的重大变更 / 正式里程碑 | `1.0.0` |
| `MINOR` | 向后兼容的新功能 | `1.1.0` |
| `PATCH` | 向后兼容的缺陷修复 | `1.1.1` |
| 预发布后缀 | 测试版（不用于正式 Release） | `1.2.0-rc.1` |

**规则**：
- 新增功能 → `MINOR+1`（如 `1.0.0` → `1.1.0`）
- 缺陷修复 → `PATCH+1`（如 `1.1.0` → `1.1.1`）
- 每次发布必须递增版本号，禁止重复使用同一版本号
- 版本号同时更新在 **6 处**（见 §3 检查清单），保持一致

## 2. 发布流程（标准操作）

```text
1. 确认代码就绪（功能完成、检查通过）
2. 全局检查（§4 检查清单）
3. 更新版本号（§3）
4. 提交版本更新（feat:/fix: + chore: bump version）
5. 打 tag（git tag -a vX.Y.Z）
6. 推送代码与 tag（触发 CI 自动构建发布）
7. 验证 Release（§5）
```

### 2.1 详细步骤

```bash
# ① 确认工作区干净
git status

# ② 全局检查（见 §4）
npm run build:win   # 或 CI 预检

# ③ 更新版本号（6 处一致，见 §3）
# ④ 提交
git add -A
git commit -m "feat: xxx / fix: xxx"          # 功能提交
git commit -m "chore: bump version to X.Y.Z"  # 版本提交

# ⑤ 打注解 tag
git tag -a v1.2.0 -m "DSH Manager 1.2.0"

# ⑥ 推送（CI 自动构建三平台并发布 Release）
git push origin main
git push origin v1.2.0

# ⑦ 验证 Release
gh release list
gh release view v1.2.0 --json assets
```

## 3. 版本号更新点（6 处必须一致）

| # | 文件 | 位置 |
|---|------|------|
| 1 | `package.json` | `"version": "X.Y.Z"` |
| 2 | `packages/core/package.json` | `"version": "X.Y.Z"` |
| 3 | `packages/marketplace/package.json` | `"version": "X.Y.Z"` |
| 4 | `packages/core/src/version-manager.js` | User-Agent `dsh-manager/X.Y.Z` |
| 5 | `packages/marketplace/src/github-api.js` | User-Agent `dsh-manager/X.Y.Z` |
| 6 | `electron/ipc-handlers.js` | `app:get-version` catch fallback `'X.Y.Z'` |

> 注：`docs/superpowers/specs/*.md` 中"当前基线"为历史记录，无需更新。

## 4. 发布前检查清单

- [ ] `git status` 干净（无未提交改动）
- [ ] 全部 JS 语法通过：`for f in $(git ls-files '*.js' '*.cjs'); do node --check "$f"; done`
- [ ] IPC 三端一致（main handle 数 = preload invoke 数）
- [ ] 渲染层调用 API 全部在 preload 暴露（零缺失）
- [ ] 核心模块冒烟测试通过（`node --input-type=module` 跑 core/marketplace 回归）
- [ ] 6 处版本号一致且已递增（§3）
- [ ] 本地构建通过（`npm run build:win` 或 CI 等价验证）

## 5. 构建与发布（CI 自动完成）

推送 `v*` tag 后，[`.github/workflows/build.yml`](../.github/workflows/build.yml) 自动：

| 步骤 | 平台 | 产物 |
|------|------|------|
| build (matrix) | windows-latest | `dist/*.exe`（NSIS） |
| build (matrix) | macos-latest | `dist/*.dmg`（x64 + arm64） |
| build (matrix) | ubuntu-latest | `dist/*.AppImage` |
| create-release | ubuntu-latest | 创建 Release `DSH Manager vX.Y.Z` 并上传全部产物 |

**本地构建**（如 CI 不可用）：在本地 NTFS 盘执行（`Y:` 网络卷不支持 workspace 符号链接）：

```bash
# 在本地盘（如 C:\dsh-build\app）导出快照后
git archive HEAD | tar -x -C <build-dir>
cd <build-dir>
npm install --no-audit --no-fund
npm install --no-save sharp
npm run build:win   # 产物在 dist/DSH Manager Setup X.Y.Z.exe
```

## 6. 发布后验证

```bash
gh release list                                  # 确认 vX.Y.Z 出现且标记 Latest
gh release view vX.Y.Z --json assets             # 确认 4 个产物（win exe / mac dmg x2 / linux AppImage）
```

**Release 规范**：
- 名称统一为 `DSH Manager vX.Y.Z`
- 仅保留正式 Release，**删除 Draft 草稿**（避免列表重复）
- 最新版本自动标记 `Latest`

## 7. 常见问题

| 问题 | 处理 |
|------|------|
| `gh release create` 报 tag 已存在 | 说明 CI 已自动创建，直接验证即可 |
| Release list 有 Draft 重复条目 | `gh api -X DELETE repos/<owner>/<repo>/releases/<id>` 删除草稿 |
| 本地 npm install 失败（errno -4094） | Y: 网络卷符号链接限制，改用本地盘构建（§5） |
| 构建产物版本号不对 | 检查 §3 的 6 处版本号是否一致 |
