/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_PATHS } from './dsh-utils.js';
import { DSHConfig } from './config.js';
import { DSHError, DSHErrorCodes } from './errors.js';

/** 指令块起始标记 */
const BLOCK_START = '<!-- dsh-manager:reply-language -->';
/** 指令块结束标记 */
const BLOCK_END = '<!-- /dsh-manager:reply-language -->';
/** 指令块整体匹配（含前后空行），用于幂等替换/移除 */
const BLOCK_RE = /\n?<!-- dsh-manager:reply-language -->[\s\S]*?<!-- \/dsh-manager:reply-language -->\n?/;

/** 语言取值白名单 */
const LANG_VALUES = ['zh-CN', 'en', 'default'];

/** 配置键（写入 ~/.dsh/settings.yaml） */
const CONFIG_KEY = 'manager.reply-language';

/** AGENTS.md 路径 */
function agentsMdPath() {
  return join(DSH_PATHS.home, 'AGENTS.md');
}

/** 语言指令模板（内容取自设计规格 3.3） */
const LANG_DIRECTIVES = {
  'zh-CN': `# 语言规则
- 默认始终使用简体中文进行思考（reasoning）与所有最终回答。
- 计划、工具调用、总结、代码注释同样使用简体中文。
- 仅代码、命令、文件路径、变量名、API 名称等必须原样保留的内容使用英文。
- 若某个工作区/项目的 AGENTS.md 明确指定了其他语言，则以该项目级规则为准。`,
  'en': `# Language Rules
- Think (reasoning) and reply in English by default.
- Plans, tool calls, summaries, and code comments are also in English.
- Code, commands, file paths, variable names, API names, and other content that must stay verbatim remain in their original form.
- If a workspace/project AGENTS.md explicitly specifies another language, that project-level rule takes precedence.`,
};

/**
 * 构建指令块文本
 * @param {string} lang - 'zh-CN' | 'en' | 'default'
 * @returns {string|null} 指令块文本；'default' 返回 null
 */
function _buildBlock(lang) {
  if (lang === 'default' || !LANG_DIRECTIVES[lang]) return null;
  return `${BLOCK_START}\n${LANG_DIRECTIVES[lang]}\n${BLOCK_END}`;
}

/**
 * 对 AGENTS.md 应用语言指令（幂等）
 * @param {string} lang - 'zh-CN' | 'en' | 'default'
 * @returns {{changed: boolean, existed: boolean, prevContent: string}} 变更与回滚信息
 */
function _applyToAgentsMd(lang) {
  const filePath = agentsMdPath();
  const existed = existsSync(filePath);
  const prevContent = existed ? readFileSync(filePath, 'utf-8') : '';
  const block = _buildBlock(lang);

  let next = prevContent;
  if (block === null) {
    // 移除已有指令块
    next = prevContent.replace(BLOCK_RE, '');
  } else if (BLOCK_RE.test(prevContent)) {
    // 已有指令块 → 整体替换
    next = prevContent.replace(BLOCK_RE, `\n${block}\n`);
  } else {
    // 无指令块 → 追加到末尾
    next = prevContent.trimEnd() ? `${prevContent.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`;
  }

  if (next === prevContent) {
    return { changed: false, existed, prevContent };
  }

  writeFileSync(filePath, next, 'utf-8');
  return { changed: true, existed, prevContent };
}

/**
 * 回滚 AGENTS.md 到写入前状态
 * @param {{existed: boolean, prevContent: string}} state
 */
function _rollbackAgentsMd(state) {
  const filePath = agentsMdPath();
  if (!state.changed) return;
  if (state.existed) {
    writeFileSync(filePath, state.prevContent, 'utf-8');
  } else {
    rmSync(filePath, { force: true });
  }
}

/**
 * 设置回复语言
 * @param {string} lang - 'zh-CN' | 'en' | 'default'
 */
export async function setReplyLanguage(lang) {
  if (!LANG_VALUES.includes(lang)) {
    throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, `无效的语言取值: ${lang}`);
  }

  const state = _applyToAgentsMd(lang);

  const config = new DSHConfig();
  try {
    if (lang === 'default') {
      await config.delete(CONFIG_KEY);
    } else {
      await config.set(CONFIG_KEY, lang);
    }
  } catch (error) {
    // 配置写失败 → 回滚 AGENTS.md，保持两处一致
    _rollbackAgentsMd(state);
    throw error;
  }
}

/**
 * 获取当前回复语言
 * @returns {Promise<string>} 'zh-CN' | 'en' | 'default'
 */
export async function getReplyLanguage() {
  const config = new DSHConfig();
  const lang = await config.get(CONFIG_KEY);
  return LANG_VALUES.includes(lang) ? lang : 'default';
}

/**
 * 清除回复语言设置（移除指令块并删除配置键）
 */
export async function clearReplyLanguage() {
  await setReplyLanguage('default');
}
