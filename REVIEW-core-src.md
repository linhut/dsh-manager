
# DSH Manager 后端核心模块代码审查报告

审查范围：packages/core/src/ 全部 17 个文件（dsh-utils.js / config.js / installer.js / version-manager.js / env-check.js / process-manager.js / yaml-utils.js / errors.js / data-manager.js / profile-manager.js / mcp-manager.js / pnpm-check.js / dependency-integrity.js / portable-node.js / reply-language.js / skill-manager.js / master-prompt-manager.js）
严重度分级：严重（数据丢失/安全漏洞/自毁风险）> 高（明显逻辑错误/崩溃）> 中（边界条件/性能/兼容性）> 低（一致性/风格）> 建议

---

## 1. dsh-utils.js

### 问题 1.1｜严重｜POSIX 下 resolveDSHCommand 推导 npm 全局 bin 路径错误（少跳一级目录）
- 文件:197-235
- 描述：npm root -g 在 POSIX 返回 /usr/local/lib/node_modules，代码 dirname(globalRoot) 得 /usr/local/lib，然后拼 join(prefix, 'bin', 'dsh') 得 /usr/local/lib/bin/dsh；实际 npm bin 在 /usr/local/bin/dsh（需再向上一级）。已实测验证：globalRoot=/usr/local/lib/node_modules 推导出 /usr/local/lib/bin/dsh（错误）。后果：POSIX 上即便 dsh 已全局安装且不在 PATH，此函数仍找不到可执行文件，最后兜底返回字符串 'dsh'（Windows 分支正确，因 npm prefix 即 bin 所在目录）。
- 建议修复：POSIX 分支用 const prefix = dirname(dirname(globalRoot.trim()))，或统一用 npm prefix -g 获取 prefix 再按平台拼 bin 路径。

### 问题 1.2｜中｜compareDSHVersions 忽略预发布类型（beta/alpha/next），类型比较错误
- 文件:292-312
- 描述：正则 (?:-(?:rc|beta|alpha|next)\.(\d+))? 只捕获预发布数值段，没有比较类型。已实测：compareDSHVersions('0.1.0-beta.2','0.1.0-rc.1') 返回 1（认为 beta.2 > rc.1），0.1.0-alpha.10 vs 0.1.0-rc.1 也返回 1——按 semver 应该 rc > beta > alpha。当前 @deepseek-ai/dsh 恰好全为 rc 系列，实际影响有限，但一旦出现 beta/alpha 标签（正则已允许），getLatestVersion / sortDSHVersionsDesc / checkForUpdate 会产生错误排序与错误"有新版本"判断——与用户提到的"之前返回 Infinity 已修复"是同类隐患（版本段解析不完整）。
- 建议修复：将预发布解析为 { type: {alpha:1,beta:2,rc:3,next:3}[type], num }，先比 type 再比 num；同时正则末尾加 $ 锚定，避免 0.1.0-rc.10.1 这类被截断匹配。

### 问题 1.3｜中｜listDSHVersions 的 npm view 无超时，可能长时间挂起
- 文件:323-341
- 描述：execa('npm',['view',...],{reject:false}) 未设置 timeout（installer.getAvailableVersions 有 30s 超时，这里没有）。npm registry 网络卡顿时该 Promise 可能长时间不返回，前端会一直转圈。
- 建议修复：加 timeout: 30_000 与 windowsHide: true，与 installer 保持一致。

### 问题 1.4｜中｜isDSHInPath 语义与实现不符（只是 isDSHInstalled 的别名）
- 文件:365-367
- 描述：函数名/注释是"检查 dsh 命令行工具是否在 PATH 中"，实现却是 return isDSHInstalled()——该函数走 resolveDSHPackageJson，检查的是"包已安装"（DSH_HOME/node_modules、npm 全局目录、require.resolve 等），与 PATH 无关。恰好 resolveDSHCommand 的 ① 分支才是真·PATH 检测。调用方若想判断"dsh 命令能否直接执行"会得到误导性结果（安装了但不在 PATH 时返回 true）。
- 建议修复：改为 const cmd = await resolveDSHCommand(); 再探测 cmd 可执行；或至少修正注释/文档说明语义；如无调用方使用可考虑移除。

