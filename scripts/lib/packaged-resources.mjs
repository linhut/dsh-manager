#!/usr/bin/env node
/**
 * 打包资源完整性校验的共享逻辑（供 scripts/assert-bundled-resources.mjs 与 scripts/verify.mjs 复用）
 *
 * 背景：dsh-skills 已改为「安装/首启时在线 git clone 拉取」（不随包嵌入），
 * extraResources 当前仅携带 packages/plugins。本逻辑动态读取 package.json 的
 * build.extraResources 生成检查项，并对旧构建残留的 resources/dsh-skills 做提示。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 读取 package.json 的 build.extraResources 声明（容错：字符串写法与对象写法都支持） */
export function readExtraResources(projectRoot) {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  const list = Array.isArray(pkg.build?.extraResources) ? pkg.build.extraResources : [];
  return list
    .map((item) => (typeof item === 'string' ? { from: item, to: item } : { from: item?.from, to: item?.to ?? item?.from }))
    .filter((e) => !!e.from);
}

/** 定位 dist 下已解包的产物资源目录（win-unpacked / linux-unpacked / *.app/Contents/Resources）
 * @param {string} projectRoot
 * @param {string} [distName='dist'] - 产物输出目录名（默认 dist；CI 试构建可传 dist-check 等）
 */
export function findPackagedResourceDirs(projectRoot, distName = 'dist') {
  const distDir = join(projectRoot, distName);
  const dirs = [];
  if (!existsSync(distDir)) return dirs;
  let entries = [];
  try { entries = readdirSync(distDir); } catch { return dirs; }
  for (const name of entries) {
    const p = join(distDir, name);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    if (!/^(win|linux|mac|mas)/i.test(name)) continue;
    if (existsSync(join(p, 'resources'))) dirs.push(join(p, 'resources'));
    if (/^(mac|mas)/i.test(name)) {
      for (const child of readdirSync(p)) {
        if (child.endsWith('.app')) {
          const res = join(p, child, 'Contents', 'Resources');
          if (existsSync(res)) dirs.push(res);
        }
      }
    }
  }
  return dirs;
}

/** 统计目录下的子目录数量（不存在返回 -1） */
export function countSubDirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch { return -1; }
}

/**
 * 汇总 extraResources 完整性检查项
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {boolean} [options.source=true] - 是否检查源码侧目录存在
 * @param {boolean} [options.packaged=true] - 是否检查 dist 产物侧资源存在
 * @param {string} [options.distName='dist'] - 产物输出目录名
 * @returns {{passes: string[], failures: string[], packagedDirs: string[], notes: string[]}}
 */
export function collectExtraResourceChecks(projectRoot, options = {}) {
  const { source = true, packaged = true, distName = 'dist' } = options;
  const passes = [];
  const failures = [];
  const notes = [];
  const extraResources = readExtraResources(projectRoot);

  if (extraResources.length === 0) {
    notes.push('package.json 未声明 build.extraResources');
    return { passes, failures, packagedDirs: [], notes };
  }

  if (source) {
    for (const { from } of extraResources) {
      const srcAbs = join(projectRoot, from);
      if (existsSync(srcAbs)) passes.push(`extraResources 源目录存在: ${from}`);
      else failures.push(`extraResources 源目录缺失: ${from}（${srcAbs}）`);
    }
    // dsh-skills 专项：skills 子目录必须非空（子模块已真正拉取）
    const skillsSrcCount = countSubDirs(join(projectRoot, 'dsh-skills', 'skills'));
    if (skillsSrcCount > 0) passes.push(`源码 dsh-skills/skills 非空（${skillsSrcCount} 个技能目录）`);
    else failures.push('源码 dsh-skills/skills 缺失或为空（git 子模块可能未拉取，需 git submodule update --init --recursive）');
  }

  const packagedDirs = packaged ? findPackagedResourceDirs(projectRoot, distName) : [];
  if (packaged) {
    if (packagedDirs.length === 0) {
      notes.push(`${distName} 下未发现已解包产物（win-unpacked / linux-unpacked / *.app），跳过产物侧检查`);
    } else {
      for (const resDir of packagedDirs) {
        const label = resDir.replace(projectRoot + '\\', '').replace(projectRoot + '/', '');
        for (const { to } of extraResources) {
          const target = join(resDir, to);
          if (existsSync(target)) passes.push(`[${label}] resources/${to} 存在`);
          else failures.push(`[${label}] resources/${to} 缺失（${target}）`);
        }
        // dsh-skills 已改为「安装时在线拉取」：不应再随包嵌入。
        // 旧构建残留的 resources/dsh-skills 仅提示不阻断（避免历史 dist 导致误报）。
        const legacySkillsDir = join(resDir, 'dsh-skills');
        if (!existsSync(legacySkillsDir)) {
          passes.push(`[${label}] resources 不包含 dsh-skills（已改安装时在线拉取）`);
        } else {
          notes.push(`[${label}] 发现旧构建残留 resources/dsh-skills（新版本已改在线安装，可清理后重建）`);
        }
      }
    }
  }

  return { passes, failures, packagedDirs, notes };
}
