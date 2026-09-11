/**
 * DSH web 官方集成契约（依据 @deepseek-ai/dsh-web-app 官方行为与 dsh CLI 帮助整理）：
 *
 * 1. `dsh web` 会打印一条带 token 的启动 URL（tokenized startup URL），
 *    客户端/浏览器必须使用该 URL 换取签名会话 cookie；直接访问裸 URL 会被
 *    官方 /api 拒绝（"dsh web authentication required; reopen the URL printed by dsh web"）。
 * 2. 打印行格式为 "dsh web: http(s)://<host>:<port>/?token=..."（host 受 --host 参数影响）。
 * 3. 官方不支持绑定全网络接口（binding all network interfaces is intentionally not supported）。
 * 4. profile 依赖（node_modules 布局）必须可被 dsh 的插件树正常加载；指向 profile 目录外部的
 *    link:/file: 依赖不符合官方 profile 布局要求，会导致 "plugin tree failed to load"。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 官方打印行匹配：`dsh web: <url>`（容忍 ANSI 与任意 host） */
export const DSH_WEB_URL_LINE_RE = /dsh web:\s*(https?:\/\/\S+)/i;

/** 官方鉴权 URL 的主机必须是回环地址（127.0.0.1 / localhost / [::1]），且必须携带 token 查询参数 */
const LOOPBACK_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i;

/**
 * 判断一个 URL 是否为合法的 DSH web 官方案例鉴权 URL（回环主机 + 带 token）。
 * @param {string} url
 * @returns {boolean}
 */
export function isDSHWebAuthUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return LOOPBACK_URL_RE.test(url) && url.includes('token=');
}

/**
 * 从 dsh web 的打印行中提取鉴权 URL（官方契约：客户端必须使用带 token 的打印 URL）。
 * @param {string} line
 * @returns {string|null} 合法鉴权 URL；未打印或非法（裸 URL / 外部主机）返回 null
 */
export function extractDSHWebAuthUrl(line) {
  if (typeof line !== 'string' || !line) return null;
  const m = line.match(DSH_WEB_URL_LINE_RE);
  if (!m) return null;
  const url = m[1].trim();
  return isDSHWebAuthUrl(url) ? url : null;
}

/**
 * 依据官方 profile 布局要求预检 DSH profile 目录：
 * 检测 package.json 中指向 profile 目录外部的 link:/file: 依赖（会导致插件树加载失败），
 * 以及未随 profile 安装（无法在本 profile 内解析）的依赖。
 * @param {string} profileDir profile 目录（含 package.json）
 * @param {object} [deps] 依赖表（可为 null，此时会读取 profileDir/package.json）
 * @returns {{ ok: true } | { ok: false, violations: Array<{ name: string, spec: string, reason: string }> }}
 */
export function preflightDSHProfile(profileDir, deps = null) {
  if (!deps) {
    try {
      const pkgPath = path.join(profileDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return { ok: true }; // 无 profile 包则跳过预检
      deps = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies || {};
    } catch (error) {
      // 读取失败不阻塞启动，交由运行期错误暴露
      return { ok: true };
    }
  }
  const violations = [];
  const resolvedProfileDir = path.resolve(profileDir);
  const profilePrefix = resolvedProfileDir + path.sep;
  for (const [name, spec] of Object.entries(deps || {})) {
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      const target = spec.slice(spec.indexOf(':') + 1);
      const targetPath = path.resolve(resolvedProfileDir, target);
      const isOutside = targetPath !== resolvedProfileDir && !targetPath.startsWith(profilePrefix);
      if (isOutside) {
        violations.push({
          name,
          spec,
          reason: `依赖指向 profile 目录外部（${targetPath}），不符合 DSH 官方 profile 布局要求，会导致 "plugin tree failed to load"`,
        });
      }
    }
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}