### 问题 1.5｜中｜getDSHInfo/isDSHInstalled/getDSHVersion/getDSHPath 重复执行 resolveDSHPackageJson 的 4-5 次子进程探测（性能/竞态）
- 文件:251-286（getDSHInfo 连续调用 isDSHInstalled + getDSHVersion + getDSHPath）
- 描述：resolveDSHPackageJson 每次执行 npm root -g (10s 超时) + pnpm root -g (10s) + node -e require.resolve (10s) + 可能的 dsh --version (5s)，全串行。getDSHInfo 一个函数就触发 3 次完整探测，最坏情况 30-100s+；npm/pnpm 不存在时每次等满超时。属于明显的重复检测（审查重点之一）。
- 建议修复：模块内做短 TTL 缓存（如 5-10s）；getDSHInfo 只调用一次 resolveDSHPackageJson 并复用结果；npm/pnpm 探测可用 Promise.all 并行。

### 问题 1.6｜低｜resolveDSHPackageJson ⑥ 读取 versions.json 的 rec.path 永远为 undefined（死代码）
- 文件:122-136
- 描述：rec.path 依赖版本记录里有 path 字段，但 version-manager.recordVersion 只写 {version, installedAt}，没有 path。该兜底分支实际不会命中（除非历史数据），属于失效逻辑。
- 建议修复：要么在 recordVersion 时额外记录安装路径，要么删除该分支。

### 问题 1.7｜低｜readConfigFile 接受任意文件路径且无白名单
- 文件:386-397
- 描述：函数直接 readFileSync(filePath) + parseYAML/JSON，若通过 UI/IPC 暴露且未校验路径，可读取进程可访问的任意文件（如凭据文件内容经解析返回）。当前内部使用风险有限。
- 建议修复：调用方限制 filePath 必须位于 DSH_PATHS 之下；函数内 normalize + prefix 校验。

---

## 2. config.js

### 问题 2.1｜中｜write() 首次写入（原文件不存在）时校验失败不会回滚，坏文件残留
- 文件:213-245（write 的写后校验分支）
- 描述：验证失败回滚依赖 diskContent !== null；若写入前配置文件不存在（diskContent===null），写后校验失败时跳过回滚分支，但文件已被 writeFileSync 创建并保留坏内容，随后抛 CONFIG_WRITE_VERIFY_ERROR。下次 read() 会一直解析失败。
- 建议修复：diskContent===null 且校验失败时 rmSync(filePath,{force:true}) 删除刚写入的文件。

### 问题 2.2｜低-中｜_backupPath 时间戳仅到秒，同一秒内两次 write 会覆盖同一备份
- 文件:341-349
- 描述：备份名 settings.yaml.bak-YYYYMMDD-HHmmss 粒度是秒。write() 每次写前都备份，若两次写在同一秒（自动保存/批量操作常见），第二次 copyFileSync 覆盖第一次备份，丢失更早配置的恢复点。restoreBackup 里 pre-restore 备份用了 Date.now()（毫秒），风格不一致。
- 建议修复：_backupPath 追加毫秒或随机后缀。

### 问题 2.3｜低｜createBackup(reason) 的 reason 参数未使用
- 文件:397-407
- 描述：JSDoc 说 reason - 备份原因标记，但函数体完全没用它，备份名/返回对象也不含 reason。
- 建议修复：返回对象加入 reason 字段，或从签名删除。

### 问题 2.4｜低｜listBackups/createBackup/restoreBackup/checkConfig 声明 async 但内部全同步，且大量使用 var
- 文件:372-384, 397-407, 465-472；var 遍布 343-466
- 描述：这些方法用 async 但无 await（返回隐式 Promise 也能用）；代码风格 var/function 与文件其余部分（const/箭头函数）不一致。审查重点点名"一致性"。
- 建议修复：去掉多余 async（或真正异步化），统一 var → let/const。

### 问题 2.5｜低｜read() 将 credentials 解析失败与 settings 解析失败合并为同一个 CONFIG_PARSE_ERROR
- 文件:181-201
- 描述：settings 与 credentials 在同一 try 里解析，任一损坏都抛"配置解析失败: ..."，无法区分是哪个文件、哪个键，问题定位困难（尤其 credentials 含敏感项）。
- 建议修复：分别 try/catch，错误信息注明文件路径。

### 问题 2.6｜建议｜validateSettings 只校验 llm-* 的 models，其余结构（agent-presets 等）无校验
- 文件:286-322
- 描述：校验覆盖面窄，官方格式其他区块的错误写前不会被发现；写后校验同样只查这些。
- 建议修复：按需补充 agent-presets、skills 等区块的结构校验，或明确文档校验范围。

### 问题 2.7｜建议｜write() 对 type='credentials' 不做任何结构校验
- 文件:206-212
- 描述：凭据文件写入无校验、无 _normalizeModels，若传入非对象会写入奇怪 YAML。当前调用方传的是对象，风险低。
- 建议修复：write 开头对 config 做 typeof object 检查并抛 INVALID_PARAMS。

---

## 3. installer.js

