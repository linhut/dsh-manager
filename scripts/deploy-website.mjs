/**
 * DSH Manager 官网部署脚本：把 website/（纯静态站）同步到云服务器。
 *
 * 服务器仅托管官网页面，不存储安装包：
 * 下载与自动更新保持 GitHub Releases（linhut/dsh-manager），见 docs/website-deploy.md。
 *
 * 用法：
 *   node scripts/deploy-website.mjs --host user@1.2.3.4 --path /var/www/dsh-manager/website [--rsync] [--dry-run]
 *
 * 环境变量（免输参数）：DSH_DEPLOY_HOST、DSH_DEPLOY_PATH
 *  - 默认使用 scp（Windows Git Bash / OpenSSH 自带，全量覆盖）
 *  - --rsync 使用 rsync 增量同步（Linux / macOS 或已装 rsync 的环境，支持 --delete 与排除 Thumbs.db）
 *  - --dry-run 仅打印将执行的命令，不真正同步
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(__dirname, '..', 'website').replace(/\\/g, '/');

/** 解析命令行参数：--host x --path y [--rsync] [--dry-run] */
function parseArgs(argv) {
  const args = { host: null, path: null, rsync: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') args.host = argv[++i];
    else if (arg === '--path') args.path = argv[++i];
    else if (arg === '--rsync') args.rsync = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function printUsage() {
  console.log('用法: node scripts/deploy-website.mjs --host user@1.2.3.4 --path /var/www/dsh-manager/website [--rsync] [--dry-run]');
  console.log('环境变量: DSH_DEPLOY_HOST / DSH_DEPLOY_PATH 可免输 --host / --path');
}

const args = parseArgs(process.argv.slice(2));
const host = args.host || process.env.DSH_DEPLOY_HOST;
const target = args.path || process.env.DSH_DEPLOY_PATH;

if (!host || !target) {
  printUsage();
  process.exit(1);
}

// Git Bash（MSYS）路径还原：
//  1. bash 传参时把 /var/www/... 转换成了 C:/Program Files/Git/var/www/...  → 还原为 /var/www/...
//  2. 双斜杠约定 //var/www 不会被转换，但 dest 里会多出 // → 折叠为 /
let dest = `${host}:${target}`
  .replace(/\\/g, '/')
  .replace(/:[A-Za-z]:\/[^:]*Program Files\/Git\//, ':/')
  .replace(/:\/+/, ':/');

// 同步命令选择：rsync 增量 vs scp 全量
const cmd = args.rsync
  ? ['rsync', ['-avz', '--delete', '--exclude', 'Thumbs.db', `${SITE}/`, dest]]
  : ['scp', ['-r', `${SITE}/.`, dest]];

if (args.dryRun) {
  console.log(`[dry-run] 将执行: ${cmd[0]} ${cmd[1].join(' ')}`);
  process.exit(0);
}

try {
  execFileSync(cmd[0], cmd[1], {
    stdio: 'inherit',
    // Git Bash（MSYS）下禁用路径转换，避免远程路径 /var/www/... 被改写为 Windows 路径
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
} catch (error) {
  console.error(`同步失败（${cmd[0]}）: ${error.message}`);
  console.error('提示: 默认 scp 需本地有 OpenSSH；--rsync 需服务器与本地均安装 rsync');
  process.exit(1);
}

console.log(`✅ 官网已同步: ${SITE}/ → ${dest}`);
console.log('验证: curl -I https://你的域名/   （详见 docs/website-deploy.md 第六节）');
