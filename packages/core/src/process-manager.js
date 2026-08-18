/**
 * @dsh-manager/core - 服务/进程管理
 * 
 * 检测 DSH Web 服务端口占用与进程信息，辅助排查"已安装但连不上"类问题。
 */

import { execa } from 'execa';

/** DSH Web 默认端口 */
export const DSH_WEB_PORT = 3080;

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
      const { stdout } = await execa('netstat', ['-ano'], { timeout: 10_000, reject: false });
      const lines = stdout.split(/\r?\n/).filter(l => {
        // 匹配 LISTENING 状态的本地端口
        return l.includes(`:${port}`) && l.trim().toUpperCase().includes('LISTENING');
      });
      if (lines.length > 0) {
        const pidMatch = lines[0].trim().split(/\s+/).pop();
        const pid = pidMatch && /^\d+$/.test(pidMatch) ? Number(pidMatch) : null;
        base.portInUse = true;
        base.pid = pid;
        // tasklist 取进程名
        if (pid) {
          const { stdout: tl } = await execa('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10_000, reject: false });
          const m = tl.match(/"([^"]+)"/);
          if (m) base.command = m[1];
        }
      }
    } else {
      // 非 Windows：优先 lsof，缺失则静默降级为未占用
      try {
        const { stdout } = await execa('lsof', ['-i', `:${port}`], { timeout: 10_000, reject: false });
        const line = stdout.split(/\r?\n/).find(l => l.includes('LISTEN'));
        if (line) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
          base.portInUse = true;
          base.pid = pid;
          base.command = parts[0] || null;
        }
      } catch {}
    }
  } catch {
    // 任何探测失败均视为空闲，不阻断
  }

  return base;
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
      await execa('taskkill', ['/PID', String(info.pid), '/F', '/T'], { timeout: 10_000, reject: false });
    } else {
      await execa('kill', [String(info.pid)], { timeout: 10_000, reject: false });
    }
    return { success: true, pid: info.pid, message: `已结束进程 PID ${info.pid}（${info.command || ''}）` };
  } catch (error) {
    return { success: false, pid: info.pid, message: `结束进程失败: ${error.message}` };
  }
}