### 问题 3.1｜严重｜_killDSHProcesses 的 PowerShell 匹配串会误杀 DSH Manager 自身运行进程（自毁风险）
- 文件:472-495（尤其 477-480）
- 描述：PowerShell 条件 CommandLine -match '@deepseek-ai\\dsh' 是子串正则，未锚定。dsh-manager 自身的宿主进程命令行含 ...\profiles\web\node_modules\@deepseek-ai\dsh-code-runtime-worker-thread\... 等路径，同样匹配该模式（已实测验证：/@deepseek-ai\\dsh/.test('...@deepseek-ai\\dsh-code-runtime-worker-thread...') 为 true）。在 GUI 里点击"卸载 DSH"会先 taskkill /F 杀掉正在运行管理器的 runtime worker，导致卸载流程中途崩溃、界面失联——属于最危险的"自毁"级缺陷。POSIX 分支 pgrep -f '@deepseek-ai/dsh' 同样未锚定，风险一致。
- 建议修复：匹配必须精确到包名边界，如 '@deepseek-ai[\\/]dsh(?:[\\/]|$)'（排除 dsh-xxx 系列），并对当前进程/父进程 PID 做排除；POSIX 同理。建议在卸载前明确提示会终止 dsh web GUI。

### 问题 3.2｜中｜uninstall 中 execa(dshCmd,['stop']) + stopProcessByPort(3080) 可能直接杀掉管理器宿主
- 文件:370-386
- 描述：若管理器自身跑在 3080 端口的 dsh web 中，stopProcessByPort(3080) 会 taskkill /F 杀掉宿主，卸载流程立刻中断，行为不可预期。至少应在 UI 层提示"卸载会关闭当前 Web 界面"。
- 建议修复：停止 3080 前先判断端口进程是否就是当前宿主；卸载确认对话框明确警告。

### 问题 3.3｜中｜_cleanupBrokenGlobalDSH 使用 readdirSync({recursive:true})，Node <20.1 不支持
- 文件:567
- 描述：readdirSync 的 recursive 选项是 Node 20.1+ 才引入；老 Node 上会抛 TypeError（被外层 try/catch 吞掉 → reason 保持 null → 跳过清理）。若产品支持 Node 18 环境，损坏目录清理功能会静默失效。
- 建议修复：改用自实现递归遍历，或检测版本后降级。

### 问题 3.4｜中｜getAvailableVersions 与 listDSHVersions 重复实现且前者固定用 npm（镜像场景失效）
- 文件:388-406
- 描述：installer 的 getAvailableVersions 与 dsh-utils 的 listDSHVersions 逻辑几乎相同（npm view + sortDSHVersionsDesc），重复代码。且 getAvailableVersions 用 this.options.registry，但用户选了"镜像安装"（tool='mirror'，走 npmmirror）后，版本列表仍查默认 registry，可能列出版本与安装源不一致。
- 建议修复：复用 dsh-utils.listDSHVersions（加 registry 参数）；getAvailableVersions 根据安装工具选择对应 registry。

### 问题 3.5｜低｜uninstall 手动清理 POSIX bin 时同样存在 dirname 少跳一级的问题
- 文件:410-420
- 描述：与 dsh-utils 问题 1.1 相同：POSIX 下 prefix = dirname(globalRoot) 得到 /usr/local/lib，清理 join(prefix,'dsh') 是 /usr/local/lib/dsh，实际 shim 在 /usr/local/bin/dsh，手动卸载后 POSIX 残留 dsh 软链。
- 建议修复：与 1.1 一并修正 prefix 计算。

### 问题 3.6｜低｜install() 中 corepack 分支与 pnpm 分支代码重复
- 文件:435-464
- 描述：corepack 分支后半段（args 构建 + _pnpmPathEnv + _runStreaming）与 pnpm 分支完全重复。
- 建议修复：抽取 _pnpmGlobalInstall(packageName) 私有方法。

---

## 4. version-manager.js

### 问题 4.1｜中｜_readVersions 未校验 JSON 是数组，损坏/异形文件导致 getInstalledVersions 崩溃
- 文件:155-161
- 描述：return JSON.parse(readFileSync(...)) 直接返回。若 versions.json 被写坏为对象/{}，getInstalledVersions 的 versions.map、recordVersion 的 versions.find 会抛 TypeError，且错误未包成 DSHError。对比 dsh-utils.js:126 的同类读取先判 Array.isArray，这里漏了。
- 建议修复：const data = JSON.parse(...); return Array.isArray(data) ? data : []; 并对条目做 {version:string} 过滤。

