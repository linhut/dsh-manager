/**
 * 端到端落盘验证：模拟真实用户路径，验证模型配置是否真正写入磁盘并生效。
 * 使用临时 DSH_HOME + 临时工具路径，全部为隔离环境，不触碰真实 ~/.dsh。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'dshm-e2e-'));
const dshHome = join(home, '.dsh');
mkdirSync(join(dshHome, 'manager'), { recursive: true });
process.env.DSH_HOME = dshHome;
process.env.DSH_MANAGER_IMAGE_DIR = join(home, 'images');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const settingsFile = join(dshHome, 'settings.yaml');
const credFile = join(dshHome, '.credentials.yaml');

// ---- 初始状态：写入历史错误命名空间 + 旧明文，模拟真实用户遗留 ----
writeFileSync(settingsFile, [
  'llm-openai-compatible:',
  '  providers:',
  '    my-gw:',
  '      provider: openai-compatible',
  '      model: deepseek-v4-flash',
  '      apiKey: sk-legacy-plain-1234567890',
  '      baseURL: "https://gw.example.com/v1"',
  'llm-pi-ai:',
  '  providers:',
  '    yang-newapi:',
  '      provider: pi-ai',
  '      apiKeyEnv: YANG_KEY',
  '      api: openai-completions',
  '      baseURL: "http://192.168.1.9:65002/v1"',
  '      models:',
  '        - id: deepseek-v4-flash',
  '',
].join('\n'), 'utf-8');
writeFileSync(credFile, 'YANG_KEY: sk-yang-123456\n', 'utf-8');

// ---- 1. 迁移：错误命名空间 → llm-pi-ai，空 apiKeyEnv 清洗，明文迁移 ----
const { DSHConfig } = await import('../packages/core/src/config.js');
const { ModelConfigCenter } = await import('../packages/core/src/model-config-center.js');
const cfg = new DSHConfig();
const mig = await cfg.migrateLLMProviders();
check('migrate 移动错误段 llm-openai-compatible → llm-pi-ai', mig.moved === 1, `moved=${mig.moved}`);
check('migrate 就地清洗 llm-pi-ai 脏数据（provider 字段移除）', mig.normalized >= 1, `normalized=${mig.normalized}`);
const s1 = readFileSync(settingsFile, 'utf-8');
check('落盘：settings 不再含 llm-openai-compatible', !s1.includes('llm-openai-compatible'));
check('落盘：settings 不再含明文 sk-legacy-plain', !s1.includes('sk-legacy-plain'));
check('落盘：llm-pi-ai.providers.my-gw 存在', s1.includes('my-gw:') && s1.indexOf('llm-pi-ai') < s1.indexOf('my-gw:'));
check('落盘：空 apiKeyEnv 字段被清除', !/apiKeyEnv:\s*""/.test(s1));

// ---- 2. 保存提供商（明文 key → 凭据文件迁移） ----
await cfg.saveLLMProvider('deepseek-official', {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKey: 'sk-new-plain-abcdef',
  baseUrl: 'https://api.deepseek.com/v1',
});
const s2 = readFileSync(settingsFile, 'utf-8');
const c2 = readFileSync(credFile, 'utf-8');
check('落盘：llm-pi-ai.providers.deepseek-official 写入', s2.includes('deepseek-official:'));
check('落盘：settings 内无新明文密钥', !s2.includes('sk-new-plain-abcdef'));
check('落盘：明文已进 .credentials.yaml', c2.includes('sk-new-plain-abcdef'));
const envRef = c2.split('\n').find((l) => l.includes('sk-new-plain-abcdef'));
check('落盘：settings 引用凭据名（非 env: 前缀）', envRef ? s2.includes(envRef.split(':')[0].trim()) : false);

// ---- 3. 能力路由双写 ----
await cfg.saveLLMRouting({
  enabled: true,
  defaultCapability: 'semantic',
  capabilities: { semantic: { provider: 'my-gw', model: 'deepseek-v4-flash' }, code: { provider: 'yang-newapi', model: 'deepseek-v4-flash' } },
});
const s3 = readFileSync(settingsFile, 'utf-8');
check('落盘：settings.capability-router 写入', /capability-router:\s*\n\s*enabled: true/.test(s3));
check('落盘：manager.llm-routing 兼容回退写入', /manager:\s*\n\s*llm-routing:/.test(s3) || s3.includes('llm-routing:'));
const rout = await cfg.getLLMRouting();
check('读回：getLLMRouting 优先读 capability-router', rout.capabilities.code.model === 'deepseek-v4-flash');
// applyDefaultModel → agent-default-model
await cfg.applyDefaultModel('code');
const s3b = readFileSync(settingsFile, 'utf-8');
check('落盘：agent-default-model 写入', s3b.includes('agent-default-model:') && s3b.includes('yang-newapi'));
const resolved = await cfg.resolveCapability('code');
check('解析：resolveCapability(code) 返回真实 provider/model', resolved.provider === 'yang-newapi' && resolved.model === 'deepseek-v4-flash' && !!resolved.apiKeyEnv);

// ---- 4. 模型配置中心：档案 → 4 工具 ----
const toolPaths = {
  atomcode: join(home, 'atomcode', 'config.toml'),
  'claude-code': join(home, 'claude', 'settings.json'),
  workbuddy: join(home, 'codebuddy', 'models.json'),
  codex: join(home, 'codex', 'config.toml'),
};
const mcc = new ModelConfigCenter({ dataDir: join(dshHome, 'manager'), toolPaths });
const prof = mcc.saveProfile({
  name: 'Y 网关', baseUrl: 'http://192.168.1.9:65002/v1', apiKey: 'sk-arch-abcdefgh1234',
  model: 'deepseek-v4-flash', vendor: 'DeepSeek', contextWindow: 1048576, maxTokens: 393216,
  supportsVision: true, supportsToolCall: true, setDefault: true, temperature: 0.3,
});
check('档案：saveProfile 创建成功', !!prof.id);
const profs = mcc.listProfiles();
check('档案：list 脱敏（无明文 key，masked 含 ****）', profs[0].hasApiKey === true && profs[0].apiKey === '' && profs[0].apiKeyMasked.includes('****'));
const r = mcc.apply(prof.id, ['atomcode', 'claude-code', 'workbuddy', 'codex']);
check('应用：4 工具全部成功', r.results.every((x) => x.ok), r.results.map((x) => `${x.tool}:${x.ok}`).join(','));
// 第一次 apply 前预写 mock 配置，验证「写入前备份」
writeFileSync(toolPaths.atomcode, '[old]\nfoo = "bar"\n', 'utf-8');
const r2 = mcc.apply(prof.id, ['atomcode']);
check('应用(二次)：AtomCode 覆盖成功', r2.results[0].ok === true);
const atomToml = readFileSync(toolPaths.atomcode, 'utf-8');
check('AtomCode：model 段 + supports_vision + context_window 写入', atomToml.includes('models."' + prof.id + '/deepseek-v4-flash"') && atomToml.includes('supports_vision = true') && atomToml.includes('context_window = 1048576'));
check('AtomCode：default_provider/default_model 写入', atomToml.includes('default_provider = "' + prof.id + '"'));
const ccJson = JSON.parse(readFileSync(toolPaths['claude-code'], 'utf-8'));
check('Claude Code：env 四键写入', ccJson.env.ANTHROPIC_MODEL === 'deepseek-v4-flash' && !!ccJson.env.ANTHROPIC_AUTH_TOKEN);
const wbJson = JSON.parse(readFileSync(toolPaths.workbuddy, 'utf-8'));
check('WorkBuddy：maxInputTokens=1048576 与 temperature 写入', wbJson.models[0].maxInputTokens === 1048576 && wbJson.models[0].temperature === 0.3 && wbJson.models[0].supportsImages === true);
const codexToml = readFileSync(toolPaths.codex, 'utf-8');
check('Codex：model_provider + 段写入', codexToml.includes('model_provider = "' + prof.id + '"') && codexToml.includes('[model_providers.' + prof.id + ']'));
check('Codex：auth.json OPENAI_API_KEY 写入', existsSync(join(home, 'codex', 'auth.json')) && readFileSync(join(home, 'codex', 'auth.json'), 'utf-8').includes('sk-arch-abcdefgh1234'));
const backups = mcc.listBackups('atomcode');
check('备份：atomcode 备份文件存在', backups.length >= 1);
const det = mcc.listTools().find((t) => t.id === 'atomcode');
check('状态检测：AtomCode 反查档案匹配', det && det.current && det.current.appliedProfileId === prof.id);
// revert 验证：先改坏文件再还原（回溯到二次 apply 前的 mock 备份）
writeFileSync(toolPaths.atomcode, '[broken]\n', 'utf-8');
const rev = mcc.revert('atomcode');
const reverted = readFileSync(toolPaths.atomcode, 'utf-8');
check('还原：revert 恢复备份', rev.ok === true && reverted.includes('foo = "bar"') && !reverted.includes('[broken]'));

// ---- 5. 生图 provider 解析 ----
const { findProviderConfig, resolveApiKey } = await import('../packages/core/src/imagegen.js');
const { settings, credentials } = await cfg.read();
const pc = findProviderConfig(settings, 'yang-newapi');
check('生图：findProviderConfig 命中 yang-newapi', !!pc && pc.baseURL === 'http://192.168.1.9:65002/v1');
const key = resolveApiKey(credentials, pc.apiKeyEnv);
check('生图：resolveApiKey 解析凭据', key === 'sk-yang-123456');

// ---- 汇总 ----
const failed = results.filter((x) => !x.ok);
console.log(`\n===== 端到端落盘验证：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log(' - ' + f.name)); process.exitCode = 1; }
rmSync(home, { recursive: true, force: true });
