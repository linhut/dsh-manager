/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * 
 * 调试日志模块 - 写入和管理调试日志文件，用于排查打包后无法看到控制台输出的问题。
 * 日志文件位置: ~/.dsh/manager/debug.log
 * 启用方式: 设置环境变量 DSH_DEBUG=true 或启动参数 --debug
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, rmSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const LOG_FILE = () => join(DSH_HOME(), 'manager', 'debug.log');
const MAX_LOG_SIZE = 1024 * 1024; // 1MB 轮转

/** 是否启用调试日志 */
let enabled = true;

/**
 * 初始化调试日志
 * @param {boolean} force - 强制启用（忽略环境变量）
 */
export function initDebugLog(force = false) {
  enabled = force;
  if (!enabled) return;

  // 确保目录存在
  const dir = join(DSH_HOME(), 'manager');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 检查日志文件大小，超过 1MB 轮转
  try {
    if (existsSync(LOG_FILE())) {
      const stat = statSync(LOG_FILE());
      if (stat.size > MAX_LOG_SIZE) {
        const old = LOG_FILE() + '.1';
        if (existsSync(old)) rmSync(old);
        renameSync(LOG_FILE(), old);
      }
    }
  } catch {}

  writeLog('debug', '========================================');
  writeLog('debug', 'DSH Manager 调试日志启动');
  writeLog('debug', '时间: ' + new Date().toISOString());
  writeLog('debug', '平台: ' + process.platform + ' ' + process.arch);
  writeLog('debug', 'Node: ' + process.version);
  writeLog('debug', '========================================');

  // 拦截全局未捕获异常
  process.on('uncaughtException', (err) => {
    writeLog('error', '未捕获异常: ' + (err?.stack || err?.message || String(err)));
  });
  process.on('unhandledRejection', (err) => {
    writeLog('error', '未处理 Promise 拒绝: ' + (err?.stack || err?.message || String(err)));
  });
}

/**
 * 写入日志
 * @param {string} level - 'debug' | 'info' | 'warn' | 'error'
 * @param {string} message
 */
export function writeLog(level, message) {
  try {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    appendFileSync(LOG_FILE(), line, 'utf-8');
  } catch {}
}

/**
 * 读取日志内容（最近 200KB）
 * @returns {string}
 */
export function readLog() {
  try {
    if (!existsSync(LOG_FILE())) return '';
    const content = readFileSync(LOG_FILE(), 'utf-8');
    // 只返回最近 200KB
    if (content.length > 200 * 1024) {
      return '... (日志已截断，取最近 200KB) \n\n' + content.slice(-200 * 1024);
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * 获取日志文件路径
 * @returns {string}
 */
export function getLogPath() {
  return LOG_FILE();
}

/**
 * 清除日志
 */
export function clearLog() {
  try {
    writeFileSync(LOG_FILE(), '', 'utf-8');
  } catch {}
}

export function isDebugEnabled() {
  return enabled;
}