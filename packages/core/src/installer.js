/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { DSHError, DSHErrorCodes } from './errors.js';
import { DSH_PATHS, isDSHInstalled, getDSHVersion, getDSHPath, resolveDSHCommand, sortDSHVersionsDesc } from './dsh-utils.js';
import { requireNodeAndNpm } from './env-check.js';

/**
 * 安装器配置
 */
const INSTALL_OPTIONS = {
  /** npm 安装超时（毫秒） */
  npmInstallTimeout: 300_000,
  /** 默认 npm registry */
  defaultRegistry: 'https://registry.npmjs.org',
  /** 镜像 registry */
  mirrors: {
    npm: 'https://registry.npmjs.org',
    npmmirror: 'https://registry.npmmirror.com',
  },
};

export class DSHInstaller {
  /**
   * @param {object} [options]
   * @param {string} [options.registry] - npm registry URL
   * @param {boolean} [options.verbose] - 是否显示详细日志
   * @param {function} [options.onProgress] - 进度回调
   */
  constructor(options = {}) {
    this.options = {
      ...INSTALL_OPTIONS,
      ...options,
    };
    this.logs = [];
  }

  /**
   * 安装 DSH
   * @param {string} [version] - 指定版本，默认最新
   * @param {object} [opts]
   * @param {boolean} [opts.global] - 全局安装
   * @param {string} [opts.tool] - 安装工具 'auto' | 'npm' | 'pnpm' | 'mirror'（默认 auto：npm 失败自动切 pnpm）
   * @returns {Promise<{success: boolean, version: string, path: string, tool: string}>}
   */
  async install(version, opts = {}) {
    const { global = true, tool = 'auto' } = opts;
    
    this._log('开始安装 DSH...');

    // 基础环境检测：npm 未安装时给出 Node.js 安装引导，而非 ENOENT 报错
    try {
      await requireNodeAndNpm('安装 DSH');
    } catch (error) {
      throw new DSHError(DSHErrorCodes.DSH_INSTALL_FAILED, error.message);
    }

    // 检查是否已安装
    const alreadyInstalled = await isDSHInstalled();
    if (alreadyInstalled) {
      const currentVersion = await getDSHVersion();
      this._log(`DSH ${currentVersion} 已安装`);
    }

    // 尝试的安装工具列表
    let tools = [];
    if (tool === 'auto') tools = ['npm', 'pnpm', 'corepack'];
    else if (tool === 'mirror') tools = ['npm-mirror', 'pnpm'];
    else tools = [tool];

    let errors = [];
    for (const t of tools) {
      try {
        const result = await this._installWithTool(version, t);
        return { ...result, tool: t };
      } catch (error) {
        errors.push({ tool: t, message: error.message });
        this._log(`${t} 安装尝试失败: ${error.message}`, 'warn');
      }
    }

    // 汇总所有工具的失败原因，便于用户排查
    const summary = errors.map(e => `  - ${e.tool}: ${e.message}`).join('\n');
    throw new DSHError(
      DSHErrorCodes.DSH_INSTALL_FAILED,
      `DSH 安装失败（已尝试 ${tools.join(' / ')}）:\n${summary}\n\n请检查网络连接、npm 全局安装权限，或更换镜像源后重试。`
    );
  }

