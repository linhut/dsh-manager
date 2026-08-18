---
name: writing-skills
description: 当创建新技能、编辑已有技能或验证技能可正常部署时使用。规范技能的编写、测试与验证方法。
disable-model-invocation: false
user-invocable: true
---
# Writing Skills

## 何时使用

创建新技能、编辑已有技能、或验证技能在部署前可正常工作。

## 编写规范

### 结构
每个技能一个文件/目录，包含：
- frontmatter：`name`（kebab-case、与目录名一致）、`description`（模型可见、自描述触发条件）、可选 `disable-model-invocation` / `user-invocable`
- 正文：何时使用、核心原则、流程步骤、HARD-GATE（如有）、反模式、注意事项

### 描述写法
`description` 是会话目录中模型看到的唯一信息，必须：
- 明确触发条件（"当用户要求 X 时使用"）
- 包含关键词便于匹配
- 说明"先做什么再做什么"

### 正文写法
- 流程用编号步骤，可执行、可验证
- 关键决策点明确（"一次只问一个问题"这类纪律写清楚）
- 边界条件（HARD-GATE / 红旗 / 反模式）单独成节

## 验证

1. frontmatter 校验：`name` kebab-case、与目录一致、`description` 非空
2. 部署到目标环境（如 DSH `~/.dsh/skills` 或 `customSkillDirs`）
3. 实测：触发条件能命中、流程可执行、产出符合预期
4. 回归：修改不破坏既有触发与执行

## 注意

- 不添加无法发生的场景的错误处理
- 保持与其他技能的命名与格式一致
- 文档化技能来源与许可（衍生技能保留版权声明）
