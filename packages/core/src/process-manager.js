/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';

/** 端口扫描缓存 TTL（毫秒）：findAvailablePort 探测 20 个端口时避免重复跑 netstat */
const PORT_CACHE_TTL = 3000;

/** DSH Web 默认端口 */
export const DSH_WEB_PORT = 3080;

// 模块级缓存：Windows netstat 输出（3s TTL）
let _netstatCache = { time: 0, stdout: '' };
async function getNetstatLines() {
  const now = Date.now();
  if (now - _netstatCache.time < PORT_CACHE_TTL && _netstatCache.stdout) {
    return _netstatCache.stdout;
  }
  try {
    const { stdout } = await execa('netstat', ['-ano'], { timeout: 10_000, reject: false, windowsHide: true });
    _netstatCache = { time: now, stdout };
    return stdout;
  } catch {
    return null;
  }
}

/** 随机端口探测范围（避开常见占用区间） */
const PORT_SCAN_MIN = 3100;
const PORT_SCAN_MAX = 3999;

/**
 * 随机端口号
 * @returns {number}
 */
function randomPort() {
  return Math.floor(Math.random() * (PORT_SCAN_MAX - PORT_SCAN_MIN + 1)) + PORT_SCAN_MIN;
}

/**
 * 检查单个端口是否可绑定（未被监听）
 * 通过 netstat / lsof 探测，探测失败时返回 true（视为空闲，不阻断）。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isPortFree(port) {
  try {
    if (process.platform === 'win32') {
      const stdout = await getNetstatLines();
      if (stdout === null) return true; // 探测失败视为空闲，不阻断
      // 用正则匹配端口号前后为分隔符，避免 :3080 误匹配 :30805 / :13080 等
      const portRe = new RegExp('[:.]' + port + '(?=[^0-9]|$)', 'i');
      const lines = stdout.split(/\r?\n/).filter(l => {
        return portRe.test(l) && l.trim().toUpperCase().includes('LISTENING');
      });
      return lines.length === 0;
    }
    // 非 Windows：优先 lsof
    try {
      const { stdout } = await execa('lsof', ['-i', `:${port}`], { timeout: 10_000, reject: false , windowsHide: true});
      return !stdout.split(/\r?\n/).some(l => l.includes('LISTEN'));
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

/**
 * 查找可用端口：优先 preferredPort，被占用则尝试随机空闲端口
 * @param {number} [preferredPort=3080] - 首选端口
 * @param {number} [attempts=20] - 随机探测次数上限
 * @returns {Promise<{port: number, used: boolean, preferredPort: number}>}
 *   - used=true：返回的 port 与 preferredPort 不同（自动更换了端口）
 *   - used=false：preferredPort 空闲，直接使用
 */
export async function findAvailablePort(preferredPort = DSH_WEB_PORT, attempts = 20) {
  const preferred = Number(preferredPort) || DSH_WEB_PORT;

  // 首选端口空闲 → 直接使用
  if (await isPortFree(preferred)) {
    return { port: preferred, used: false, preferredPort: preferred };
  }

  // 首选被占用 → 随机探测
  const tried = new Set([preferred]);
  for (let i = 0; i < attempts; i++) {
    const candidate = randomPort();
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    if (await isPortFree(candidate)) {
      return { port: candidate, used: true, preferredPort: preferred };
    }
  }

  // 全部失败：返回首选端口，由调用方决定是否报错
  return { port: preferred, used: false, preferredPort: preferred };
}

/**
 * 获取 DSH 服务进程信息
 * @param {number} [port=3080] - 检测端口
 * @returns {Promise<{port: number, portInUse: boolean, pid: number|null, command: string|null}>}
 */
export async function getDSHProcessInfo(port = DSH_WEB_PORT) {
  const base = { port, portInUse: false, pid: null, command: null };

  try {
    if (process.platform === 'win32') {
      // netstat -ano 提取端口行 → PID
      const stdout = await getNetstatLines();
      if (stdout === null) return base;
      // 用正则匹配端口号前后为分隔符，避免 :3080 误匹配 :30805 / :13080 等
      const portRe = new RegExp('[:.]' + port + '(?=[^0-9]|$)', 'i');
      const lines = stdout.split(/\r?\n/).filter(l => {
        return portRe.test(l) && l.trim().toUpperCase().includes('LISTENING');
      });
      if (lines.length > 0) {
        const pidMatch = lines[0].trim().split(/\s+/).pop();
        const pid = pidMatch && /^\d+$/.test(pidMatch) ? Number(pidMatch) : null;
        base.portInUse = true;
        base.pid = pid;
        // tasklist 取进程名
        if (pid) {
          const { stdout: tl } = await execa('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10_000, reject: false , windowsHide: true});
          const m = tl.match(/"([^"]+)"/);
          if (m) base.command = m[1];
        }
      }
    } else {
      // 非 Windows：优先 lsof，缺失则静默降级为未占用
      try {
        const { stdout } = await execa('lsof', ['-i', `:${port}`], { timeout: 10_000, reject: false , windowsHide: true});
        const line = stdout.split(/\r?\n/).find(l => l.includes('LISTEN'));
        if (line) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
          base.portInUse = true;
          base.pid = pid;
          base.command = parts[0] || null;
        }
      } catch (e) { console.warn("[dsh-manager] 操作失败:", e?.message); }
    }
  } catch {
    // 任何探测失败均视为空闲，不阻断
  }

  return base;
}

