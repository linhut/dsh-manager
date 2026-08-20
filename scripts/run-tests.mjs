/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Self-locating test runner.
//
// Background: npm on Windows executes lifecycle scripts through cmd.exe.  When
// the project lives on a UNC share (\host\share\...), cmd.exe cannot use it as
// the current directory and silently falls back to C:\Windows, so relative
// paths in "scripts" break.  We locate the project root from this file instead
// of process.cwd().
//
// Additionally, `node --test` on Windows cannot resolve *absolute* UNC paths,
// so we enumerate the test files and pass them as *relative* paths while
// pinning the child's cwd to the project root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const testDir = 'tests';

if (!existsSync(join(root, testDir))) {
  console.error('Test directory not found:', join(root, testDir));
  process.exit(1);
}

const files = readdirSync(join(root, testDir))
  .filter(f => /\.test\.(mjs|js|cjs)$/.test(f))
  .sort()
  .map(f => relative(root, join(testDir, f)));

if (files.length === 0) {
  console.error('No test files found in', join(root, testDir));
  process.exit(1);
}

console.log('Running', files.length, 'test file(s):', files.join(', '));
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
