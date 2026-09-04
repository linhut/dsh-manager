/**
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * 构建测试版本 DSH Manager
 * 使用 extraMetadata.version 覆盖版本号（不修改磁盘上的 package.json）
 * 产物命名为 DSH-Manager-{version}-test.{buildNum}.exe
 */
const { dirname, join, resolve } = require('node:path');
// 优先使用 npm_package_json（npm 运行时会设置），否则按项目根目录解析
const rootDir = process.env.npm_package_json
  ? dirname(process.env.npm_package_json)
  : resolve(__dirname, '..');
const helper = require(join(rootDir, 'scripts', 'run-helper.cjs'));

const pkg = require('../package.json');
const baseVer = pkg.version;
const buildNum = process.env.DSH_TEST_BUILD || '1';
const testVersion = baseVer + '-test.' + buildNum;

console.log('🔧 构建测试版本: ' + testVersion);
console.log('   基础版本: ' + baseVer);

const exitCode = helper.runNode(
  join(rootDir, 'node_modules/electron-builder/cli.js'),
  ['--win', '--config.extraMetadata.version=' + testVersion]
);

if (exitCode === 0) {
  console.log('');
  console.log('✅ 测试构建完成');
  console.log('   产物: dist/DSH-Manager-' + testVersion + '-x64.exe（win x64，artifactName 现含架构后缀）');
  console.log('   注意：此版本仅用于测试，请勿在生产环境使用！');
  process.exit(0);
} else {
  console.log('');
  console.log('❌ 构建失败，退出码: ' + exitCode);
  process.exit(exitCode);
}