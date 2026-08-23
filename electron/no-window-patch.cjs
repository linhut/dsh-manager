/**
 * DSH Manager - 无窗口子进程补丁
 * 通过 --require 注入，强制所有 child_process.spawn/exec 调用使用 windowsHide: true
 * 解决 DSH web 内部 Agent bash 调用弹窗问题
 * 不修改 DSH 包文件，升级不丢失
 */
'use strict';

const cp = require('child_process');

// 备份原始方法
const origSpawn = cp.spawn;
const origSpawnSync = cp.spawnSync;
const origExec = cp.exec;
const origExecSync = cp.execSync;
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;

/**
 * 对 options 对象强制设置 windowsHide: true（Windows 平台）
 * 注意：如果 options.shell 或 options.stdio 显式指定了窗口，可能仍会弹窗
 */
function forceNoWindow(options) {
  if (process.platform !== 'win32') return options;
  if (options && typeof options === 'object') {
    // 如果用户显式设置 windowsHide: false，尊重并覆盖（我们不希望任何弹窗）
    options.windowsHide = true;
  }
  return options;
}

// 处理 spawn 的多重签名：spawn(cmd, args?, options?) 或 spawn(cmd, options?)
cp.spawn = function(cmd, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    // spawn(cmd, options)
    return origSpawn.call(this, cmd, forceNoWindow(args));
  }
  // spawn(cmd, args, options)
  return origSpawn.call(this, cmd, args, forceNoWindow(options));
};

cp.spawnSync = function(cmd, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return origSpawnSync.call(this, cmd, forceNoWindow(args));
  }
  return origSpawnSync.call(this, cmd, args, forceNoWindow(options));
};

// exec 和 execFile 的 options 在第二个参数（如果提供）
cp.exec = function(cmd, options, callback) {
  if (typeof options === 'function' || options === undefined) {
    return origExec.call(this, cmd, options, callback);
  }
  return origExec.call(this, cmd, forceNoWindow(options), callback);
};

cp.execSync = function(cmd, options) {
  return origExecSync.call(this, cmd, forceNoWindow(options));
};

cp.execFile = function(file, args, options, callback) {
  if (typeof args === 'function') {
    return origExecFile.call(this, file, args, options);
  }
  if (typeof options === 'function') {
    return origExecFile.call(this, file, args, forceNoWindow(options), callback);
  }
  return origExecFile.call(this, file, args, forceNoWindow(options), callback);
};

cp.execFileSync = function(file, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return origExecFileSync.call(this, file, forceNoWindow(args));
  }
  return origExecFileSync.call(this, file, args, forceNoWindow(options));
};

// 同样处理 fork
const origFork = cp.fork;
cp.fork = function(modulePath, args, options) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return origFork.call(this, modulePath, args);
  }
  return origFork.call(this, modulePath, args, forceNoWindow(options));
};

// 输出确认（仅在调试模式）
if (process.env.DSH_DEBUG) {
  try {
    const { writeFileSync, appendFileSync, existsSync, mkdirSync } = require('fs');
    const { join } = require('path');
    const debugLog = join(process.env.DSH_HOME || require('os').homedir() + '/.dsh', 'manager', 'no-window-patch.log');
    const dir = require('path').dirname(debugLog);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(debugLog, '[' + new Date().toISOString() + '] [INFO] no-window-patch.cjs 已加载, 进程: ' + process.pid + '\n');
  } catch (e) {
    console.error('no-window-patch init error:', e.message);
  }
}