  /**
   * 使用指定工具安装 DSH
   * @private
   */
  async _installWithTool(version, tool) {
    // 构建包名
    const packageName = version
      ? `@deepseek-ai/dsh@${version}`
      : '@deepseek-ai/dsh';

    this._ensureDSHHome();

    // 清理上次失败卸载/安装遗留的损坏全局目录（避免 TAR_ENTRY_ERROR / ENOTEMPTY）
    await this._cleanupBrokenGlobalDSH();

    if (tool === 'npm' || tool === 'npm-mirror') {
      const args = ['install', '-g', packageName];
      if (tool === 'npm-mirror') {
        args.push('--registry', INSTALL_OPTIONS.mirrors.npmmirror);
      } else if (this.options.registry && this.options.registry !== INSTALL_OPTIONS.defaultRegistry) {
        args.push('--registry', this.options.registry);
      }
      this._log(`⏳ 正在执行: npm ${args.join(' ')}`);
      this._log('⏳ 正在下载并安装 DSH，可能需要几分钟，请耐心等待...', 'info');
      await this._runStreaming('npm', args, {
        timeout: this.options.npmInstallTimeout,
      });
    } else if (tool === 'pnpm') {
      // pnpm 全局安装
      const args = ['add', '-g', packageName];
      if (this.options.registry) {
        args.push('--registry', this.options.registry);
      }
      this._log(`⏳ 正在执行: pnpm ${args.join(' ')}`);
      // 注入 pnpm 全局 bin 目录到 PATH（避免 "global bin directory is not in PATH"）
      const pnpmEnv = await this._pnpmPathEnv();
      await this._runStreaming('pnpm', args, {
        timeout: this.options.npmInstallTimeout,
        env: pnpmEnv,
      });
    } else if (tool === 'corepack') {
      // corepack 引导 + pnpm 安装组合：
      // corepack 只能分发 yarn/pnpm 等包管理器，故先用 corepack enable 启用 pnpm，再走 pnpm 全局安装
      this._log('⏳ 执行: corepack enable（启用 Node 内置包管理器）');
      try {
        await execa('corepack', ['enable'], { windowsHide: true,
          timeout: 60_000,
          stdio: this.options.verbose ? 'inherit' : 'pipe',
        });
      } catch (error) {
        // Node.js 16.9+ 自带 corepack，失败多为 PATH/权限问题，给出明确提示而非再次尝试安装
        throw new DSHError(
          DSHErrorCodes.DSH_INSTALL_FAILED,
          `corepack 不可用: ${error.shortMessage || error.message}\nNode.js 16.9+ 已内置 corepack，请确认 Node 版本与 PATH 配置，或改用 npm/pnpm 安装。`
        );
      }
      // 复用 pnpm 安装逻辑
      const args = ['add', '-g', packageName];
      if (this.options.registry) {
        args.push('--registry', this.options.registry);
      }
      this._log(`⏳ 正在执行: pnpm ${args.join(' ')}`);
      const pnpmEnv = await this._pnpmPathEnv();
      await this._runStreaming('pnpm', args, {
        timeout: this.options.npmInstallTimeout,
        env: pnpmEnv,
      });
    }

    // 验证安装
    this._log('🔍 正在验证 DSH 安装结果...', 'info');
    const installed = await isDSHInstalled();
    if (!installed) {
      throw new DSHError(
        DSHErrorCodes.DSH_INSTALL_FAILED,
        'DSH 安装验证失败，dsh 命令不可用'
      );
    }

    const newVersion = await getDSHVersion();
    this._log(`DSH ${newVersion} 安装成功！`);

    return {
      success: true,
      version: newVersion,
      path: await this._getDSHPath(),
    };
  }

