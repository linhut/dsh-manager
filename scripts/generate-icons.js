/**
 * 图标生成脚本
 * 将 SVG 图标转换为 PNG 格式（供 electron-builder 使用）
 * 需要 sharp 包：npm install sharp
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

async function generateIcons() {
  console.log('🎨 Generating DSH Manager icons...');

  const svgPath = join(root, 'build', 'icon.svg');
  const outputPng = join(root, 'build', 'icon.png');

  if (!existsSync(svgPath)) {
    console.error('❌ SVG icon not found:', svgPath);
    process.exit(1);
  }

  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('❌ sharp package not installed. Run: npm install sharp');
    process.exit(1);
  }

  const svgBuffer = readFileSync(svgPath);

  // Generate 512x512 PNG (electron-builder will auto-convert to .ico and .icns)
  console.log('  📄 Generating icon.png (512x512)...');
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(outputPng);

  // Also generate 256x256 for .ico source
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(join(root, 'build', 'icon-256.png'));

  console.log('  ✅ Icons generated successfully!');
  console.log(`     - ${outputPng}`);
}

generateIcons().catch(err => {
  console.error('❌ Icon generation failed:', err.message);
  process.exit(1);
});