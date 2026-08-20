# 正式版本发布流程

> ⚠️ **正式版本一律通过 GitHub Actions 自动构建发布**，禁止本地构建后手动上传产物。

## 📋 前置条件

- 拥有仓库的 write 权限
- 本地已安装 [GitHub CLI (gh)](https://cli.github.com/) 并已登录（`gh auth login`）
- GitHub Actions 已启用（仓库 Settings → Actions）

## 📝 命名规范

| 项目 | 规范 | 示例 |
|------|------|------|
| 版本号 | SemVer `major.minor.patch` | `1.3.4` |
| Git Tag | 前缀 `v` + 版本号 | `v1.3.4` |
| Release 名称 | `DSH Manager v{major}.{minor}.{patch}` | `DSH Manager v1.3.4` |
| 安装包名 | `DSH-Manager-{version}.{ext}` | `DSH-Manager-1.3.4.exe` |

## 🚀 发布步骤

### 1. 更新版本号

编辑 `package.json` 的 `version` 字段（同时保证 §6 检查清单中多处一致）：

```json
"version": "x.y.z",
```

### 2. 提交版本更新

```bash
git add package.json
git commit -m "chore: bump version to x.y.z"
```

### 3. 创建并推送 Git Tag（触发 Actions 构建）

```bash
# 创建 tag（指向最新 commit）
git tag -a vx.y.z -m "vx.y.z release"

# 推送 tag 到 GitHub —— 这是正式发版的触发开关
git push origin vx.y.z
```

### 4. 等待 GitHub Actions 自动构建与发布

推送 `v*` tag 后，`.github/workflows/build.yml` 自动执行以下流水线：

| 阶段 | 步骤 | 说明 |
|------|------|------|
| 0-check-version | 校验 tag 与 package.json 版本一致 | 不一致直接失败 |
| 1-build (matrix) | Windows / macOS / Linux 三平台并行构建 | `npm run build:win / build:mac / build:linux` |
| 2-upload-artifact | 上传构建产物到 Actions Artifacts | `.exe` / `.dmg` / `.AppImage` |
| 3-create-release | 创建 GitHub Release 并附加所有安装包 | 自动生成 Release Notes |

查看构建进度：

```bash
gh run list --repo linhut/dsh-manager --limit 3
gh run watch <run-id> --repo linhut/dsh-manager
```

### 5. 验证 Release

```bash
gh release view vx.y.z --repo linhut/dsh-manager --json tagName,assets,url,publishedAt
```

确认清单：
- [ ] Release 名称格式为 `DSH Manager vX.Y.Z`
- [ ] 三平台构建产物完整且命名规范（Windows `.exe` / macOS `.dmg` x2 / Linux `.AppImage`）
- [ ] Release 标记为 Latest
- [ ] Release Notes 包含正确下载链接

### 6. 同步到其他镜像仓库

```bash
git push gitcode vx.y.z
git push atomgit vx.y.z
```

## ⚠️ 注意事项

### ❌ 禁止事项

1. **不要本地构建正式版本** —— 正式发布全部通过 GitHub Actions 构建，确保产物一致性与可追溯性
2. **不要手动 `gh release create`** —— 推送 tag 会自动触发 Actions 创建 Release，手动创建会导致重复的 Draft
3. **不要用 `gh release delete` 删除已发布 Release** —— 会丢失构建产物且无法恢复（除非重新构建）
4. **不要强制推送同名 tag** —— 若已存在同名 tag，先 `git tag -d vx.y.z` 删除本地 tag，再重新创建

### ✅ 正确做法

1. **Tag 与 package.json 版本必须一致**，否则 check-version 步骤会失败
2. **Tag 必须指向最新 commit**：若指向旧 commit，用 `git tag -f vx.y.z HEAD` 更新后再推送
3. **出现重复 Draft 时**：用 `gh release edit <tag> --draft=false -t "DSH Manager vX.Y.Z"` 发布草稿，不要删除
4. **本地 dist/ 目录仅用于开发测试**，正式产物由 Actions 在远程构建并管理

## 🔄 触发方式

| 触发方式 | 说明 |
|---------|------|
| `git push origin vx.y.z` | 推送 tag 自动触发三平台构建 + Release（正式发版标准方式） |
| GitHub Actions 手动触发 | 选择 `workflow_dispatch` 手动指定平台（应急用） |

## 📦 构建产物命名对照（Actions 产物）

| 平台 | 文件名格式 | 示例 |
|------|-----------|------|
| Windows | `DSH-Manager-{version}.exe` | `DSH-Manager-1.3.4.exe` |
| macOS Intel | `DSH-Manager-{version}-x64.dmg` | `DSH-Manager-1.3.4-x64.dmg` |
| macOS Apple Silicon | `DSH-Manager-{version}-arm64.dmg` | `DSH-Manager-1.3.4-arm64.dmg` |
| Linux | `DSH-Manager-{version}.AppImage` | `DSH-Manager-1.3.4.AppImage` |

## 📝 版本号检查清单（6 处一致）

| # | 文件 | 位置 |
|---|------|------|
| 1 | `package.json` | `"version": "X.Y.Z"` |
| 2 | `packages/core/package.json` | `"version": "X.Y.Z"` |
| 3 | `packages/marketplace/package.json` | `"version": "X.Y.Z"` |
| 4 | `packages/core/src/version-manager.js` | User-Agent `dsh-manager/X.Y.Z` |
| 5 | `packages/marketplace/src/github-api.js` | User-Agent `dsh-manager/X.Y.Z` |
| 6 | `electron/ipc-handlers.js` | `app:get-version` catch fallback `'X.Y.Z'` |

## 🧯 常见问题

| 问题 | 处理 |
|------|------|
| Release list 出现 Draft 重复条目 | `gh api -X DELETE repos/linhut/dsh-manager/releases/<id>` 删除草稿，或 `gh release edit` 发布草稿 |
| 本地 npm install 失败（errno -4094） | Y: 网络卷符号链接限制，改用本地盘构建（仅开发场景） |
| Actions 构建失败 | 查看 `gh run view <run-id>` 日志；check-version 失败多为版本号不一致 |
