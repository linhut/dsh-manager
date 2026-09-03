/**
 * @dsh-manager/dsh-capability-router — 按消息内容自动切换 LLM 模型。
 *
 * 原理：
 *  - 注册 settings 段 capability-router（热加载），Manager 端把能力→provider/model
 *    映射写进同一 settings.yaml，本插件读取并应用。
 *  - 监听 agent/request waterfall（prepend: true，最外层），每次请求前根据当前轮次
 *    用户消息内容判定能力：含图片块 → vision（识图）；代码特征文本 → code（代码）；
 *    无命中 → defaultCapability（默认 semantic，语义模型）。
 *  - 仅当路由启用、该能力已配置 provider+model、且能被解析时才改写；能力未配置、
 *    模型不可解析、或当前已是目标模型时原样透传，绝不产生"看得见但用不上"的悬空配置。
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * 运行时事件日志：写入 ~/.dsh/manager/capability-router.log。
 * 目的：让用户在 Manager 端能直接看到"插件是否被 DSH 加载、每次请求是否真的
 * 按内容切换了模型"，而不是"设置了但不知道生不生效"。文件路径与 debug.log 同级，
 * 由 Manager 提供 IPC 读取并在能力路由 UI 展示。
 */
function routeLogPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "manager", "capability-router.log");
}

function writeRouteLog(line) {
  try {
    const file = routeLogPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, "[" + new Date().toISOString() + "] " + line + String.fromCharCode(10), "utf-8");
  } catch {}
}

/** Settings namespace：与 Manager 端 settings.yaml 的 capability-router 段对应。 */
export const SETTINGS_NAMESPACE = "capability-router";

/** 能力标识 → 中文名（仅用于日志）。 */
export const CAPABILITY_LABELS = {
  semantic: "语义理解",
  vision: "识图",
  image: "生图",
  code: "代码",
  embedding: "嵌入",
};

/** 设置段 schema：与 Manager 写入形状一致（宽松校验，允许未知键）。 */
export const CapabilityRouterSettingsSchema = z.object({
  enabled: z.boolean(),
  defaultCapability: z.string(),
  capabilities: z.object({}).loose(),
});

/** 能力路由配置：从 settings 段读取（含缺省回退）。 */
function readRouting(settings) {
  const cfg = (settings && typeof settings === "object") ? settings : {};
  const capabilities = (cfg.capabilities && typeof cfg.capabilities === "object") ? cfg.capabilities : {};
  return {
    enabled: cfg.enabled !== false,
    defaultCapability: cfg.defaultCapability || "semantic",
    capabilities,
  };
}

/**
 * 从一条消息的内容块判定能力。
 * @param {ReadonlyArray<{type: string; [k: string]: unknown}>} blocks
 * @returns {string|null} 命中的能力名（vision/code），无则 null
 */
export function detectCapabilityFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;
  let text = "";
  let hasImage = false;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image") hasImage = true;
    else if (block.type === "text" && typeof block.text === "string") text += block.text + "\n";
  }
  // 识图优先：消息里带图片就路由到识图模型
  if (hasImage) return "vision";
  // 代码检测：围栏代码块或常见编程关键词
  if (isCodeText(text)) return "code";
  return null;
}