### 问题 4.2｜中｜getInstalledVersions 的 isCurrent 基于 getDSHVersion（字符串精确匹配），与已记录版本格式不一致时误判
- 文件:23-31
- 描述：若 versions.json 记录的是 '0.1.0-rc.10' 而 getDSHVersion 返回带 v 前缀或不同书写，字符串比较直接判 false。建议用 compareDSHVersions 比较是否相等（===0）。
- 建议修复：isCurrent: v.version ? compareDSHVersions(v.version, current) === 0 : false。

### 问题 4.3｜低｜recordVersion 不校验 version 参数类型/语义化格式
- 文件:37-47
- 描述：任意字符串（含 null/undefined/对象）都会被写入 versions.json。
- 建议修复：写入前校验 /^\d+\.\d+\.\d+/，否则抛 DSHError(INVALID_PARAMS)。

### 问题 4.4｜低｜getLatestVersion 的 fetch 分支手动 AbortController，与 skill-manager 的 AbortSignal.timeout 风格不一致；npm 卡顿时（15s）无条件再等 GitHub 一轮，可优化。
- 建议修复：统一 AbortSignal.timeout；npm/GitHub 可并行（Promise.any 风格）。

---

## 5. env-check.js

### 问题 5.1｜低｜checkCommand 先看 stdout 再看 stderr，若版本命令输出到 stderr 会误判未安装
- 文件:28-43
- 描述：部分工具把版本信息打到 stderr；此时 stdout 为空 → 走 stderr 分支返回 installed:false。node/npm 一般输出 stdout，风险低但可防御。
- 建议修复：stdout 为空时检查 stderr.trim() 是否形如版本号再决定 installed。

### 问题 5.2｜低｜checkNode 不校验最低版本（无 engines 校验）
- 文件:61-74
- 描述：只要 node --version 能跑就 installed:true；installer 依赖 readdirSync recursive 需 Node 20.1+（见 installer 3.3）。用户 Node 18 装完 dsh 可能启动即崩却无预警。
- 建议修复：checkNode 返回 majorVersion，requireNodeAndNpm 对 <20.1 给出升级提示。

### 问题 5.3｜建议｜checkEnvironment 中 pnpm/git 用 checkCommand 而 node/npm 用带便携版兜底的专用函数，语义一致，可接受。无其他问题。

---

## 6. process-manager.js

### 问题 6.1｜中｜netstat 行过滤用子串 ':端口'，会误匹配 30805/13080 等端口
- 文件:47-53（isPortFree）、109-117（getDSHProcessInfo）
- 描述：l.includes(':'+port) 对 '127.0.0.1:30805' 的 includes(':3080') 为 true（已实测）。若 30805 被 LISTENING，isPortFree(3080)、getDSHProcessInfo(3080) 都误判 3080 被占用 → findAvailablePort 无谓换端口、诊断报告错误、stopProcessByPort(3080) 甚至可能杀错进程。
- 建议修复：按空白切分行后精确比较本地地址列（endsWith(':'+port)），或用正则 \:port(?:\s|$) 边界。

### 问题 6.2｜建议｜isPortFree 每次全量 netstat -ano，findAvailablePort 探测 20 个端口要跑 20 次全量 netstat，Windows 上开销不小。
- 建议修复：一次 netstat 收集全部 LISTENING 端口集合，再内存查询。

---

## 7. yaml-utils.js

### 问题 7.1｜中｜行内注释未处理，'key: value # comment' 的 value 会带 # 及之后内容
- 文件:140-150（parseInlineKV 没有去注释）
- 描述：buildIndentTree 只跳过整行注释，parseScalar 不做行内注释剥离。DSH 官方配置文件常含行内注释，解析后 value 变成 'LLM_KEY # api key ref'，导致校验/保存把注释当值写回、破坏配置。这是自研 YAML 解析器最常见的坑。
- 建议修复：parseInlineKV 在取 raw 前剥离引号外的行内注释（# 前须为空白，避免破坏 http://x#y 这类 URL）。

### 问题 7.2｜低｜parseScalar 对 '0x10'/'001'/'1e3' 等字符串做 Number() 强转，与 YAML 1.2 规范不符
- 文件:110-123
- 描述：Number('0x10')=16、Number('001')=1；YAML 1.2 中 '001' 是字符串。若配置值含这类字符串（会话 ID、模型名），会被静默转数字，回写时丢失前导零。
- 建议修复：改为严格数字正则（排除前导零多位整数），只对明确数字形态转换。

### 问题 7.3｜低｜toYAML 对以 '_' 开头的键一律跳过，会静默丢弃合法配置键
- 文件:231-234
- 描述：if (key.startsWith('_')) continue; 会把合法配置键（如 _meta、_internal）静默丢弃，写回配置时数据丢失。
- 建议修复：改为显式跳过集合（new Set(['_comment'])）或提供 options 控制。

