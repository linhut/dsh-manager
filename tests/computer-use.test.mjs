/**
 * 电脑控制（Computer Use）能力管理测试
 *
 * 覆盖：
 *   - 状态推导：not-installed / disabled / enabled / partial（patch 挂载 + node_modules 真值）
 *   - 一键安装：pin 版本 add 两包、cordis.patch.yml 挂载块、allowBuilds 拦截重试、未落盘断言失败
 *   - 启用/禁用：追加/移除 patch 挂载块，幂等
 *   - 旧现场迁移：bundles 残留自动清理（会导致 DSH 启动崩溃）
 *   - 卸载：官方 remove 成功清挂载；remove 失败降级清单清理（dependencies）
 *   - 版本 pin 不一致 → outdated 警告
 * 不依赖真实 pnpm/dsh：注入 fake exec + dshCommand + skipPnpmCheck。
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PKGS = {
  service: '@deepseek-ai/dsh-computer-use',
  provider: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
};
const TAG = '0.1.6-alpha.1';
const PATCH_BEGIN = '# >>> dsh-manager computer-use (managed block, do not edit) >>>';
const PATCH_END = '# <<< dsh-manager computer-use <<<';

/** 构造临时 DSH_HOME 并清理 */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshm-cu-')).replace(/\\/g, '/');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(home, '.dsh');
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function profileDir() { return join(process.env.DSH_HOME, 'profiles', 'web'); }