/** 粗略代码特征检测（围栏块 / import/include / 函数签名 / 常见关键词）。 */
export function isCodeText(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0) return false;
  // Markdown 代码围栏
  if (/^[ \t]*```/m.test(t)) return true;
  // 文件路径 + 语言扩展
  if (/[\w-]+\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|cs|php|rb|sh|bash|sql|json|yaml|yml|html|css|vue|swift|kt|dart|mjs|cjs)\b/.test(t)) return true;
  // 常见编程关键词（需要词边界，避免误伤自然语言）
  const keywordHits = ["function", "const ", "let ", "import ", "export ", "from ", "class ", "interface ", "def ", "return ", "=>", "console.log", "public static void main", "#include", "package ", "using namespace"];
  let hits = 0;
  for (const kw of keywordHits) {
    try { if (new RegExp(kw, "m").test(t)) hits++; } catch {}
  }
  return hits >= 2;
}

/**
 * 从会话日志中取出最近一条 user 消息的内容块。
 * @param {object} session - agent.session（dsh-session）
 * @returns {ReadonlyArray<{type: string; [k: string]: unknown}>}
 */
function lastUserBlocks(session) {
  try {
    if (!session || typeof session.ownEvents !== "function") return [];
    const events = session.ownEvents();
    if (!Array.isArray(events) || events.length === 0) return [];
    // 从后往前找 user/message
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev || typeof ev !== "object") continue;
      const type = ev.type || (ev.data && ev.data.type) || "";
      const data = ev.data || ev;
      if (type === "user/message" && data && Array.isArray(data.content)) return data.content;
    }
    return [];
  } catch {
    return [];
  }
}

/** 校验 provider/model 是否已被适配器注册（避免指向不存在的路由）。 */
function isResolvable(ctx, provider, model) {
  try {
    const llm = ctx && ctx.get ? ctx.get("llm") : undefined;
    if (!llm || typeof llm.listProviders !== "function") return true; // llm 服务不可用时放行，交给 prepareCall 兜底
    const providers = llm.listProviders();
    if (!Array.isArray(providers)) return true;
    const p = providers.find(function (x) { return x && (x.id === provider || x.name === provider); });
    if (!p) return false;
    const models = p.models || [];
    return models.length === 0 || models.some(function (m) { return m && (m.id === model || m === model); });
  } catch {
    return true;
  }
}

/**
 * 插件主服务：监听 agent/created，为每个 agent 挂最外层 agent/request listener。
 */
var CapabilityRouter = class extends Service {
  constructor(ctx, config) {
    super(ctx, "capabilityRouter");
    const entry = {
      enabled: config.enabled !== false,
      defaultCapability: config.defaultCapability || "semantic",
      capabilities: (config.capabilities && typeof config.capabilities === "object") ? config.capabilities : {},
    };
    this.source = function () { return entry; };
    this.ctx = ctx;

    ctx.inject(["settings"], function (settingsCtx) {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, CapabilityRouterSettingsSchema, entry, {
        setSource: function (current) {
          // 新闭包：让 this.source 指向当前设置
          // 由于 installSection 的 setSource 在注入上下文中持有所需绑定，这里用闭包变量更新
          this.source = current;
        }.bind(this),
        onChange: function () { this.routing = readRouting(this.source()); }.bind(this),
      });
    }.bind(this));

    // 初始化路由（settings 可能尚未挂载，回退 entry）
    this.routing = readRouting(this.source());
    // 已挂载监听的 agent id 集合，避免重复注册（enter 拒绝重复、重复 on 会叠加副作用）
    this.attached = new Set();

    // 对每个新 agent 挂最外层 agent/request listener
    ctx.on("agent/created", function ({ agent }) {
      this.attachAgent(agent);
    }.bind(this));

    // 插件加载时可能已有 live agent（如 DSH 启动早期恢复的会话/已打开的会话）。
    // 这些 agent 的 agent/created 已在插件加载前触发，须在这里补注册，否则路由永不生效。
    // 注意：Service 构造器里不能直接 ctx.agents（"without inject" 报错），须用 ctx.get / ctx.inject。
    try {
      const agentsSvc = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
      if (agentsSvc && typeof agentsSvc.list === "function") {
        const live = agentsSvc.list();
        if (Array.isArray(live)) {
          for (const agent of live) this.attachAgent(agent);
        }
      } else if (typeof ctx.inject === "function") {
        // agents 服务尚未就绪：注入就绪后补注册（与 agent/created 幂等，Set 去重）
        ctx.inject(["agents"], function (scoped) {
          const s = scoped && scoped.agents;
          if (s && typeof s.list === "function") {
            const live = s.list();
            if (Array.isArray(live)) {
              for (const agent of live) this.attachAgent(agent);
            }
          }
        }.bind(this));
      }
    } catch (err) {
      if (ctx.logger && typeof ctx.logger.warn === "function") {
        ctx.logger.warn("[capability-router] 补注册已有 agent 失败（将仅对新 agent 生效）: " + String(err));
      }
    }
    if (ctx.logger && typeof ctx.logger.info === "function") {
      ctx.logger.info("[capability-router] 插件已加载，监听 agent/request（新 agent + 已有 " + (this.attached.size) + " 个 agent）");
    }
    writeRouteLog("[loaded] 插件已加载，enabled=" + entry.enabled + "，defaultCapability=" + entry.defaultCapability + "，已补挂 " + this.attached.size + " 个 agent");
  }

  /** 为单个 agent 挂最外层 agent/request listener（幂等，重复调用只注册一次）。 */
  attachAgent(agent) {
    try {
      const agentCtx = agent && agent.ctx;
      if (!agentCtx || typeof agentCtx.on !== "function") return;
      const id = agent && agent.id ? String(agent.id) : "";
      if (this.attached.has(id)) return;
      agentCtx.on("agent/request", async function (_payload, next) {
        const resolved = await next();
        return this.route(resolved, _payload, id);
      }.bind(this), { prepend: true });
      this.attached.add(id);
      if (id) writeRouteLog("[attached] agent " + id + " 已挂载 agent/request 路由监听");
    } catch (err) {
      if (this.ctx.logger && typeof this.ctx.logger.warn === "function") {
        this.ctx.logger.warn("[capability-router] 挂载 agent/request 监听失败 (" + String(agent && agent.id) + "): " + String(err));
      }
    }
  }

  /**
   * 核心路由逻辑：检测能力并改写 provider/model。
   * @param {object} resolved - next() 返回的请求配置
   * @param {object} payload - agent/request payload { agent, turn, step }
   * @param {string} agentId
   */
  async route(resolved, payload, agentId) {
    try {
      const routing = this.routing;
      if (!routing || !routing.enabled) return resolved;
      const agent = payload && payload.agent;
      const blocks = agent ? lastUserBlocks(agent.session) : [];
      if (blocks.length === 0) return resolved;
      let capability = detectCapabilityFromBlocks(blocks);
      if (!capability) capability = routing.defaultCapability || "semantic";
      // DSH 当前版本适配器仅文本输出，不支持图片生成（生图 image 能力不可用）。
      // 若 defaultCapability 被配成生图，回退语义能力；语义也未配置则透传，绝不把
      // 全部请求路由到不可用的生图模型上。
      if (capability === "image") {
        const semanticSpec = routing.capabilities["semantic"];
        if (semanticSpec && semanticSpec.provider && semanticSpec.model) capability = "semantic";
        else return resolved;
      }
      const spec = routing.capabilities[capability];
      if (!spec || !spec.provider || !spec.model) return resolved; // 该能力未配置 → 透传
      if (!isResolvable(this.ctx, spec.provider, spec.model)) return resolved; // 路由不存在 → 透传
      // 与当前一致则不变
      if (resolved && resolved.provider === spec.provider && resolved.model === spec.model) return resolved;
      const withoutEffort = resolved ? Object.assign({}, resolved) : {};
      delete withoutEffort.reasoningEffort;
      const nextCfg = Object.assign({}, withoutEffort, { provider: spec.provider, model: spec.model });
      const from = (resolved ? ((resolved.provider || "?") + "/" + (resolved.model || "?")) : "?/?");
      const eventLine = agentId + " → " + (CAPABILITY_LABELS[capability] || capability) + ": " + from + " ⇒ " + spec.provider + "/" + spec.model;
      if (this.ctx.logger && typeof this.ctx.logger.info === "function") {
        this.ctx.logger.info("[capability-router] " + eventLine);
      } else if (this.ctx.logger && typeof this.ctx.logger.debug === "function") {
        this.ctx.logger.debug("[capability-router] " + eventLine);
      }
      // 运行时事件落盘：Manager 端可直接查看"本次请求从哪个模型切到哪个模型"的真实记录
      writeRouteLog("[route] " + eventLine);
      return nextCfg;
    } catch (err) {
      // 路由异常绝不阻断请求
      if (this.ctx.logger && typeof this.ctx.logger.warn === "function") {
        this.ctx.logger.warn("[capability-router] route 异常，按原配置发送: " + String(err));
      }
      return resolved;
    }
  }
};

export default CapabilityRouter;
export { readRouting, lastUserBlocks };
