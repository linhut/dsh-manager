/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * Webview 安全策略
 * 对应 DSH 0.2.x 规范「跨端物理隔离」：
 *   1. webview 使用独立 session 分区，不与主窗口共享 cookie / localStorage / 缓存；
 *   2. 挂载前剥离 preload、禁止 Node 集成，src 必须命中本机回环地址；
 *   3. guest 会话的设备权限默认拒绝，仅按白名单放行。
 *
 * 判定逻辑全部是纯函数，主进程只做装配；tests/security-boundary.test.mjs 直接覆盖。
 */

/** webview 专用会话分区（persist: 前缀保证重启后保留，但只属于 guest） */
export const WEBVIEW_PARTITION = 'persist:dsh-web';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GUEST_PROTOCOLS = new Set(['http:', 'https:']);
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** 允许 guest 申请的权限；其余一律拒绝（摄像头/麦克风/定位/通知等） */
const DEFAULT_ALLOWED_PERMISSIONS = Object.freeze(['clipboard-sanitized-write']);

function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(String(hostname || '').toLowerCase());
}

/**
 * webview 只允许加载本机 DSH 页面。
 * 注意不能用 startsWith 判断主机名：`127.0.0.1.evil.com` 会被误放行。
 */
export function isAllowedWebviewSrc(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  if (!GUEST_PROTOCOLS.has(url.protocol)) return false;
  return isLocalHostname(url.hostname);
}

/** 外部跳转只允许常规协议，file: / javascript: / data: 一律拒绝 */
export function isSafeExternalUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  return Boolean(url && EXTERNAL_PROTOCOLS.has(url.protocol));
}

/**
 * 就地加固 webPreferences（Electron 直接读取该对象，因此必须改原对象）。
 * preload 必须删除：否则 guest 会继承主应用桥，等于把 IPC 全量交给远程页面。
 */
export function sanitizeWebviewPreferences(prefs) {
  if (!prefs || typeof prefs !== 'object') return prefs;
  delete prefs.preload;
  delete prefs.preloadURL;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.experimentalFeatures = false;
  prefs.partition = WEBVIEW_PARTITION;
  return prefs;
}

/**
 * will-attach-webview 的判定与加固。
 * 返回 { allowed, src, reason }，主进程据此记日志；非法挂载已调用 preventDefault。
 */
export function guardWebviewAttach(event, webPreferences, params) {
  const src = params && typeof params.src === 'string' ? params.src : '';

  if (!isAllowedWebviewSrc(src)) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    return { allowed: false, src, reason: 'src-not-allowed' };
  }

  sanitizeWebviewPreferences(webPreferences);

  if (params && typeof params === 'object') {
    delete params.preload;
    params.partition = WEBVIEW_PARTITION;
  }

  return { allowed: true, src, reason: 'ok' };
}

/**
 * 给某个 session 安装权限策略：默认拒绝，白名单放行。
 * 同时关闭同步权限检查，避免 request 被拒后 check 仍返回 true。
 */
export function installSessionGuards(electronSession, options = {}) {
  if (!electronSession) return { installed: false };

  const allowed = new Set(
    Array.isArray(options.allowedPermissions) ? options.allowedPermissions : DEFAULT_ALLOWED_PERMISSIONS
  );

  if (typeof electronSession.setPermissionRequestHandler === 'function') {
    electronSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowed.has(permission));
    });
  }

  if (typeof electronSession.setPermissionCheckHandler === 'function') {
    electronSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  }

  return { installed: true, allowed: [...allowed] };
}
