/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DSHError, DSHErrorCodes } from "./errors.js";
import { DSH_PATHS } from "./dsh-utils.js";

const PROMPTS_FILE = join(DSH_PATHS.managerDir, "master-prompts.json");

/**
 * 生成短 ID
 */
function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class MasterPromptManager {
  /**
   * 读取所有提示词
   * @returns {Array}
   */
  read() {
    try {
      if (existsSync(PROMPTS_FILE)) {
        const data = JSON.parse(readFileSync(PROMPTS_FILE, "utf-8"));
        return Array.isArray(data.prompts) ? data.prompts : [];
      }
    } catch {}
    return [];
  }

  /**
   * 写入提示词列表
   * @private
   */
  _write(prompts) {
    mkdirSync(DSH_PATHS.managerDir, { recursive: true });
    writeFileSync(PROMPTS_FILE, JSON.stringify({ prompts, version: 1, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  }

  /**
   * 列出所有提示词
   * @param {object} [filter]
   * @param {string} [filter.category]
   * @param {boolean} [filter.enabled]
   * @param {string} [filter.query]
   * @returns {Array}
   */
  list(filter) {
    if (filter === undefined) filter = {};
    let items = this.read();
    if (filter.category && filter.category !== "all") {
      items = items.filter((p) => p.category === filter.category);
    }
    if (filter.enabled !== undefined) {
      items = items.filter((p) => p.enabled === filter.enabled);
    }
    if (filter.query) {
      const q = String(filter.query).toLowerCase();
      items = items.filter((p) => p.content.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q));
    }
    return items.sort((a, b) => a.createdAt > b.createdAt ? -1 : 1);
  }

  /**
   * 获取单个提示词
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    return this.read().find((p) => p.id === id) || null;
  }

  /**
   * 创建提示词
   * @param {object} input
   * @param {string} input.content - 提示词内容
   * @param {string} [input.description] - 描述
   * @param {string} [input.category] - 分类
   * @param {boolean} [input.enabled] - 是否启用
   * @returns {object}
   */
  create(input) {
    const content = String(input.content || "").trim();
    if (!content) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, "提示词内容不能为空");
    const prompts = this.read();
    const prompt = {
      id: shortId(),
      content,
      description: String(input.description || "").trim(),
      category: input.category || "general",
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    prompts.push(prompt);
    this._write(prompts);
    return { success: true, prompt };
  }

  /**
   * 更新提示词
   * @param {string} id
   * @param {object} patch
   * @returns {object}
   */
  update(id, patch) {
    const prompts = this.read();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx === -1) throw new DSHError(DSHErrorCodes.NOT_FOUND, "提示词不存在: " + id);
    if (patch.content !== undefined) {
      const trimmed = String(patch.content).trim();
      if (!trimmed) throw new DSHError(DSHErrorCodes.CONFIG_PARSE_ERROR, "提示词内容不能为空");
      prompts[idx].content = trimmed;
    }
    if (patch.description !== undefined) prompts[idx].description = String(patch.description).trim();
    if (patch.category !== undefined) prompts[idx].category = patch.category;
    if (patch.enabled !== undefined) prompts[idx].enabled = !!patch.enabled;
    prompts[idx].updatedAt = new Date().toISOString();
    this._write(prompts);
    return { success: true, prompt: prompts[idx] };
  }

  /**
   * 删除提示词
   * @param {string} id
   * @returns {object}
   */
  delete(id) {
    const prompts = this.read();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx === -1) throw new DSHError(DSHErrorCodes.NOT_FOUND, "提示词不存在: " + id);
    prompts.splice(idx, 1);
    this._write(prompts);
    return { success: true };
  }

  /**
   * 切换启用/禁用
   * @param {string} id
   * @param {boolean} enabled
   * @returns {object}
   */
  toggle(id, enabled) {
    return this.update(id, { enabled });
  }

  /**
   * 渲染所有启用中的提示词为格式化指令块
   * 可用于注入到 Agent 上下文或预设。
   * @param {object} [options]
   * @param {string} [options.format] - "text" | "markdown" | "yaml"
   * @returns {string}
   */
  render(options) {
    if (options === undefined) options = {};
    const { format = "text" } = options;
    const prompts = this.read().filter((p) => p.enabled);
    if (prompts.length === 0) return "";

    if (format === "markdown") {
      const lines = ["---", "## 全局工作指令", ""];
      for (const p of prompts) {
        lines.push("- " + p.content);
        if (p.description) lines.push("  > " + p.description);
      }
      lines.push("");
      return lines.join("\n");
    }

    const lines = ["[全局工作指令]"];
    for (const p of prompts) {
      lines.push("- " + p.content);
    }
    return lines.join("\n");
  }

  /**
   * 获取启用中的提示词数量
   * @returns {number}
   */
  getEnabledCount() {
    return this.read().filter((p) => p.enabled).length;
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  stats() {
    const prompts = this.read();
    const enabled = prompts.filter((p) => p.enabled).length;
    const categories = {};
    for (const p of prompts) {
      categories[p.category || "general"] = (categories[p.category || "general"] || 0) + 1;
    }
    return {
      total: prompts.length,
      enabled,
      disabled: prompts.length - enabled,
      categories,
    };
  }
}