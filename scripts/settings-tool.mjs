/**
 * DSH Manager — settings.yaml 备份/还原/校验 CLI 工具
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * 用法：
 *   node scripts/settings-tool.mjs path                显示配置文件路径
 *   node scripts/settings-tool.mjs backup [原因]       创建配置备份
 *   node scripts/settings-tool.mjs list                列出可用备份
 *   node scripts/settings-tool.mjs restore <名称|索引>  从备份还原
 *   node scripts/settings-tool.mjs validate            校验当前配置结构
 *   node scripts/settings-tool.mjs check               深度检查（原始文本 + 结构 + 建议）
 *   node scripts/settings-tool.mjs fix                 自动修复字符串模型项（先备份）
 */

import { existsSync, readFileSync } from 'node:fs';
import { DSHConfig, DSH_PATHS } from '../packages/core/src/index.js';

function log(msg) { console.log(msg); }
function error(msg) { console.error('[错误] ' + msg); }

/** 简单的 YAML 文本扫描：找出疑似「字符串形态模型项」的行（- "id: xxx" / - 'id: xxx'） */
function scanStringModelLines(raw) {
  const issues = [];
  const lines = String(raw).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // 引号包裹的 id 列表项：- "id: xxx" 或 - 'id: xxx'（旧版解析器写出的错误形态）
    if (/^-[ \t]+["'][a-zA-Z0-9_-]+[ \t]*:/.test(trimmed)) {
      issues.push({ line: i + 1, text: trimmed });
    }
  }
  return issues;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = new DSHConfig();
  const settingsPath = cfg.configPath;

  switch (cmd) {
    case 'path': {
      log('配置文件: ' + settingsPath);
      log('凭据文件: ' + cfg.credPath);
      log('存在: ' + (existsSync(settingsPath) ? '是' : '否'));
      break;
    }

    case 'backup': {
      if (!existsSync(settingsPath)) {
        error('配置文件不存在: ' + settingsPath);
        process.exitCode = 1;
        break;
      }
      try {
        const r = await cfg.createBackup(arg || 'manual');
        log('✓ 备份已创建: ' + r.name);
      } catch (e) {
        error('备份失败: ' + e.message);
        process.exitCode = 1;
      }
      break;
    }

    case 'list': {
      try {
        const backups = await cfg.listBackups('settings');
        if (backups.length === 0) {
          log('（暂无备份）');
          break;
        }
        log('共 ' + backups.length + ' 个备份（最新在前）：');
        backups.forEach((b, i) => {
          const d = new Date(b.mtime);
          const pad = (n) => String(n).padStart(2, '0');
          const ts = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
          log('  [' + i + '] ' + b.name + '  (' + ts + ', ' + b.size + ' B)');
        });
        log('提示：restore <索引> 还原（0 = 最新）');
      } catch (e) {
        error('列出备份失败: ' + e.message);
        process.exitCode = 1;
      }
      break;
    }

    case 'restore': {
      if (!arg) {
        error('用法: settings-tool.mjs restore <备份名称|索引>');
        process.exitCode = 1;
        break;
      }
      try {
        const r = await cfg.restoreBackup(arg);
        log('✓ 已从备份还原: ' + r.name);
        log('  配置文件: ' + settingsPath);
      } catch (e) {
        error('还原失败: ' + e.message);
        process.exitCode = 1;
      }
      break;
    }

    case 'validate': {
      try {
        const v = await cfg.checkConfig();
        const content = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : '';
        const scan = scanStringModelLines(content);
        if (v.ok && scan.length === 0) {
          log('✓ 配置结构校验通过');
        } else {
          if (!v.ok) {
            log('✗ 配置结构存在问题：');
            v.errors.forEach((e) => log('  - ' + e));
          }
          if (scan.length > 0) {
            log('⚠ 存在 ' + scan.length + ' 处字符串形态模型项（旧版解析器产物）：');
            scan.forEach((s) => log('  行 ' + s.line + ': ' + s.text));
            log('  建议运行: node scripts/settings-tool.mjs fix');
          }
          process.exitCode = 1;
        }
        break;
      } catch (e) {
        error('校验失败: ' + e.message);
        process.exitCode = 1;
      }
      break;
    }

    case 'check': {
      try {
        const v = await cfg.checkConfig();
        const content = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : '';
        const scan = scanStringModelLines(content);
        log('配置文件: ' + settingsPath + ' (' + (content ? content.length : 0) + ' 字节)');
        log('');
        log('— 结构校验 —');
        if (v.ok) log('  ✓ 通过');
        else { v.errors.forEach((e) => log('  ✗ ' + e)); }
        log('');
        log('— 字符串模型项扫描（- "id: xxx"） —');
        if (scan.length === 0) log('  ✓ 未发现');
        else { scan.forEach((s) => log('  ⚠ 行 ' + s.line + ': ' + s.text)); }
        log('');
        if (!v.ok || scan.length > 0) {
          log('建议：');
          if (scan.length > 0) log('  • 运行 fix 自动修复字符串模型项（会先备份）');
          if (!v.ok) log('  • 用 restore <索引> 还原到最近良好备份，或手动修复 YAML');
        }
        if (!v.ok || scan.length > 0) process.exitCode = 1;
      } catch (e) {
        error('检查失败: ' + e.message);
        process.exitCode = 1;
      }
      break;
    }

    case 'fix': {
      if (!existsSync(settingsPath)) {
        error('配置文件不存在: ' + settingsPath);
        process.exitCode = 1;
        break;
      }
      try {
        const content = readFileSync(settingsPath, 'utf-8');
        const scan = scanStringModelLines(content);
        const v = await cfg.checkConfig();
        if (v.ok && scan.length === 0) {
          log('✓ 配置已正常，无需修复');
          break;
        }
        // 读入 → 规范化 → 写回（write 内部会先备份再校验）
        const { settings } = await cfg.read();
        cfg._normalizeModels(settings);
        const check = cfg.validateSettings(settings);
        if (!check.ok) {
          error('无法自动修复（结构问题需手动处理）：\n' + check.errors.join('\n'));
          process.exitCode = 1;
          break;
        }
        await cfg.write(settings);
        log('✓ 已修复并写回（写入前已自动备份），字符串模型项已转为对象格式');
        if (scan.length > 0) log('  修复 ' + scan.length + ' 处字符串模型项');
      } catch (e) {
        error('修复失败: ' + e.message);
        process.exitCode = 1;
      }
      break;
    }

    default: {
      log('DSH Manager settings.yaml 工具');
      log('');
      log('用法: node scripts/settings-tool.mjs <命令>');
      log('  path            显示配置文件路径');
      log('  backup [原因]   创建配置备份');
      log('  list            列出可用备份');
      log('  restore <n|名>  从备份还原（n = 索引，0 为最新）');
      log('  validate        校验当前配置结构');
      log('  check           深度检查（文本扫描 + 结构 + 建议）');
      log('  fix             自动修复字符串模型项（先备份）');
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  error('未预期错误: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
