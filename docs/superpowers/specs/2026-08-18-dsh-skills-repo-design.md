# 设计文档：独立 DSH Skill 仓库（dsh-skills）

日期：2026-08-18
状态：待用户审阅

## 一、需求背景

用户希望将一批实用 skill（brainstorming、using-superpowers、finishing-a-development-branch、writing-skills、github-actions-docs、how-it-works）聚合为一个**独立的 DSH skill 仓库**，供 DSH（DeepSeek Harness）会话调用。

**可行性结论**（已核实官方文档）：
- DSH 原生支持 skill：`ctx.skills` 注册表 + 面向模型的 `skill({ name })` 工具
- 本地 provider `dsh-skill-filesystem` 扫描 `~/.dsh/skills` 与 `customSkillDirs`，每个 skill 一个目录（`SKILL.md` + frontmatter）即可被发现
- 插件可通过 `ctx.skills.register()` 注册内置 skill（`dsh-superpowers` 已示范）
- superpowers 生态为 **MIT 许可**（obra/superpowers, © Jesse Vincent），可合法二次分发（保留版权声明）

## 二、方案选择

**选定方案：方案 C —— 混合形态**（纯 `skills/` 目录 + 薄插件入口）。

理由：
- 纯目录形态与 DSH 本地 provider 完全兼容，零依赖，用户可手动拷贝
- 插件入口使其成为合法 bundle，可 `dsh plugin add` 安装、可进 dsh-manager 插件市场打推荐
- 成本仅为三个小文件（package.json / cordis.patch.yml / index.js）

## 三、设计

### 3.1 仓库结构

```
dsh-skills/
├── skills/                  # 纯技能目录（DSH 本地 provider 原生可发现）
│   ├── brainstorming/
│   │   └── SKILL.md         # frontmatter: name/description/modelInvocable
│   ├── using-superpowers/
│   │   └── SKILL.md
│   ├── finishing-a-development-branch/
│   │   └── SKILL.md
│   ├── writing-skills/
│   │   └── SKILL.md
│   ├── github-actions-docs/
│   │   └── SKILL.md
│   └── how-it-works/
│       └── SKILL.md
├── package.json             # 声明 dsh.bundle.patch（插件入口）
├── cordis.patch.yml         # 插件补丁：登记技能根
├── index.js                 # ctx.skills.register() 逐个注册 skills/
├── README.md                # 安装与使用说明（中英双语）
└── LICENSE                  # MIT（superpowers 衍生技能保留版权声明）
```

### 3.2 SKILL.md frontmatter 规范

每个 skill 目录内 `SKILL.md` 采用 DSH 规范：

```yaml
---
name: brainstorming           # kebab-case
description: 用于任何创意工作前的需求探索与设计……  # 模型可见，控制触发
disable-model-invocation: false  # 可选，默认 true 允许模型调用
user-invocable: true             # 可选，默认 true
---
# 技能正文（步骤、原则、HARD-GATE 等）
```

- `name` 必须 kebab-case、与目录名一致
- `description` 是会话目录中模型看到的唯一信息，需自描述触发条件
- 目录只暴露 name + description，正文按需经 `skill` 工具加载

### 3.3 插件入口（bundle）

- `package.json`：声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 与 `keywords` 含 `dsh-plugin`、`dsh`、`skills`
- `cordis.patch.yml`：`- insert:` 登记 bundle 根
- `index.js`：`ctx.skills.register()` 逐个注册 `skills/` 下的技能（解析每个 `SKILL.md` 的 frontmatter，正文按需读取），并提供 disposer

### 3.4 两种安装路径

| 路径 | 命令/操作 | 适用场景 |
|---|---|---|
| 纯目录 | 克隆后 `cp -r skills/* ~/.dsh/skills/` 或配置 `customSkillDirs` 指向 `skills/` | 不想用插件体系、想直接编辑技能 |
| 插件 | `dsh plugin --profile web add github:<owner>/dsh-skills` | 一键安装、进插件市场、随 profile 管理 |

### 3.5 与 dsh-manager 的联动

- 仓库打上 GitHub `dsh-plugin` topic，dsh-manager 插件市场即可搜索到
- 复用现有推荐机制：在 `packages/marketplace/src/registry.js` 精选列表与 `src/assets/js/app.js` 离线 fallback 中加推荐条目（与 `dsh-superpowers` 同模式）

## 四、许可与归属

- 衍生自 obra/superpowers 的技能（brainstorming、using-superpowers、finishing-a-development-branch、writing-skills）保留 `LICENSE.superpowers`（MIT © Jesse Vincent）并注明来源
- `github-actions-docs`、`how-it-works` 按各自来源许可纳入，README 中注明出处
- 仓库整体 LICENSE 为 MIT

## 五、范围（YAGNI）

- 首期只含 6 个指定技能；其余技能后续按需添加
- 不做：skill 版本管理、自动更新器、多语言技能变体（除 README 双语外）
- 不影响：dsh-manager 现有功能

## 六、测试

- 纯目录：将 `skills/` 配置为 `customSkillDirs`，启动 DSH 会话确认技能出现在会话目录
- 插件：`dsh plugin add` 后确认 `ctx.skills` 注册成功、`skill({ name })` 可加载正文
- frontmatter 校验：`name` kebab-case、目录名一致、`description` 非空
