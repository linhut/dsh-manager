# 实施计划：独立 DSH Skill 仓库（dsh-skills）

对应规格：`docs/superpowers/specs/2026-08-18-dsh-skills-repo-design.md`
日期：2026-08-18

## 目标

创建独立仓库 `dsh-skills`（混合形态）：`skills/` 纯技能目录（DSH 本地 provider 可直接发现）+ 薄插件入口（可 `dsh plugin add` 安装、可进 dsh-manager 插件市场打推荐）。首期 6 个技能：brainstorming、using-superpowers、finishing-a-development-branch、writing-skills、github-actions-docs、how-it-works。

## 前置准备

1. 在 GitHub 创建空仓库（如 `linhut/dsh-skills`），打上 `dsh-plugin`、`dsh`、`skills`、`deepseek-harness` topics（发布时由用户执行）
2. 从 obra/superpowers（MIT © Jesse Vincent）与当前技能环境导出 6 个技能的 SKILL.md 内容作为基础，转换为 DSH 规范 frontmatter

## 改动清单（按依赖顺序）

### 1. 仓库骨架
```
dsh-skills/
├── .gitignore
├── LICENSE                # MIT（仓库整体）
├── LICENSE.superpowers    # superpowers 衍生技能版权声明（MIT © Jesse Vincent）
├── README.md              # 中英双语：安装（纯目录/插件两路径）、技能清单、许可
├── package.json           # name/version/description/keywords + dsh.bundle.patch
├── cordis.patch.yml       # - insert: 登记 bundle 根
├── index.js               # ctx.skills.register() 逐个注册 skills/*/SKILL.md
└── skills/
    ├── brainstorming/SKILL.md
    ├── using-superpowers/SKILL.md
    ├── finishing-a-development-branch/SKILL.md
    ├── writing-skills/SKILL.md
    ├── github-actions-docs/SKILL.md
    └── how-it-works/SKILL.md
```

### 2. 技能文件（6 个 SKILL.md）

每个 `SKILL.md`：
- frontmatter：`name`（kebab-case，与目录名一致）、`description`（自描述触发条件，供会话目录展示）、可选 `disable-model-invocation`/`user-invocable`
- 正文：从来源技能导出（brainstorming 含 HARD-GATE 与流程；using-superpowers 为会话引导；finishing-a-development-branch 为完成/合并决策流程；writing-skills 为技能编写规范；github-actions-docs 为 GitHub Actions 文档指引；how-it-works 为 claude-mem 机制说明），按 DSH 上下文调整措辞
- 保留来源版权声明注释（衍生自 obra/superpowers 的技能）

### 3. 插件入口

- `package.json`：
  ```json
  {
    "name": "dsh-skills",
    "version": "0.1.0",
    "type": "module",
    "keywords": ["dsh-plugin", "dsh", "skills", "deepseek-harness"],
    "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
  }
  ```
- `cordis.patch.yml`：`- insert:` 登记 bundle 根（id: dsh-skills, name: 'dsh-skills'）
- `index.js`：读取 `skills/*/SKILL.md` 的 frontmatter，对每个技能调用 `ctx.skills.register({ name, description, body })`，返回组合 disposer；`apply` 时注册、`dispose` 时释放

### 4. 与 dsh-manager 联动（可选，发布后）

- 在 `packages/marketplace/src/registry.js` 精选列表与 `src/assets/js/app.js` 离线 fallback 中新增 `dsh-skills` 推荐条目（`recommended: true`，与 dsh-superpowers 同模式）
- 仓库 URL 发布后更新推荐条目 `fullName/url/stars`

## 验证步骤

1. **frontmatter 校验**：`name` kebab-case、与目录一致、`description` 非空；可写校验脚本 `node scripts/validate-skills.mjs`
2. **纯目录**：配置 `customSkillDirs` 指向 `skills/`（或拷入 `~/.dsh/skills`），启动 DSH 会话确认 6 个技能出现在会话目录
3. **插件**：`dsh plugin --profile web add github:<owner>/dsh-skills` 后确认 `ctx.skills` 注册成功、`skill({ name })` 可加载正文
4. **dsh-manager**：构建后打开插件市场，确认 `dsh-skills` 显示 ⭐ 推荐并可安装

## 提交策略

- 仓库初始化单次提交（骨架 + 6 技能 + 插件入口 + 文档），message 前缀 `feat:`，附 `Co-Authored-By` trailer
- dsh-manager 侧推荐条目独立提交（前缀 `feat:`）
