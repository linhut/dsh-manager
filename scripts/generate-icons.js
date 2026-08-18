/**
 * 图标生成脚本
 * 将 logo/ 目录下的官方 logo 文件复制到 build/ 目录（供 electron-builder 使用）
 * 用户提供各尺寸 PNG 与 ICO，直接复制，无需 sharp 依赖
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const logoDir = join(root, 'logo');
const buildDir = join(root, 'build');

/** 源文件 → 目标文件映射 */
const ICON_MAP = [
  ['dsh-manager-whale_v01-512.png', 'icon.png'],
  ['dsh-manager-whale_v01-256.png', 'icon-256.png'],
  ['dsh-manager-whale_v01.ico', 'icon.ico'],
];

function generateIcons() {
  console.log('🎨 Generating DSH Manager icons...');

  if (!existsSync(logoDir)) {
    console.error('❌ Logo directory not found:', logoDir);
    process.exit(1);
  }

  mkdirSync(buildDir, { recursive: true });

  for (const [src, dest] of ICON_MAP) {
    const srcPath = join(logoDir, src);
    const destPath = join(buildDir, dest);
    if (!existsSync(srcPath)) {
      console.error(`❌ Logo source not found: ${srcPath}`);
      process.exit(1);
    }
    copyFileSync(srcPath, destPath);
    console.log(`  📄 ${dest} ← ${src}`);
  }

  console.log('  ✅ Icons generated successfully!');
}

generateIcons();