  /**
   * 卸载 DSH
   * 
   * Windows 下 `npm uninstall -g` 常因 DSH 进程仍持有文件句柄报 ENOTEMPTY，
   * 因此依次：① 停止 DSH 进程（含按命令行终止残留 node 进程）→ ② npm uninstall →
   * ③ ENOTEMPTY 时等待锁释放重试 → ④ 仍失败则手动删除全局安装目录
   * （npm uninstall 的可靠降级方案，删除前先重命名以解除路径锁）。
   * @returns {Promise<{success: boolean, method: string}>}
   */
  async uninstall() {
    this._log('开始卸载 DSH...');

    const installed = await isDSHInstalled();
    if (!installed) {
      this._log('DSH 未安装，无需卸载');
      return { success: true, method: 'not-installed' };
    }

    // ① 停止可能正在运行的 DSH 进程，释放文件句柄（避免 Windows ENOTEMPTY）
    try {
      const dshCmd = await resolveDSHCommand();
      await execa(dshCmd, ['stop'], { reject: false, timeout: 15_000, windowsHide: true });
      this._log('已尝试停止 DSH 进程');
    } catch {}
    try {
      const { stopProcessByPort } = await import('./process-manager.js');
      await stopProcessByPort(3080);
    } catch {}
    // ①.5 终止所有命令行匹配 @deepseek-ai/dsh 的残留 node 进程：
    //      detached 启动的 web 子进程可能不随 `dsh stop` 退出，
    //      仍持有 node_modules 内文件句柄，是 npm uninstall ENOTEMPTY 的主因
    try {
      const killed = await this._killDSHProcesses();
      if (killed > 0) this._log(`已终止 ${killed} 个残留 DSH 进程`);
    } catch {}

    // ② npm uninstall（失败时自动重试一次，规避瞬时文件锁）
    // 注意：DSH 含 400+ 个依赖包，实测完整卸载需约 4 分钟，超时不可设太短
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await execa('npm', ['uninstall', '-g', '@deepseek-ai/dsh'], { windowsHide: true,
          timeout: this.options.npmUninstallTimeout || this.options.npmInstallTimeout,
          stdio: this.options.verbose ? 'inherit' : 'pipe',
        });
        this._log('DSH 卸载成功');
        return { success: true, method: 'npm' };
      } catch (error) {
        const msg = error.message || '';
        const isLocked = /ENOTEMPTY|EPERM|EBUSY|EEXIST|ENOENT/.test(msg);
        this._log(`npm 卸载尝试 ${attempt}/2 失败: ${error.message}`, 'warn');
        if (attempt === 1 && isLocked) {
          // 再次终止残留进程，等待文件锁释放（杀毒软件/索引服务可能短暂持有句柄）
          try { await this._killDSHProcesses(); } catch {}
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        // ③ 手动删除全局安装目录作为兜底
        try {
          const dshPath = await getDSHPath();
          if (dshPath && existsSync(dshPath)) {
            this._log('npm 卸载失败，尝试手动删除全局安装目录...', 'warn');
            const removed = await this._forceRemoveDir(dshPath);
            if (!removed) {
              throw new Error('目录删除失败（文件可能仍被其他进程占用）: ' + dshPath);
            }
            // 清理 npm 全局 bin 中的 dsh 命令（Windows: dsh / dsh.cmd / dsh.ps1）
            try {
              const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000, windowsHide: true });
              if (globalRoot && globalRoot.trim()) {
                const prefix = dirname(globalRoot.trim());
                const bins = process.platform === 'win32'
                  ? ['dsh', 'dsh.cmd', 'dsh.ps1', 'dsh.exe']
                  : ['dsh'];
                for (const b of bins) {
                  const bp = join(prefix, b);
                  if (existsSync(bp)) rmSync(bp, { force: true, maxRetries: 5, retryDelay: 300 });
                }
              }
            } catch {}
            this._log('已手动删除 DSH 全局目录');
            return { success: true, method: 'manual' };
          }
        } catch (manualError) {
          this._log(`手动删除失败: ${manualError.message}`, 'error');
        }
        throw new DSHError(
          DSHErrorCodes.DSH_UNINSTALL_FAILED,
          `DSH 卸载失败: ${error.message}`,
          { originalError: error.message }
        );
      }
    }
  }

  /**
   * 升级 DSH 到最新版本
   * @returns {Promise<{success: boolean, oldVersion: string|null, newVersion: string}>}
   */
  async upgrade() {
    const oldVersion = await getDSHVersion();
    this._log(`当前版本: ${oldVersion || '未安装'}`);

    const result = await this.install('latest');
    return {
      success: result.success,
      oldVersion,
      newVersion: result.version,
    };
  }

  /**
   * 切换 DSH 版本
   * @param {string} version - 目标版本
   * @returns {Promise<{success: boolean, oldVersion: string|null, newVersion: string}>}
   */
  async switchVersion(version) {
    const oldVersion = await getDSHVersion();
    this._log(`版本切换: ${oldVersion || '未安装'} → ${version}`);

    // 先卸载旧版本；卸载失败不阻断切换——
    // 残留的损坏目录会由安装流程的 _cleanupBrokenGlobalDSH 识别并清理，
    // 避免"卸载失败 → 整个切换中止，旧版已半删"的最坏状态
    try {
      await this.uninstall();
    } catch (error) {
      this._log(`旧版本卸载失败（残留目录将由安装流程清理）: ${error.message}`, 'warn');
    }
    // 安装指定版本（失败时回滚到旧版本）
    try {
      const result = await this.install(version);
      return {
        success: result.success,
        oldVersion,
        newVersion: result.version,
      };
    } catch (error) {
      this._log(`版本切换失败，尝试恢复旧版本 ${oldVersion}...`, 'warn');
      try {
        await this.install(oldVersion);
        this._log(`已恢复旧版本 ${oldVersion}`, 'info');
      } catch (restoreError) {
        this._log(`恢复旧版本失败: ${restoreError.message}。DSH 当前可能已卸载。`, 'error');
      }
      throw error;
    }
  }

  /**
   * 获取可用的 DSH 版本列表
   * @returns {Promise<string[]>}
   */
  async getAvailableVersions() {
    try {
      const registry = this.options.registry || INSTALL_OPTIONS.defaultRegistry;
      const { stdout } = await execa('npm', [
        'view', '@deepseek-ai/dsh', 'versions', '--json',
        '--registry', registry,
      ], { timeout: 30_000, reject: false, windowsHide: true });

      if (stdout) {
        const versions = JSON.parse(stdout);
        // 只保留合法语义化版本号，并按语义化版本降序（最新在前）
        // 注意：不能用字符串 .reverse() —— rc.10 会被排在 rc.9 前面
        return sortDSHVersionsDesc(
          versions.filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v.trim()))
        );
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * 获取安装日志
   * @returns {string[]}
   */
  getLogs() {
    return [...this.logs];
  }

  /** @private */
  _log(message, level = 'info') {
    this.logs.push({ level, message, timestamp: new Date().toISOString() });
    if (this.options.onProgress) {
      this.options.onProgress({ level, message });
    }
  }

  /**
   * 流式执行安装命令，并把子进程实时输出逐行转发到进度日志
   *
   * 旧实现用 stdio:'pipe' 静默等待，用户在安装过程中看不到任何进展，
   * 容易被误判为"卡死"。这里改为边执行边把 npm/pnpm 的 stdout/stderr
   * 逐行推送给 onProgress，驱动界面的步骤日志与进度条。
   * @param {string} cmd - 命令名（npm / pnpm）
   * @param {string[]} args - 参数
   * @param {{timeout?: number, env?: object}} [options]
   * @private
   */
  async _runStreaming(cmd, args, options = {}) {
    const { timeout, env } = options;
    const child = execa(cmd, args, {
      timeout,
      env,
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // 逐行转发实时输出（含 npm 的进度行如 "added 123 packages"）
    const pump = (stream, level) => {
      if (!stream) return;
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const text = line.trim();
          if (text) this._log(text, level);
        }
      });
      stream.on('end', () => {
        const text = buffer.trim();
        if (text) this._log(text, level);
      });
    };
    pump(child.stdout, 'info');
    pump(child.stderr, 'warn');
    const result = await child;
    if (result.exitCode !== 0) {
      throw new Error(
        `${cmd} 执行失败（exit=${result.exitCode}）: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`
      );
    }
    return result;
  }

  /** @private */
  _ensureDSHHome() {
    const dirs = [
      DSH_PATHS.home,
      DSH_PATHS.profiles,
      DSH_PATHS.sessions,
      DSH_PATHS.skills,
      DSH_PATHS.storages,
      DSH_PATHS.managerDir,
      DSH_PATHS.pluginCache,
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        this._log(`创建目录: ${dir}`);
      }
    }
  }

  /**
   * 终止所有与 DSH 相关的残留 node 进程（Windows: 按命令行匹配；POSIX: 按匹配串 pgrep）
   *
   * `dsh web` 以 detached 方式启动后，其子进程/孙进程可能不随 `dsh stop` 退出，
   * 继续持有全局 node_modules 内文件句柄，是 `npm uninstall -g` 报
   * ENOTEMPTY/EPERM 的直接原因。这里按命令行特征串定位并强制结束，
   * 只精确匹配 DSH 相关进程，不影响用户自己的 node 服务。
   * @returns {Promise<number>} 实际终止的进程数
   * @private
   */
  async _killDSHProcesses() {
    let killed = 0;
    try {
      if (process.platform === 'win32') {
        // wmic 已弃用/权限受限，用 PowerShell 查询命令行含 @deepseek-ai\dsh 的进程
        const script = [
          "Get-CimInstance Win32_Process |",
          "Where-Object { $_.CommandLine -match '@deepseek-ai[\\\\/]dsh(?=[\\\\/\\\\s]|$)' } |",
          "ForEach-Object { $_.ProcessId }",
        ].join(' ');
        const { stdout } = await execa('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command', script,
        ], { reject: false, timeout: 15_000, windowsHide: true });
        const pids = stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
        for (const pid of pids) {
          try {
            await execa('taskkill', ['/PID', pid, '/F', '/T'], { reject: false, timeout: 10_000, windowsHide: true });
            killed++;
          } catch {}
        }
      } else {
        // POSIX：pgrep 按命令行特征匹配，kill -9 结束
        const { stdout } = await execa('pgrep', ['-f', '@deepseek-ai/dsh[/\\s]'], { reject: false, timeout: 10_000, windowsHide: true });
        const pids = stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
        for (const pid of pids) {
          try {
            await execa('kill', ['-9', pid], { reject: false, timeout: 10_000, windowsHide: true });
            killed++;
          } catch {}
        }
      }
    } catch {
      // 进程查询/终止失败不阻断卸载，后续 rmSync 兜底会再尝试
    }
    return killed;
  }

  /**
   * 强制删除目录（Windows 文件锁兜底）
   *
   * 直接 rmSync 在目录被进程/杀毒软件短暂占用时同样会抛 ENOTEMPTY，
   * 这里先尝试把目录整体重命名为临时名（解除路径级锁），再递归删除；
   * 仍失败则稍后重试，最终放弃时返回 false 由调用方决定是否报错。
   * @param {string} dir - 目标目录绝对路径
   * @returns {Promise<boolean>} 删除是否成功（目录已不存在）
   * @private
   */
  async _forceRemoveDir(dir) {
    // 先快速尝试一次直接删除（多数场景一次成功）
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (!existsSync(dir)) return true;
    } catch {}

    // 重命名到临时名，解除路径级句柄后删除
    const tmp = join(dirname(dir), '.dsh-uninstall-' + Date.now());
    try {
      renameSync(dir, tmp);
      rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      if (!existsSync(dir)) return true;
    } catch {}

    // 最后：等待句柄释放后重试几次
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
        if (!existsSync(dir)) return true;
      } catch {}
    }
    return !existsSync(dir);
  }

  /**
   * 清理上次失败卸载/安装遗留的损坏全局目录
   *
   * 新日志显示：npm uninstall 在 60s 超时被杀后，E:\npm-global\node_modules\@deepseek-ai\dsh
   * 残留半删除状态（node_modules 不完整、含 .DELETE. 临时文件），后续 npm install -g
   * 在同一目录上重装时疯狂报 TAR_ENTRY_ERROR / ENOTEMPTY / EPERM。
   * 因此在安装前主动识别并删除这类损坏目录，确保从干净状态重装。
   * @returns {Promise<{cleaned: boolean, reason: string|null}>}
   * @private
   */
  async _cleanupBrokenGlobalDSH() {
    try {
      // 直接按 npm root -g 定位全局 @deepseek-ai/dsh 目录，
      // 不依赖 getDSHPath()（package.json 已被删时该函数返回 null，会漏掉残留目录）
      let dshPath = null;
      try {
        const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000, windowsHide: true });
        if (globalRoot && globalRoot.trim()) {
          const candidate = join(globalRoot.trim(), '@deepseek-ai', 'dsh');
          if (existsSync(candidate)) dshPath = candidate;
        }
      } catch {}
      if (!dshPath) dshPath = await getDSHPath();
      if (!dshPath || !existsSync(dshPath)) return { cleaned: false, reason: null };

      let reason = null;
      // ① package.json 缺失/损坏 → 目录不完整
      const pkgFile = join(dshPath, 'package.json');
      if (!existsSync(pkgFile)) {
        reason = 'package.json 缺失';
      } else {
        try {
          JSON.parse(readFileSync(pkgFile, 'utf-8'));
        } catch {
          reason = 'package.json 损坏';
        }
      }
      // ② 存在 npm 清理残留的 .DELETE. 临时文件 → 上次卸载被中断
      if (!reason) {
        try {
          const entries = readdirSync(join(dshPath, 'node_modules'), { recursive: true });
          if (entries.some(e => e.includes('.DELETE.'))) {
            reason = '残留 .DELETE. 临时文件';
          }
        } catch {}
      }
      if (reason) {
        this._log(`检测到损坏的 DSH 全局目录（${reason}），安装前先清理: ${dshPath}`, 'warn');
        rmSync(dshPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
        // 同步清理 npm 全局 bin 中的 dsh 命令（Windows: dsh / dsh.cmd / dsh.ps1）
        try {
          const { stdout: globalRoot } = await execa('npm', ['root', '-g'], { reject: false, timeout: 10_000, windowsHide: true });
          if (globalRoot && globalRoot.trim()) {
            const prefix = dirname(globalRoot.trim());
            const bins = process.platform === 'win32'
              ? ['dsh', 'dsh.cmd', 'dsh.ps1', 'dsh.exe']
              : ['dsh'];
            for (const b of bins) {
              const bp = join(prefix, b);
              if (existsSync(bp)) rmSync(bp, { force: true, maxRetries: 5, retryDelay: 300 });
            }
          }
        } catch {}
        return { cleaned: true, reason };
      }
      return { cleaned: false, reason: null };
    } catch (error) {
      this._log(`清理损坏目录异常: ${error.message}`, 'warn');
      return { cleaned: false, reason: null };
    }
  }

  /**
   * 构建包含 pnpm 全局 bin 目录的 PATH 环境
   *
   * 新日志显示 pnpm 安装失败：`The configured global bin directory
   * "C:\Users\Administrator\AppData\Local\pnpm\bin" is not in PATH`。
   * pnpm v10 起要求全局 bin 目录在 PATH 中才允许 `pnpm add -g`，
   * 这里动态查询（pnpm config get global-bin-dir）并注入子进程 PATH，
   * 避免用户手动执行 `pnpm setup`。
   * @returns {Promise<object>} 注入后的环境变量
   * @private
   */
  async _pnpmPathEnv() {
    const env = { ...process.env };
    try {
      const { stdout } = await execa('pnpm', ['config', 'get', 'global-bin-dir'], {
        reject: false,
        timeout: 10_000,
        windowsHide: true,
      });
      const binDir = stdout ? stdout.trim() : '';
      if (binDir && existsSync(binDir)) {
        env.PATH = binDir + delimiter + (env.PATH || '');
        this._log(`已将 pnpm 全局 bin 目录加入 PATH: ${binDir}`);
      }
    } catch {}
    return env;
  }

  /** @private */
  async _getDSHPath() {
    // 复用 dsh-utils 的共享实现，避免重复
    return getDSHPath();
  }
}