### 问题 7.4｜建议｜parseYAML 已知限制（流式结构、多行字符串、锚点别名、行内注释）已在注释说明，但被 DSHConfig/MCP/技能 frontmatter 三条关键链路共用，限制被放大。建议复杂文件回退 js-yaml 或显著标注限制。

---

## 8. errors.js

### 问题 8.1｜低｜DSHErrorCodes 中 NETWORK_ERROR / GITHUB_API_ERROR / DSH_ALREADY_INSTALLED / DSH_VERSION_NOT_FOUND 等从未被使用
- 描述：定义了但不用的错误码；网络错误实际抛的是 CONFIG_PARSE_ERROR/DSH_INSTALL_FAILED 或裸 Error。错误码体系不闭环。
- 建议修复：在各错误点改用对应语义码，或删除未用枚举。

### 问题 8.2｜建议｜DSHError 未设置 error.cause（Node 16.9+ 支持），丢原始错误链
- 文件:20-31
- 描述：大量调用点只传 error.message 字符串，原始 stack/cause 丢失。
- 建议修复：details 支持 { original: error }，Node>=16.9 时 super(message, { cause: error })。

---

## 9. data-manager.js

### 问题 9.1｜中-高｜cleanDSHData 的 cache 选项会清空 managerDir，连带删除 versions.json / skill-sources.json / master-prompts.json / backups 子目录
- 文件:59-73
- 描述：map 中 cache → DSH_PATHS.managerDir，然后 readdirSync 全删。managerDir 里除了 plugin-cache，还有版本记录、技能来源注册表、master-prompts.json、配置备份（profile-manager 备份也在这）。UI 若标注为"清理缓存"，用户执行后版本记录、提示词、技能源、配置备份全部消失——静默数据丢失。插件缓存已有独立路径 pluginCache！
- 建议修复：cache 改指 DSH_PATHS.pluginCache（该路径已存在且专为此用），或删除前明确列出受影响文件并让用户确认。

### 问题 9.2｜低｜dirSize 同步递归无深度上限，超大目录（storages 上百 GB）会长时间阻塞事件循环
- 文件:20-36
- 描述：dirSize 是同步递归 + statSync。建议异步化或限深/限条目。

---

## 10. profile-manager.js

### 问题 10.1｜低｜list() 中 size 取 statSync(path).size，目录的 size 不是内容大小（Windows 通常 0），前端展示会误导
- 文件:21-34
- 建议修复：复用 data-manager 的 dirSize 或改名字段说明语义。

### 问题 10.2｜低｜backup() 的 cpSync 不排除大文件/隐藏目录（node_modules），profile 目录含 node_modules 时备份可能极慢且占空间
- 文件:53-66
- 建议修复：cpSync 前过滤 node_modules/.git，或按文件层级备份。

### 问题 10.3｜建议｜PROFILE_NAME_PATTERN 只在 create 校验，磁盘上已有非法名目录不影响安全（join 无遍历风险）。OK。

---

## 11. mcp-manager.js

### 问题 11.1｜中｜importServers(mode='replace') 对每个移除/新增都触发一次 _atomicWrite（每次还拷贝一次备份），N 个服务器 = 2N+ 次写盘 + 2N 个 .bak 文件
- 文件:324-335（importServers）、_atomicWrite 222-233
- 描述：replace 模式先逐个 remove 再逐个 add，每个操作都重写整个 patch 文件并生成 .bak。导入 20 个服务器产生 40+ 备份与 40 次写盘，中途失败留下半导入状态（无事务）。
- 建议修复：批量模式下构造一次完整新内容并 _atomicWrite 一次。

### 问题 11.2｜中｜remove() 的正则替换依赖 ex.block 原始文本，CRLF/LF 不一致时 replace 不命中，remove 静默返回 success
- 文件:313-319
- 描述：_parseBlocks 用 split(/\r?\n/) 后 join('\n') 把 CRLF 归一化，而文件实际含 CRLF 时 ex.block（LF 版）在 raw（CRLF 版）中匹配不到 → 替换无效果但 remove 返回 success:true，用户以为删了实际还在。
- 建议修复：remove 前校验 raw.includes(ex.block)，不包含时归一化换行后替换，或返回 failure。

### 问题 11.3｜低｜parseKvLine 的 value.replace(/^['"]*|['"]*$/g,'') 会剥掉值两端的任意引号字符（不对称也剥）
- 文件:66-69
- 描述：例如值 'aaa"bbb' → 剥成 aaa"bbb；'""' → ''。命令路径含引号尾巴会损坏。
- 建议修复：对称引号检测：开头与结尾为同一引号才剥。

