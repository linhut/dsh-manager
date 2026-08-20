/**
 * DSH Manager - Debug Log System
 */
'use strict';

const debugLog = {
  enabled: false, logs: [], MAX_QUEUE: 500,
  init() {
    this.enabled = true;
    const self = this;
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;
    console.log = function(...args) { self._log('info', args); origLog.apply(console, args); };
    console.info = function(...args) { self._log('info', args); origInfo.apply(console, args); };
    console.warn = function(...args) { self._log('warn', args); origWarn.apply(console, args); };
    console.error = function(...args) { self._log('error', args); origError.apply(console, args); };
    window.addEventListener('error', (event) => { self._log('error', [event.error?.stack || event.error?.message || event.message || '未知错误']); });
    window.addEventListener('unhandledrejection', (event) => { self._log('error', [event.reason?.stack || event.reason?.message || String(event.reason)]); });
    this.log('info', '调试日志系统已初始化');
    this.log('info', 'URL: ' + window.location.href);
  },
  _log(level, args) {
    const msg = args.map(a => typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a)).join(' ');
    this.logs.push({ level, message: msg, time: new Date().toISOString() });
    if (this.logs.length > this.MAX_QUEUE) this.logs.splice(0, this.logs.length - this.MAX_QUEUE);
    if (window.dshManager) { window.dshManager.writeDebugLog(level, msg).catch(() => {}); }
  },
  log(level, message) { this._log(level, [message]); },
  getLogs() { return this.logs.map(l => '[' + l.time + '] [' + l.level.toUpperCase() + '] ' + l.message).join('\n'); },
  clearLogs() { this.logs = []; return '日志已清除'; }
};
try { debugLog.init(); } catch (e) { try { console.error('调试日志初始化失败:', e); } catch {} }