/**
 * 探测 DSH Web 是否真正可访问（HTTP 存活检查）
 * 解决"进程在但页面打不开"的误判：端口被占用 ≠ DSH 在服务。
 * @param {number} [port=3080]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{reachable: boolean, status: number|null, error: string|null, url: string}>}
 */
export async function testDSHHealth(port = DSH_WEB_PORT, timeoutMs = 5000) {
  const url = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    // DSH 0.1.2-alpha.4 起 web 需要 token 鉴权：无 token 访问根路径返回 401。
    // 401 说明服务已在运行（只是要求鉴权），仍应视为"可达"。
    const reachable = resp.ok || resp.status === 401;
    return { reachable, status: resp.status, error: null, url };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: error?.cause?.code || error?.message || '连接失败',
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一键诊断 DSH Web 服务（端口/进程/HTTP 可达性）
 * 对应线上问题："两次启动都显示成功，但浏览器永远打不开"。
 * @param {number} [port=3080]
 * @returns {Promise<{
 *   port: number, portFree: boolean, portInUse: boolean, pid: number|null, command: string|null,
 *   health: {reachable: boolean, status: number|null, error: string|null, url: string},
 *   issues: string[], suggestions: string[], summary: string
 * }>}
 */
export async function diagnoseDSHProcess(port = DSH_WEB_PORT) {
  const issues = [];
  const suggestions = [];

  const proc = await getDSHProcessInfo(port);
  const health = await testDSHHealth(port);

  if (proc.portInUse && proc.pid) {
    if (!health.reachable) {
      issues.push(`端口 ${port} 已被进程 PID ${proc.pid}（${proc.command || '未知'}）占用，但 HTTP 无法访问`);
      suggestions.push('该进程可能不是 DSH 服务，或 DSH 启动后立即崩溃但端口尚未释放');
      suggestions.push('可尝试"停止服务"释放端口后重新启动');
    } else {
      issues.length = 0; // 正常
    }
  } else if (!health.reachable) {
    issues.push(`端口 ${port} 空闲，DSH Web 服务未在运行`);
    suggestions.push('最常见原因：dsh web 进程随启动它的终端/任务计划退出被一并回收');
    suggestions.push('请通过本软件"启动服务"按钮启动（管理器会以独立进程方式托管，不再依赖终端会话）');
    suggestions.push('若端口被其他程序占用，启动时将自动切换到随机空闲端口');
  }

  return {
    port,
    portFree: !proc.portInUse,
    portInUse: proc.portInUse,
    pid: proc.pid,
    command: proc.command,
    health,
    issues,
    suggestions,
    summary: issues.length === 0
      ? `DSH Web 正常运行中：http://127.0.0.1:${port}（PID ${proc.pid || '-'}）`
      : issues.join('；'),
  };
}

/**
 * 按端口结束占用进程（用于 dsh stop 命令不可用时的降级方案）
 * @param {number} [port=3080] - 目标端口
 * @returns {Promise<{success: boolean, pid: number|null, message: string}>}
 */
export async function stopProcessByPort(port = DSH_WEB_PORT) {
  const info = await getDSHProcessInfo(port);
  if (!info.portInUse || !info.pid) {
    return { success: true, pid: null, message: `端口 ${port} 无占用进程` };
  }

  try {
    if (process.platform === 'win32') {
      await execa('taskkill', ['/PID', String(info.pid), '/F', '/T'], { timeout: 10_000, reject: false , windowsHide: true});
    } else {
      await execa('kill', [String(info.pid)], { timeout: 10_000, reject: false , windowsHide: true});
    }
    return { success: true, pid: info.pid, message: `已结束进程 PID ${info.pid}（${info.command || ''}）` };
  } catch (error) {
    return { success: false, pid: info.pid, message: `结束进程失败: ${error.message}` };
  }
}