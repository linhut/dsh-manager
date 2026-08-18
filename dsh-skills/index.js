/**
 * dsh-skills - DSH 插件入口
 *
 * 将 skills/ 目录下的技能逐个注册到 ctx.skills，
 * 使 DSH 会话目录中出现这些技能，模型可通过内置 skill({ name }) 工具加载。
 *
 * 兼容 dsh-superpowers 模式：apply 时注册、dispose 时释放。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, 'skills');

/**
 * 解析 SKILL.md frontmatter（简单 YAML 子集：name/description/disable-model-invocation/user-invocable）
 * @param {string} content - SKILL.md 全文
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^"?\d+"?$/.test(value)) value = Number(value.replace(/"/g, ''));
    else value = value.replace(/^["']|["']$/g, '');
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: match[2].trim() };
}

/**
 * 读取 skills/ 下所有技能定义
 * @returns {Array<{name: string, description: string, body: string}>}
 */
function collectSkills() {
  const skills = [];
  if (!existsSync(SKILLS_DIR)) return skills;

  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    const content = readFileSync(skillPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name) {
      console.warn(`[dsh-skills] 跳过缺失 name 的技能: ${entry.name}`);
      continue;
    }

    skills.push({
      name: frontmatter.name,
      description: frontmatter.description || '',
      body,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      userInvocable: frontmatter['user-invocable'] !== false,
    });
  }

  return skills;
}

/**
 * DSH bundle apply 入口
 * @param {object} ctx - Cordis 上下文
 */
export function apply(ctx) {
  const disposers = [];

  for (const skill of collectSkills()) {
    try {
      const dispose = ctx.skills.register({
        name: skill.name,
        description: skill.description,
        body: skill.body,
        modelInvocable: !skill.disableModelInvocation,
        userInvocable: skill.userInvocable,
      });
      disposers.push(dispose);
      console.log(`[dsh-skills] 已注册技能: ${skill.name}`);
    } catch (error) {
      console.warn(`[dsh-skills] 技能注册失败 ${skill.name}: ${error.message}`);
    }
  }

  // 组合 disposer：释放本插件注册的全部技能
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch {}
    }
  };
}
