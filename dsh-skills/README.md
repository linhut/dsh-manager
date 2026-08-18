# 🐳 dsh-skills

实用技能合集，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 提供开箱即用的方法论与工具技能。

A collection of practical skills for DeepSeek Harness (dsh).

## 技能清单 / Skills

| Skill | 用途 / Purpose |
|---|---|
| `brainstorming` | 创意工作前的需求探索与设计流程 / Explore intent, requirements and design before implementation |
| `using-superpowers` | 会话引导：何时使用技能体系 / Session bootstrap: when to use the skills system |
| `finishing-a-development-branch` | 开发完成后的合并 / PR / 清理决策 / Decide merge, PR, or cleanup when work is done |
| `writing-skills` | 编写 / 编辑 / 验证新技能 / Create, edit, and verify skills |
| `github-actions-docs` | GitHub Actions 工作流文档与排查 / Docs-grounded GitHub Actions guidance |
| `how-it-works` | 解释内部机制（如 claude-mem 如何工作）/ Explain how internal mechanisms work |

## 安装 / Installation

### 方式一：纯目录（无需插件体系）/ Plain directory (no plugin system)

克隆仓库后，把 `skills/` 下的技能目录拷入 DSH 技能目录，或配置 `customSkillDirs`：

```sh
git clone https://github.com/linhut/dsh-skills.git
# 方式 A：拷入全局技能目录
cp -r dsh-skills/skills/* ~/.dsh/skills/
# 方式 B：在 settings.yaml 中配置 customSkillDirs 指向 dsh-skills/skills
```

### 方式二：插件安装（推荐，可进插件市场）/ Plugin install (recommended)

```sh
dsh plugin --profile web add github:linhut/dsh-skills
```

DSH 会在会话目录中展示技能名称，模型通过内置 `skill({ name })` 工具按需加载技能正文。

## 开发 / Development

- 每个技能一个目录：`skills/<name>/SKILL.md`
- `SKILL.md` 头部为 frontmatter：`name`（kebab-case，与目录名一致）、`description`（模型可见，用于触发）、可选 `disable-model-invocation` / `user-invocable`
- 校验技能格式：`node scripts/validate-skills.mjs`

## 许可 / License

- 仓库整体：MIT（见 [LICENSE](LICENSE)）
- 衍生自 [obra/superpowers](https://github.com/obra/superpowers) 的技能（brainstorming、using-superpowers、finishing-a-development-branch、writing-skills）：MIT © Jesse Vincent（见 [LICENSE.superpowers](LICENSE.superpowers)）
- 其余技能按各自来源许可使用
