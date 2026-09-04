// DSH Manager 安全审计修复回归测试
// 覆盖 v1.3.18 审计修复：路径穿越/zip-slip 防护、zip 解析偏移修正、
// XSS 内插点转义、IPC 白名单、原子写失败保护、事件通道名统一等。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshm-fix-')).replace(/\\/g, '/');
  mkdirSync(join(home, '.dsh'), { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(home, '.dsh');
  try {
    await fn(join(home, '.dsh'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

// ====== 源码检查：修复标记必须常驻（防止回归） ======
describe('安全审计修复：源码检查', () => {
  it('skill-manager zip 总条目数应从 EOCD 偏移 +10 读取', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes('getUint16(offset + 10, true)'), 'EOCD 条目数应从 +10 读取');
    assert.ok(!src.includes('const totalEntries = view.getUint16(offset + 8, true)'), '不应再从中央目录头 +8 读条目数（那是 flags）');
  });

  it('skill-manager 下载失败信息使用 ref 变量而非未定义的 branch', () => {
    const src = read('packages/core/src/skill-manager.js');
    assert.ok(src.includes("' 分支 ' + ref"), '应使用 ref 变量');
    assert.ok(!src.includes("'分支 ' + branch"), '不应引用未定义变量 branch');
  });

  it('marketplace installer 校验 git 仓库名与插件名（防路径穿越删除）', () => {
    const src = read('packages/marketplace/src/installer.js');
    assert.ok(src.includes('非法的 Git 仓库名'), '_installFromGit 应校验 repoName');
    const n = (src.match(/非法的插件名/g) || []).length;
    assert.ok(n >= 2, '_installFromFile 与 _installFromTarball 都应校验 pluginName，实际 ' + n + ' 处');
    assert.ok(src.includes("import { join, basename, resolve, sep }"), '应导入 resolve/sep 支持越界防御');
  });

  it('marketplace installer tarball 解压有 zip-slip 防护', () => {
    const src = read('packages/marketplace/src/installer.js');
    assert.ok(src.includes("['-tzf', tarball]"), '解压前应先用 tar -tzf 列出条目');
    assert.ok(src.includes('非法的插件名'), 'pluginName 需合法包名');
    assert.ok(src.includes('解压目录越界'), 'pkgDir 应有 resolve 前缀越界防御');
  });

  it('mcp-manager 原子写失败时清理 tmp 而非覆盖原配置', () => {
    const src = read('packages/core/src/mcp-manager.js');
    assert.ok(src.includes('rmSync(tmp, { force: true })'), 'writeFileSync 失败应清理 tmp');
    assert.ok(!src.includes('if (existsSync(tmp)) renameSync(tmp, this.patchFile)'), '不得用不完整 tmp 覆盖原文件');
  });

  it('mcp-manager importServers 为批量原子写（不再逐条 remove/add）', () => {
    const src = read('packages/core/src/mcp-manager.js');
    assert.ok(src.includes('blocks.push(this._buildBlock(cfg))'), '应合并构建后一次性写入');
    assert.ok(src.includes('this._atomicWrite(nc);'), '应只调用一次原子写');
    assert.ok(!src.includes('await this.add(sv)'), '不应逐条 add');
    assert.ok(!src.includes('await this.remove(s.serverName)'), '不应逐条 remove');
  });

  it('core installer 清理 POSIX bin 时上跳两级并定位 bin 目录', () => {
    const src = read('packages/core/src/installer.js');
    assert.ok(src.includes('dirname(dirname(globalRoot.trim()))'), 'POSIX 应 dirname(dirname(npm root))');
    assert.ok(src.includes("join(prefix, 'bin', b)"), 'POSIX bin 应位于 prefix/bin 下');
  });

  it('capability-router uninstall 校验 profile 且 needCopy 覆盖 tgtPkg 缺失', () => {
    const src = read('packages/core/src/capability-router.js');
    assert.ok(src.includes('非法的 profile 名称'), 'uninstallCapabilityRouter 应校验 profile');
    assert.ok(src.includes('existsSync(tgtPkg) ?'), 'needCopy 应在 tgtPkg 缺失时判定为需拷贝');
  });

  it('master-prompt-manager read() 损坏时先备份再返回空', () => {
    const src = read('packages/core/src/master-prompt-manager.js');
    assert.ok(src.includes('.corrupt-'), '损坏文件应有 .corrupt- 备份');
    assert.ok(src.includes('copyFileSync'), '应复制损坏原件');
  });

  it('marketplace registry cleanupPatchEntries 精确匹配 + getLocalPlugins 数组防御', () => {
    const src = read('packages/marketplace/src/registry.js');
    assert.ok(src.includes('EXTRACT_ID_RE'), '应提取条目标识符做精确匹配');
    assert.ok(src.includes('Array.isArray(parsed)'), 'getLocalPlugins 应防御 JSON 非数组');
  });

  it('profile-manager backup() 校验 profile 名称', () => {
    const src = read('packages/core/src/profile-manager.js');
    assert.ok(src.includes('非法的 profile 名称'), 'backup 应拒绝 ../ 等非法名称');
  });

  it('electron main.js 有 will-navigate 导航白名单防护', () => {
    const src = read('electron/main.js');
    assert.ok(src.includes("contents.on('will-navigate'"), '应监听 will-navigate');
    assert.ok(src.includes('navEvent.preventDefault()'), '非白名单应阻止导航');
    assert.ok(src.includes('导航防护'), '应有防护日志');
  });

  it('electron ipc-handlers read-image 有大小限制、llm:fetch-models 有 SSRF 回环校验', () => {
    const src = read('electron/ipc-handlers.js');
    assert.ok(src.includes('imagegen:read-image'), '应有 read-image handler');
    assert.ok(src.includes('超过 20MB'), 'read-image 应有 20MB 限制');
    assert.ok(src.includes('isLoopback'), 'fetch-models 应有回环地址检查');
    assert.ok(src.includes('11434'), 'ollama 应限制默认端口 11434');
  });

  it('index.html CSP frame-src 仅放行本地地址', () => {
    const html = read('src/index.html');
    assert.ok(html.includes('frame-src http://127.0.0.1:* http://localhost:*'), 'frame-src 应仅放行本地');
  });

  it('app.js 关键 XSS 内插点已转义', () => {
    const src = read('src/assets/js/app.js');
    assert.ok(src.includes('escapeHtml(v.version)'), '版本徽章应转义');
    assert.ok(src.includes('escapeHtml(s.serverName)'), 'MCP serverName 应转义');
    assert.ok(src.includes('escapeAttr(v.version)'), '切换版本 onclick 应转义');
    assert.ok(src.includes('escapeAttr(existing?.serverName ||'), 'MCP 对话框 serverName value 应转义');
    assert.ok(!src.includes('value="${existing?.serverName || \'\'}"'), '未转义的 mcpName value 不应存在');
  });

  it('事件通道名统一为 dsh: 前缀（constants/app/dsh-status）', () => {
    const c = read('src/assets/js/modules/constants.js');
    assert.ok(c.includes("ENV_INSTALL_PROGRESS: 'dsh:env-install-progress'"), 'env 进度通道应带 dsh: 前缀');
    assert.ok(c.includes("PLUGIN_INSTALL_PROGRESS: 'dsh:plugin-install-progress'"), '插件进度通道应带 dsh: 前缀');
    assert.ok(c.includes("MAXIMIZE_CHANGE: 'window-maximize-change'"), '最大化通道名应与 preload 一致');
    const app = read('src/assets/js/app.js');
    const st = read('src/assets/js/modules/dsh-status.js');
    assert.ok(!app.includes("removeAllListeners('env-install-progress')"), 'app.js 不应残留无前缀通道');
    assert.ok(app.includes("removeAllListeners('dsh:env-install-progress')"), 'app.js 应使用 dsh: 前缀');
    assert.ok(app.includes("removeAllListeners('dsh:plugin-install-progress')"), 'app.js 插件进度应用 dsh: 前缀');
    assert.ok(!st.includes("removeAllListeners('env-install-progress')"), 'dsh-status.js 不应残留无前缀通道');
    assert.ok(st.includes("removeAllListeners('dsh:env-install-progress')"), 'dsh-status.js 应使用 dsh: 前缀');
  });

  it('build-test.cjs 已入库且 gitignore 有白名单例外', () => {
    assert.ok(existsSync(join(root, 'scripts', 'build-test.cjs')), 'build-test.cjs 应存在');
    const gi = read('.gitignore');
    assert.ok(gi.includes('!scripts/build-test.cjs'), 'gitignore 应放行 build-test.cjs');
  });

  it('github-api 无硬编码版本回退、package.json files 无幽灵目录', () => {
    const ga = read('packages/marketplace/src/github-api.js');
    assert.ok(!ga.includes("'1.3.17'"), '不应残留硬编码版本回退');
    assert.ok(ga.includes("getVersion().version || '0.0.0'"), '回退应统一为 0.0.0');
    const pkg = read('package.json');
    assert.ok(!pkg.includes('!packages/cli'), 'files 不应引用不存在的 packages/cli');
  });
});

// ====== 行为验证：真实执行修复后的逻辑 ======
describe('安全审计修复：行为验证', () => {
  it('mcp-manager importServers 批量写盘（replace 一次 + merge 一次）', async () => {
    await withHome(async () => {
      const { MCPServerManager } = await import('../packages/core/src/mcp-manager.js');
      const mgr = new MCPServerManager({ profile: 'web' });
      const dir = dirname(mgr.patchFile);
      const countBaks = () => readdirSync(dir).filter(f => f.startsWith('cordis.patch.yml.bak-')).length;

      const r1 = await mgr.importServers([
        { serverName: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        { serverName: 'http-bin', transport: 'streamable-http', url: 'https://example.com/mcp' },
        { serverName: 'db', transport: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'x' } },
      ], { mode: 'replace' });
      assert.equal(r1.success, true);
      const list1 = mgr.list();
      assert.equal(list1.length, 3, 'replace 后应有 3 个服务器，实际 ' + list1.length);
      assert.equal(countBaks(), 1, 'replace 应只写盘一次（1 个备份）');

      const r2 = await mgr.importServers([
        { serverName: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'other-pkg'] },
        { serverName: 'new-one', transport: 'stdio', command: 'echo' },
      ], { mode: 'merge' });
      assert.deepEqual(r2.updated, ['fs'], 'merge 应报告更新项');
      assert.deepEqual(r2.added, ['new-one'], 'merge 应报告新增项');
      const list2 = mgr.list();
      assert.equal(list2.length, 4, 'merge 后应有 4 个服务器');
      const fs2 = list2.find(s => s.serverName === 'fs');
      assert.ok(fs2.args.includes('other-pkg'), 'merge 更新应生效');
      assert.equal(countBaks(), 2, '第二次 merge 应再写盘一次（共 2 个备份）');
    });
  });

  it('capability-router uninstall/isInstalled 拒绝非法 profile', async () => {
    await withHome(async () => {
      const mod = await import('../packages/core/src/capability-router.js');
      const r = await mod.uninstallCapabilityRouter('../evil');
      assert.equal(r.success, false, '非法 profile 应返回失败');
      assert.ok(r.error && r.error.includes('非法的 profile 名称'), '应报告非法 profile');
      assert.equal(mod.isCapabilityRouterInstalled('../evil'), false, 'isInstalled 应拒绝非法 profile');
    });
  });

  it('master-prompt-manager 损坏文件先备份再返回空', async () => {
    await withHome(async (dshHome) => {
      const managerDir = join(dshHome, 'manager');
      mkdirSync(managerDir, { recursive: true });
      writeFileSync(join(managerDir, 'master-prompts.json'), '{broken!!', 'utf-8');
      const { MasterPromptManager } = await import('../packages/core/src/master-prompt-manager.js');
      const mgr = new MasterPromptManager();
      assert.deepEqual(mgr.read(), [], '损坏文件应返回空列表');
      const corrupt = readdirSync(managerDir).filter(f => /^master-prompts\.json\.corrupt-\d+$/.test(f));
      assert.equal(corrupt.length, 1, '应生成 .corrupt-* 备份');
      assert.equal(readFileSync(join(managerDir, corrupt[0]), 'utf-8'), '{broken!!', '备份应保留损坏原件内容');
    });
  });

  it('registry cleanupPatchEntries 精确匹配：清理 foo 不误删 foo-bar', async () => {
    await withHome(async (dshHome) => {
      const profileDir = join(dshHome, 'profiles', 'web');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'cordis.patch.yml'), [
        '# dsh profile patch layer',
        '- insert:',
        '    - id: foo',
        "      name: 'plugin-foo'",
        '    - id: foo-bar',
        "      name: 'plugin-foo-bar'",
        '',
      ].join('\n'), 'utf-8');
      const { PluginRegistry } = await import('../packages/marketplace/src/registry.js');
      const reg = new PluginRegistry();
      reg.cleanupPatchEntries('web', ['foo']);
      const out = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf-8');
      assert.equal(out.match(/^ {4}- id: foo$/m), null, 'foo 条目应被删除');
      assert.ok(out.match(/^ {4}- id: foo-bar$/m), 'foo-bar 条目应保留（精确匹配不误删）');
    });
  });
});