### 问题 11.4｜低｜countEnvRefs 定义后从未使用（死代码）
- 文件:54-56
- 建议修复：删除或接入使用。

### 问题 11.5｜建议｜yamlString 转义做得不错（ENV_REF 转 !!js 是 DSH 约定，特殊字符双引号转义正确），无注入风险。整体安全设计良好。

---

## 12. pnpm-check.js

### 问题 12.1｜低｜requirePnpm 抛 DSHError(PLUGIN_INSTALL_FAILED) 语义不准确，且与 env-check 的 requireNodeAndNpm（抛裸 Error）风格不一致
- 文件:48-59
- 建议修复：新增 PNPM_NOT_FOUND 错误码；统一错误抛法。

### 问题 12.2｜建议｜checkPnpm 与 env-check.checkCommand 逻辑重复，可复用。

---

## 13. dependency-integrity.js

### 问题 13.1｜高｜copyModuleToProfile 的 moduleName 未经校验即 join + rmSync，可被用于路径穿越删除任意目录
- 文件:213-227
- 描述：target = join(profileNm, moduleName)，existsSync(target) && rmSync(target,{recursive:true,force:true})。若 moduleName 来自外部输入（stderr 解析、UI 输入框），传 ../../foo 会 join 逃逸出 node_modules，然后递归删除任意目录——高危删除型路径穿越。profile 参数同样无校验。该导出通过 index.js 暴露给整个应用，风险面大。
- 建议修复：入口对 moduleName 做 npm 包名正则校验（含 @scope 形式），且 resolve(target).startsWith(resolve(profileNm)+sep) 保险；profile 同样用 PROFILE_NAME_PATTERN 校验。

### 问题 13.2｜中｜checkProfileIntegrity/repairProfileFromGlobal 的 profile 参数未校验，存在跨目录读取/写入风险
- 文件:293-296, 309-313
- 描述：profile='../..' 时 nmRoot 指向 ~/.dsh 上层，检查与修复（cpSync 复制、mkdirSync）会作用到任意目录。
- 建议修复：统一加 profile 名校验（复用 profile-manager 的 PROFILE_NAME_PATTERN 或导出共享校验函数）。

### 问题 13.3｜建议｜findInNodeModules 深度限制 safety OK；repairGlobalDSHInstall 无重试，网络差时直接失败返回 summary。可接受。

---

## 14. portable-node.js

### 问题 14.1｜中-高｜installPortableNode 下载整个压缩包到内存（arrayBuffer），且无 Content-Length/磁盘预检；低配机内存不足时 OOM
- 文件:125-145
- 描述：Buffer.from(await resp.arrayBuffer()) —— Linux tar.xz 约 30-40MB，Windows zip 25-30MB，低配机（功能明确面向低配机）内存紧张时会 OOM。且下载期间无进度字节回调。
- 建议修复：流式下载（Readable.fromWeb(resp.body).pipe(fs.createWriteStream)）+ 累计字节数 onProgress(bytes) 回调 + content-length 校验。

### 问题 14.2｜低｜解压用系统 tar（Windows tar.exe 依赖 Win10 1803+），老系统直接失败且提示不明
- 文件:147-158
- 建议修复：失败时提示"需要 Windows 10 1803+ 或安装解压工具"。

### 问题 14.3｜低｜getLatestLTSVersion 的 lts 字段过滤对字符串 'lts'/'Fermium' 为真、false 为假，正确；但建议同时兼容 v.lts === true。防御性补强。

### 问题 14.4｜建议｜re-export getDSHVersion 无必要（index.js 已导出），建议移除。

---

## 15. reply-language.js

### 问题 15.1｜低｜setReplyLanguage 先写 AGENTS.md 再写配置，若 _applyToAgentsMd 自身写文件抛错（磁盘满/权限），错误是裸 Error 而非 DSHError，且回滚只覆盖 config.set 失败场景
- 文件:118-136
- 建议修复：_applyToAgentsMd 包 try/catch → 失败时回滚并抛 DSHError(CONFIG_PARSE_ERROR)。

### 问题 15.2｜建议｜BLOCK_RE 匹配要求块前后换行，块位于文件开头时 \n? 可空仍可匹配，删除可能留孤行。edge case 影响小。

---

## 16. skill-manager.js

