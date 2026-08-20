/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */
'use strict';
/**
 * Project-script runner that survives UNC / wrong-CWD situations.
 *
 * npm on Windows executes lifecycle scripts through cmd.exe; when the project
 * lives on a UNC share (\host\share\...), cmd.exe cannot use it as the current
 * working directory and silently falls back to C:\Windows.  Any relative path in
 * "scripts" then breaks.  npm DOES still set npm_package_json / INIT_CWD to the
 * real location, so we locate the project root from those instead of cwd.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.dirname(
  process.env.npm_package_json
    || (process.env.INIT_CWD ? path.join(process.env.INIT_CWD, 'package.json') : './package.json')
    || process.cwd()
);

function resolve(rel) {
  return path.resolve(root, rel || '.');
}

function exists(rel) {
  return fs.existsSync(resolve(rel));
}

/**
 * Run a project Node.js script by relative path (e.g. 'scripts/verify.mjs').
 * @returns {number} child exit code (null -> 1)
 */
function runNode(relScript, args = []) {
  const target = resolve(relScript);
  if (!fs.existsSync(target)) {
    console.error('[run-helper] script not found:', target);
    return 1;
  }
  const r = spawnSync(process.execPath, [target, ...args], { cwd: root, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

/**
 * Run an arbitrary command with the project root as cwd.
 * cmd resolved via PATH; set shell:true for .cmd/.bat shims.
 * @returns {number} child exit code (null -> 1)
 */
function runInRoot(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false, ...opts });
  return r.status === null ? 1 : r.status;
}

module.exports = { root, resolve, exists, runNode, runInRoot };