function writeManifest(manifest) {
  mkdirSync(profileDir(), { recursive: true });
  writeFileSync(join(profileDir(), 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

function readManifest() {
  return JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf-8'));
}

/** 读取 profile 的 cordis.patch.yml 文本（不存在返回 ''） */
function readPatchFile() {
  const p = join(profileDir(), 'cordis.patch.yml');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

/** 模拟 pnpm 安装落盘：在 profile node_modules 写入包版本 */
function writeInstalledPkg(pkg, version = TAG) {
  const dir = join(profileDir(), 'node_modules', ...pkg.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf-8');
}

/** 构造记录调用并可编程返回的 fake exec */
function makeFakeExec(handler) {
  const calls = [];
  const fake = async (cmd, args) => {
    const idx = calls.length;
    calls.push({ cmd, args });
    const result = handler ? await handler(cmd, args, idx) : { failed: false, exitCode: 0, stdout: '', stderr: '' };
    return result;
  };
  fake.calls = calls;
  return fake;
}

const okResult = { failed: false, exitCode: 0, stdout: 'ok', stderr: '' };
const failResult = (stderr = 'install failed') => ({ failed: true, exitCode: 1, stdout: '', stderr });

describe('电脑控制（Computer Use）', () => {
  it('未安装时 getComputerUseState 返回 not-installed', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      const state = mod.getComputerUseState('web');
      assert.equal(state.status, 'not-installed');
      assert.equal(state.installed, false);
      assert.equal(state.enabled, false);
      assert.equal(state.provider, 'cua-driver-native');
      assert.equal(state.tag, TAG);
      assert.equal(state.packages.length, 2);
      assert.ok(state.packages.every(p => !p.installed && !p.inBundles));
    });
  });

  it('状态推导：全装未挂载 → disabled；全装已挂载 → enabled；半装 → partial', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      writeManifest({ name: 'dsh-profile', dsh: { profile: { bundles: [] } } });
      writeInstalledPkg(PKGS.service);
      writeInstalledPkg(PKGS.provider);
      assert.equal(mod.getComputerUseState('web').status, 'disabled');
      // 启用挂载（写 patch 块）
      mod.setComputerUseEnabled('web', true);
      assert.equal(mod.getComputerUseState('web').status, 'enabled');
      assert.equal(mod.getComputerUseState('web').enabled, true);
      // 半装：卸载 provider 的 node_modules（模拟部分失败）
      rmSync(join(profileDir(), 'node_modules', '@deepseek-ai', 'dsh-experimental-computer-use-cua-driver-native'), { recursive: true, force: true });
      const state = mod.getComputerUseState('web');
      assert.equal(state.status, 'partial');
      assert.ok(state.warning && state.warning.includes('不完整'));
    });
  });

  it('磁盘版本与 pin 不一致 → outdated 警告', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      writeInstalledPkg(PKGS.service, '0.1.5-alpha.0');
      writeInstalledPkg(PKGS.provider, TAG);
      const state = mod.getComputerUseState('web');
      assert.equal(state.status, 'disabled');
      const stale = state.packages.find(p => p.name === PKGS.service);
      assert.equal(stale.outdated, true);
      assert.ok(state.warning && state.warning.includes('0.1.5-alpha.0'));
    });
  });

  it('setComputerUseEnabled 启用/禁用追加/移除 patch 挂载块（幂等）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      writeManifest({ name: 'dsh-profile', dependencies: {}, dsh: { profile: { bundles: ['some-other-bundle'] } } });
      // 启用
      let r = mod.setComputerUseEnabled('web', true);
      assert.equal(r.success, true);
      assert.equal(r.method, 'patch-added');
      let patch = readPatchFile();
      assert.ok(patch.includes(PATCH_BEGIN) && patch.includes(PATCH_END), '应写入管理块标记');
      assert.ok(patch.includes(PKGS.service) && patch.includes(PKGS.provider), '挂载块应含两包 name');
      // 不得误伤其他 bundle（cleanLegacyBundles 只清 computer-use 两包）
      let manifest = readManifest();
      assert.ok(manifest.dsh.profile.bundles.includes('some-other-bundle'));
      // 重复启用 → no-change
      r = mod.setComputerUseEnabled('web', true);
      assert.equal(r.method, 'no-change');
      // 禁用 → 移除挂载块
      r = mod.setComputerUseEnabled('web', false);
      assert.equal(r.method, 'patch-removed');
      patch = readPatchFile();
      assert.ok(!patch.includes(PATCH_BEGIN), '禁用后管理块应移除');
      assert.ok(!patch.includes(PKGS.service));
      // 非法 profile 名
      r = mod.setComputerUseEnabled('../../bad', true);
      assert.equal(r.success, false);
    });
  });

  it('旧现场迁移：bundles 残留两包 → getComputerUseState 自动清理（防 DSH 启动崩溃）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      // 模拟旧版错误现场：bundles 登记 computer-use 两包，patch 无挂载
      writeManifest({ name: 'dsh-profile', dsh: { profile: { bundles: [PKGS.service, PKGS.provider, 'some-other-bundle'] } } });
      writeInstalledPkg(PKGS.service);
      writeInstalledPkg(PKGS.provider);
      const state = mod.getComputerUseState('web');
      assert.ok(state.warning && state.warning.includes('旧版 bundles 登记残留'), '应提示迁移完成');
      const manifest = readManifest();
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.service), 'bundles 残留应被清理');
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.provider));
      assert.ok(manifest.dsh.profile.bundles.includes('some-other-bundle'), '不得误伤其他 bundle');
      assert.equal(state.status, 'disabled');
    });
  });

  it('一键安装：pin 版本 add 两包 + patch 挂载块 + 真值断言', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      // 真实环境 profile 必然已有清单（该 profile 本身存在）
      writeManifest({ name: 'dsh-profile', dsh: { profile: { bundles: [] } } });
      const exec = makeFakeExec(async (cmd, args) => {
        // 模拟 pnpm/dsh 安装成功：先落盘再返回成功
        const addIdx = args.indexOf('add');
        if (addIdx !== -1) {
          const spec = args[addIdx + 1];
          writeInstalledPkg(spec === PKGS.service + '@' + TAG ? PKGS.service : PKGS.provider);
        }
        return okResult;
      });
      const progress = [];
      const r = await mod.installComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true, onProgress: (stage, pkg) => progress.push(stage + ':' + pkg) });
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.installed, true);
      assert.equal(r.enabled, true);
      assert.equal(r.method, 'dsh-plugin-add');
      // 两次 add，均为 pin 版本
      const adds = exec.calls.filter(c => c.args.includes('add'));
      assert.equal(adds.length, 2);
      for (const c of adds) {
        assert.equal(c.args[0], 'plugin');
        assert.equal(c.args[1], '--profile');
        assert.equal(c.args[2], 'web');
        assert.ok(c.args[4] === PKGS.service + '@' + TAG || c.args[4] === PKGS.provider + '@' + TAG, '应 pin 版本：' + c.args[4]);
      }
      // 已挂载：patch 文件含两包管理块；bundles 不含两包（官方挂载方式，非 bundles 登记）
      assert.equal(mod.isComputerUseMounted('web'), true, '应挂载到 cordis.patch.yml');
      const patch = readPatchFile();
      assert.ok(patch.includes(PKGS.service) && patch.includes(PKGS.provider));
      const manifest = readManifest();
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.service));
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.provider));
      // 进度回调触发
      assert.ok(progress.some(p => p.startsWith('install:')));
      assert.ok(progress.some(p => p.startsWith('verify:')));
      // 幂等：再装一次成功且不新增异常
      const r2 = await mod.installComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      assert.equal(r2.success, true);
    });
  });

  it('allowBuilds 拦截：写入 pnpm-workspace.yaml 白名单后重试成功', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      writeManifest({ name: 'dsh-profile', dsh: { profile: { bundles: [] } } });
      let attempts = 0;
      const exec = makeFakeExec(async (cmd, args) => {
        attempts += 1;
        const addIdx = args.indexOf('add');
        if (addIdx !== -1) {
          if (attempts === 1) {
            // pnpm 11+ 供应链安全拦截（@trycua/cua-driver postinstall）
            return failResult('Cannot install with "build": true option. The package "@trycua/cua-driver" needs to execute build scripts and is not in the "allowBuilds" allowlist');
          }
          const spec = args[addIdx + 1];
          writeInstalledPkg(spec === PKGS.service + '@' + TAG ? PKGS.service : PKGS.provider);
        }
        return okResult;
      });
      const r = await mod.installComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      assert.equal(r.success, true, JSON.stringify(r));
      // 白名单已写入 profile/pnpm-workspace.yaml
      const yamlPath = join(profileDir(), 'pnpm-workspace.yaml');
      const yaml = readFileSync(yamlPath, 'utf-8');
      assert.ok(yaml.includes('allowBuilds:'), '应写入 allowBuilds 段');
      assert.ok(yaml.includes('@trycua/cua-driver'), '白名单应含被拦截的包');
      // 第二次 add 是重试
      assert.ok(attempts >= 3, 'service+provider 各需 1 次失败 + 1 次重试');
    });
  });

  it('安装后组件未落盘 → verify-failed（不信任退出码）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      const exec = makeFakeExec(() => okResult); // 返回成功但不落盘
      const r = await mod.installComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      assert.equal(r.success, false);
      assert.equal(r.method, 'verify-failed');
      assert.ok(r.error.includes('未落盘'));
    });
  });

  it('非法 profile 名直接失败，不调用 dsh', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      let called = false;
      const exec = makeFakeExec(async () => { called = true; return okResult; });
      const r = await mod.installComputerUse('../evil', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      assert.equal(r.success, false);
      assert.equal(called, false);
      assert.ok(r.error.includes('非法的 profile'));
    });
  });

  it('卸载：官方 remove 两包 + 移除 patch 挂载 + 清理 bundles 残留', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      // 旧现场：bundles 残留两包 + patch 已挂载
      writeManifest({ name: 'dsh-profile', dependencies: { [PKGS.service]: TAG, [PKGS.provider]: TAG }, dsh: { profile: { bundles: [PKGS.service, PKGS.provider] } } });
      writeInstalledPkg(PKGS.service);
      writeInstalledPkg(PKGS.provider);
      mod.setComputerUseEnabled('web', true);
      assert.equal(readPatchFile().includes(PATCH_BEGIN), true, '前置：应已挂载');
      const exec = makeFakeExec(async (cmd, args) => {
        // 模拟 remove 成功后清理 node_modules
        const idx = args.indexOf('remove');
        if (idx !== -1) {
          const pkg = args[idx + 1];
          rmSync(join(profileDir(), 'node_modules', ...pkg.split('/')), { recursive: true, force: true });
        }
        return okResult;
      });
      const r = await mod.uninstallComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      assert.equal(r.success, true);
      assert.equal(r.method, 'dsh-plugin-remove');
      assert.equal(r.removed.length, 2);
      // 挂载块移除
      const patch = readPatchFile();
      assert.ok(!patch.includes(PATCH_BEGIN), '卸载后挂载块应移除');
      assert.ok(!patch.includes(PKGS.service));
      // bundles 残留清理
      const manifest = readManifest();
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.service));
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.provider));
      assert.equal(mod.getComputerUseState('web').status, 'not-installed');
    });
  });

  it('卸载降级：remove 失败 → 清单清理（bundles + dependencies）', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      writeManifest({ name: 'dsh-profile', dependencies: { [PKGS.service]: TAG, [PKGS.provider]: TAG }, dsh: { profile: { bundles: [PKGS.service, PKGS.provider] } } });
      writeInstalledPkg(PKGS.service);
      writeInstalledPkg(PKGS.provider);
      const exec = makeFakeExec(() => failResult('dsh plugin remove 失败'));
      const r = await mod.uninstallComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      // remove 全失败 → 降级清单清理后仍视为已移除
      assert.equal(r.success, true);
      assert.equal(r.method, 'mixed');
      const manifest = readManifest();
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.service));
      assert.ok(!manifest.dsh.profile.bundles.includes(PKGS.provider));
      const deps = manifest.dependencies || {};
      assert.ok(!deps[PKGS.service], '降级应清理 dependencies');
      assert.ok(!deps[PKGS.provider]);
      assert.ok(r.error && r.error.includes('降级'));
    });
  });

  it('安装失败：dsh 返回失败且无 allowBuilds key → install-failed', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/computer-use.js');
      const exec = makeFakeExec(() => failResult('pnpm error: something else broke'));
      const r = await mod.installComputerUse('web', { exec, dshCommand: 'dsh', skipPnpmCheck: true });
      assert.equal(r.success, false);
      assert.equal(r.method, 'install-failed');
      assert.ok(r.error.includes('安装'));
    });
  });
});