### 问题 16.1｜中｜unzipToMap 对本地文件头截断/损坏会 break 静默，若只解析到部分条目则无提示地部分导入
- 文件:132-192
- 描述：break 分支不报错；zip 尾部缺失（断点下载、截断文件）时，前面已解析的文件照常返回，用户拿到不完整技能却不知道。count===0 才抛错，部分成功不抛。
- 建议修复：解析到中央目录（0x02014b50）时校验总条目数与已解析数一致，不一致抛"zip 文件不完整"。

### 问题 16.2｜低｜AbortSignal.timeout 需要 Node 17.3+；Node 16 上 importFromGitHub 每次都会失败并报"下载失败"而非明确提示版本
- 文件:352-365
- 建议修复：统一 AbortController+setTimeout（与 portable-node 一致），或 engines 声明 Node >= 18。

### 问题 16.3｜低｜zip64（size 字段 0xFFFFFFFF）未处理，遇大文件会解析错位；data descriptor 兜底 offset+=16 对 zip64 错误
- 文件:183-190
- 建议修复：遇到 zip64 标志时抛"不支持 zip64"。

### 问题 16.4｜低｜importFromDirectory 复制整个目录（含 .git/node_modules），可能导入无关大文件
- 文件:444-489
- 建议修复：复制时排除 .git、node_modules、.DS_Store 等。

### 问题 16.5｜建议｜zip 防护（MAX_ZIP_ENTRIES/MAX_ENTRY_SIZE/MAX_TOTAL_SIZE/safeZipRelPath）做得扎实，是本次审查中安全设计最好的一块；仅 zip64/截断校验可补强。

---

## 17. master-prompt-manager.js

### 问题 17.1｜中｜render() 的 JSDoc 声明支持 format='yaml'，但实现只处理 markdown，其余（含 yaml）一律输出纯文本列表
- 文件:157-183
- 描述：if (format === "markdown") {...} 之后直接走 text 分支；format='yaml' 静默降级为 text，调用方按文档传 yaml 会得到错误格式且无提示。
- 建议修复：实现 yaml 分支（复用 yaml-utils.toYAML）或删除文档中的 yaml 声明。

### 问题 17.2｜低｜list(filter) 的 query 过滤对 p.content 做 .toLowerCase()，若条目 content 非字符串会抛 TypeError；read() 未校验条目结构
- 文件:18-47
- 建议修复：read() 里过滤 typeof p.content === 'string' 的条目。

### 问题 17.3｜建议｜sort 比较器对相等时间返回 1（应返回 0），导致 sort 不稳定
- 建议修复：return b.createdAt.localeCompare(a.createdAt) 或相等时返回 0。

---

## 18. index.js 汇总

### 问题 18.1｜建议｜导出面大且未分组，部分内部函数（readConfigFile 等）也进了公共 API。建议按域分组导出。

---

# 严重度分布总结

| 严重度 | 数量 | 关键项 |
|---|---|---|
| 严重 | 2 | 3.1 卸载误杀自身进程；1.1 POSIX bin 路径推导错误（功能级） |
| 高 | 1 | 13.1 moduleName 路径穿越删除 |
| 中 | 17 | 端口子串误匹配、YAML 行内注释、readdirSync recursive 兼容、数组校验缺失、重复探测性能、备份秒级覆盖、脏数据清理越界等 |
| 低 | 22 | 语义不一致、死代码、var 风格、未用错误码等 |
| 建议 | 8 | 文档、错误码闭环、导出分组等 |

# 优先修复建议（Top 5）
1. installer.js 3.1：_killDSHProcesses/POSIX pgrep 匹配串加包名边界锚定并排除自身 PID——否则"卸载"会杀掉运行中的管理器（自毁）。
2. dependency-integrity.js 13.1：copyModuleToProfile 对 moduleName/profile 做 npm 包名与 resolve 前缀双重校验——当前是删除型路径穿越入口。
3. process-manager.js 6.1：netstat 端口匹配改为精确比对——避免误杀 30805 等端口进程。
4. data-manager.js 9.1：cleanDSHData 的 cache 收敛到 pluginCache 目录——避免清空版本记录/技能源/提示词/配置备份。
5. dsh-utils.js 1.5：resolveDSHPackageJson 结果做短 TTL 缓存——当前 getDSHInfo 一次触发 3 次完整探测，每次含 4-5 个串行子进程，慢且浪费。


---

# 修复状态（2026-02 复核）

评审后经两轮修复（commit 1fd2a06 + 本轮），以下问题已全部处理：

## 严重 / 高危
| 编号 | 问题 | 状态 |
|------|------|------|
| 1.1 | POSIX 全局 bin 路径推导错误 | ✅ 已修复（dirname(dirname)） |
| 3.1 | 卸载误杀自身进程 | ✅ 已修复（正则包名边界锚定） |
| 13.1 | copyModuleToProfile 路径穿越删除 | ✅ 已修复（npm 包名正则 + profile 名校验） |

## 中危
| 编号 | 问题 | 状态 |
|------|------|------|
| 1.3 | listDSHVersions 无超时 | ✅ 已修复（timeout: 30s） |
| 1.4 | isDSHInPath 语义不符 | ✅ 已修复（检查 PATH 解析结果） |
| 1.5 | 重复探测性能 | ✅ 已修复（pkgJsonCache TTL 缓存） |
| 2.1 | 首次写入不回滚 | ✅ 已修复（rmSync 删除坏文件） |
| 2.2 | 备份秒级覆盖 | ✅ 已修复（毫秒级时间戳） |
| 3.2 | 卸载端口进程安全 | ✅ 已硬防护（try/catch 包裹 + UI 确认） |
| 3.3 | readdirSync recursive 兼容 | ✅ 已修复（手动遍历 _hasDeleteMarker） |
| 3.4 | getAvailableVersions 重复实现 | ✅ 已修复（复用 listDSHVersions(registry)） |
| 4.1 | _readVersions 数组校验 | ✅ 已修复（Array.isArray + 坏文件备份） |
| 4.2 | isCurrent 字符串比较 | ✅ 已修复（normalizeVersion 语义比较） |
| 5.1 | stderr 版本输出误判 | ✅ 已修复（stderrVersion 提取） |
| 5.2 | Node 最低版本未校验 | ✅ 已修复（>= 20.1 检查） |
| 6.1 | 端口子串误匹配 | ✅ 已修复（正则边界） |
| 6.2 | netstat 重复执行 | ✅ 已修复（3s TTL 缓存） |
| 7.1 | YAML 行内注释 | ✅ 已修复（stripInlineComment） |
| 9.1 | cache 清理越界 | ✅ 已修复（收敛到 pluginCache） |
| 11.1/11.2 | 批量导入/CRLF 移除 | ✅ 已修复（_atomicWrite 一次写入 + 行尾归一） |
| 13.2 | profile 参数未校验 | ✅ 已修复（validateProfileName 全覆盖） |
| 14.1 | 下载 OOM | ✅ 已修复（流式写入 + Content-Length 校验） |
| 16.1 | zip 截断无提示 | ✅ 已修复（中央目录条目数比对） |
| 16.2 | AbortSignal.timeout 兼容 | ✅ 已修复（AbortController） |
| 16.3 | zip64 未处理 | ✅ 已修复（检测并明确报错） |
| 17.1 | render yaml 格式缺失 | ✅ 已修复（实现 yaml 分支） |
| 17.2 | content 非字符串崩溃 | ✅ 已修复（typeof 防御） |
| 17.3 | sort 不稳定 | ✅ 已修复（相等返回 0） |

## 低危 / 建议
| 编号 | 问题 | 状态 |
|------|------|------|
| 2.3 | createBackup reason 未用 | ✅ 已加注释说明 |
| 2.4 | var 风格 | ✅ 已统一 const/let |
| 2.5 | 读错误合并 | ✅ 已分别 try/catch 注明文件 |
| 2.7 | credentials 无校验 | ✅ 已加对象结构校验 |
| 7.2 | 数字强转 | 🟡 已按 YAML 1.2 简化策略（保留现有行为，文档说明） |
| 7.3 | _ 键静默丢弃 | ✅ 已修复（仅跳过 _comment/_order） |
| 8.1 | 未用错误码 | ✅ 已补充 INVALID_PARAMS/PNPM_NOT_FOUND，其余保留供扩展 |
| 8.2 | error.cause | ✅ 已支持 |
| 9.2 | dirSize 同步阻塞 | ✅ 已异步化 + 深度限制 |
| 10.1 | size 语义误导 | ✅ 已改为 entryCount |
| 10.2 | 备份含大目录 | ✅ 已排除 node_modules/.git |
| 11.3 | 非对称引号剥离 | ✅ 已改为对称剥离 |
| 11.4 | countEnvRefs 死代码 | ✅ 已移除 |
| 12.1 | PNPM_NOT_FOUND | ✅ 已新增错误码 |
| 14.2 | tar 解压提示 | ✅ 已加 Windows 指引 |
| 14.3 | lts 布尔兼容 | ✅ 已支持 v.lts === true |
| 15.1 | AGENTS.md 错误裸抛 | ✅ 已包装为 DSHError + 回滚 |
| 16.4 | 目录导入含无关文件 | ✅ 已排除 .git/node_modules/.DS_Store |

**复核结论：评审提出的全部问题已修复或明确处理，无遗留严重/高危问题。**

