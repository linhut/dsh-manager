/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * DoH（DNS over HTTPS）无污染解析模块
 *
 * 背景：多数机器 DNS 被污染（GFW 投毒或代理 fake-ip 接管），系统解析 github.com
 * 等域名得到错误/无效 IP，导致直连失败、超时。
 *
 * 方案：应用内置 DoH 解析真实 IP，用 node:https + lookup 直连（SNI 保持域名），
 * 作为候选序列新增一路。DoH 全失败时返回 null，调用方照常走镜像链，透明降级。
 *
 * 端点分为两类（实测验证，2026-09）：
 * - json 型：GET + Accept: application/dns-json，解析 Answer[].data（A 记录）
 *   - https://223.5.5.5/resolve（阿里，国内可达，最快）
 *   - https://dns.alidns.com/resolve（阿里域名入口）
 *   - https://dns.google/resolve（Google，部分网络可达）
 *   - https://cloudflare-dns.com/dns-query（Cloudflare，部分网络可达）
 * - wire 型：POST application/dns-message（标准 DoH wire format）
 *   - https://linhut.ddd.oaifree.com/query-dns（用户端点，实测可用）
 *
 * 边界：只做 IPv4（A 记录）解析；不做 hosts 写入；不接管系统 git。
 */

import https from 'node:https';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 动态读取版本号（避免 UA 硬编码漂移） */
const DOH_UA = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const v = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    return 'dsh-manager/' + (v || 'unknown');
  } catch {
    return 'dsh-manager/unknown';
  }
})();

/** DoH 端点列表（候选竞速，首个返回 IP 的端点胜出） */
export const DOH_ENDPOINTS = [
  { type: 'json', url: 'https://223.5.5.5/resolve?name={host}&type=A' },
  { type: 'json', url: 'https://dns.alidns.com/resolve?name={host}&type=A' },
  { type: 'json', url: 'https://dns.google/resolve?name={host}&type=A' },
  { type: 'json', url: 'https://cloudflare-dns.com/dns-query?name={host}&type=A' },
  { type: 'wire', url: 'https://linhut.ddd.oaifree.com/query-dns' },
];

/** 单个 DoH 端点超时（毫秒） */
const DOH_TIMEOUT = 5_000;
/** 解析结果缓存 TTL（毫秒） */
const CACHE_TTL = 300_000;
/** 竞速总超时（毫秒）——超过即放弃 DoH，返回 null 走降级 */
const RACE_TIMEOUT = 6_000;

/** @type {Map<string, { ips: string[], expires: number }>} */
const cache = new Map();
/** 并发去重：进行中的解析任务（Map<hostname, Promise>） */
const inflightCache = new Map();

/**
 * 发起 HTTPS 请求（内部工具）
 * @param {object} opts
 * @returns {Promise<{ status: number, buffer: Buffer }>}
 */
function httpsRequest({ hostname, port = 443, path, method = 'GET', headers = {}, body, timeout = 15_000, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      port,
      path,
      method,
      headers,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 查询 json 型 DoH 端点（GET + application/dns-json）
 * @param {string} endpointUrl - 含 {host} 占位符
 * @param {string} hostname
 * @returns {Promise<string[]>} IPv4 列表（可能为空）
 */
async function queryJsonEndpoint(endpointUrl, hostname) {
  const u = new URL(endpointUrl.replace('{host}', encodeURIComponent(hostname)));
  const { status, buffer } = await httpsRequest({
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: { Accept: 'application/dns-json', 'User-Agent': DOH_UA },
    timeout: DOH_TIMEOUT,
  });
  if (status !== 200) return [];
  const data = JSON.parse(buffer.toString('utf8'));
  const ips = (data.Answer || [])
    .filter((a) => a.type === 1 && typeof a.data === 'string')
    .map((a) => a.data);
  return ips;
}

/**
 * 构造 DNS wire format 查询（QTYPE=A, QCLASS=IN, RD=1）
 * @param {string} hostname
 * @returns {Buffer}
 */
export function buildDnsQuery(hostname) {
  const id = Buffer.from([0x12, 0x34]);
  const flags = Buffer.from([0x01, 0x00]); // RD=1
  // header 共 12 字节：ID(2)+Flags(2)+QD(2)+AN(2)+NS(2)+AR(2)
  const counts = Buffer.alloc(8);
  counts.writeUInt16BE(1, 0); // QDCOUNT=1
  const parts = [id, flags, counts];
  for (const label of hostname.split('.')) {
    const l = Buffer.from(label, 'ascii');
    parts.push(Buffer.from([l.length]), l);
  }
  parts.push(Buffer.from([0])); // 根
  const q = Buffer.alloc(4);
  q.writeUInt16BE(1, 0); // QTYPE=A
  q.writeUInt16BE(1, 2); // QCLASS=IN
  parts.push(q);
  return Buffer.concat(parts);
}

/**
 * 解析 DNS wire format 响应的 A 记录
 * @param {Buffer} buf
 * @returns {string[]} IPv4 列表
 */
export function parseDnsResponse(buf) {
  if (!buf || buf.length < 12) return [];
  const ancount = buf.readUInt16BE(6);
  if (ancount === 0) return [];
  let offset = 12;
  // 跳过 question 段：QNAME 标签序列 + 结尾 0 + QTYPE(2) + QCLASS(2)
  while (offset < buf.length && buf[offset] !== 0) {
    offset += 1 + buf[offset];
  }
  offset += 5;
  const ips = [];
  for (let i = 0; i < ancount && offset + 10 < buf.length; i++) {
    // NAME：指针（0xC0）或标签
    if ((buf[offset] & 0xc0) === 0xc0) {
      offset += 2;
    } else {
      while (offset < buf.length && buf[offset] !== 0) offset += 1 + buf[offset];
      offset += 1;
    }
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    offset += 2; // TYPE
    offset += 2; // CLASS
    offset += 4; // TTL
    const rdlen = buf.readUInt16BE(offset);
    offset += 2;
    if (type === 1 && rdlen === 4 && offset + 4 <= buf.length) {
      ips.push(`${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`);
    }
    offset += rdlen;
  }
  return ips;
}

/**
 * 查询 wire 型 DoH 端点（POST dns-message）
 * @param {string} endpointUrl
 * @param {string} hostname
 * @returns {Promise<string[]>} IPv4 列表（可能为空）
 */
async function queryWireEndpoint(endpointUrl, hostname) {
  const u = new URL(endpointUrl);
  const query = buildDnsQuery(hostname);
  const { status, buffer } = await httpsRequest({
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/dns-message',
      'Content-Length': query.length,
      'User-Agent': DOH_UA,
    },
    body: query,
    timeout: DOH_TIMEOUT,
  });
  if (status !== 200) return [];
  return parseDnsResponse(buffer);
}

/**
 * 通过 DoH 解析域名真实 IP（IPv4）
 *
 * 多端点并行竞速：首个返回 IP 列表的端点胜出；全部失败返回 null。
 * 结果缓存 TTL 300s。
 *
 * @param {string} hostname - 域名（如 github.com）
 * @param {object} [options]
 * @param {string[]} [options.endpoints] - 覆盖端点列表（测试用）
 * @param {number} [options.raceTimeoutMs] - 竞速总超时（默认 6000；热点路径可传更短预算）
 * @returns {Promise<string[] | null>} IPv4 列表；失败返回 null
 */
export async function resolveViaDoh(hostname, options = {}) {
  if (!hostname || typeof hostname !== 'string') return null;
  const key = hostname.trim().toLowerCase();
  if (!key) return null;

  // 缓存命中
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.ips;

  // 并发去重：同一域名并发解析复用同一个 in-flight Promise，避免重复竞速
  const inflight = inflightCache.get(key);
  if (inflight) return inflight;

  const endpoints = options.endpoints || DOH_ENDPOINTS;
  if (!endpoints.length) return null;

  // 竞速总超时：默认 RACE_TIMEOUT；调用方可传更短预算（热点路径避免阻塞）
  const raceTimeoutMs = options.raceTimeoutMs || RACE_TIMEOUT;

  const task = (async () => {
    // 竞速：任何一个端点成功返回 IP 即结束
    const result = await new Promise((resolve) => {
      let settled = false;
      let raceTimer = null; // 竞速兜底 timer（先声明，供 finish 清理）
      const finish = (ips) => {
        if (!settled) {
          settled = true;
          if (raceTimer) clearTimeout(raceTimer); // 提前完成时清理竞速兜底 timer
          resolve(ips);
        }
      };

      const jobs = endpoints.map((ep) => {
        const p = ep.type === 'wire'
          ? queryWireEndpoint(ep.url, key)
          : queryJsonEndpoint(ep.url, key);
        return p.then((ips) => { if (Array.isArray(ips) && ips.length) finish(ips); })
          .catch(() => {});
      });

      // 全部失败的兜底：等所有 settle 后 resolve(null)
      Promise.allSettled(jobs).then(() => finish(null));
      // 竞速总超时兜底（超时后由 finish 清理自身）
      raceTimer = setTimeout(() => finish(null), raceTimeoutMs);
    });

    if (result && result.length) {
      cache.set(key, { ips: result, expires: Date.now() + CACHE_TTL });
      return result;
    }
    return null;
  })();

  // 记录 in-flight，完成后移除
  inflightCache.set(key, task);
  task.finally(() => {
    if (inflightCache.get(key) === task) inflightCache.delete(key);
  }).catch(() => {});
  return task;
}

/**
 * 用 DoH 解析的真实 IP 直连 HTTPS 请求（SNI 保持域名）
 *
 * 替代全局 fetch（Electron 主进程 fetch 走 Chromium 栈，无法自定义 DNS）。
 * 返回 fetch 兼容响应：{ ok, status, statusText, headers, url, json(), text(), arrayBuffer() }
 *
 * @param {string} url - 原始 URL（如 https://api.github.com/...）
 * @param {object} [options]
 * @param {string} options.ip - DoH 解析的真实 IP（必填）
 * @param {number} [options.timeoutMs] - 超时（默认 15000）
 * @param {object} [options.headers] - 额外请求头
 * @param {string} [options.method] - HTTP 方法（默认 GET）
 * @param {Buffer|string} [options.body] - 请求体
 * @param {AbortSignal} [options.signal] - 取消信号
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, headers: object, url: string, json: () => Promise<any>, text: () => Promise<string> }>}
 */
export function fetchViaDoh(url, options = {}) {
  const { ip, timeoutMs = 15_000, headers = {}, method = 'GET', body, signal } = options;
  const u = new URL(url);
  if (!ip) return Promise.reject(new Error('fetchViaDoh: 缺少 ip 参数'));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ip,
      servername: u.hostname, // SNI 保持域名（关键：TLS 证书按域名验证）
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: { Host: u.host, 'User-Agent': DOH_UA, ...headers },
      lookup: (host, opts, cb) => cb(null, { address: ip, family: 4 }),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          url,
          json: async () => JSON.parse(buffer.toString('utf8')),
          text: async () => buffer.toString('utf8'),
          arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('直连超时')));
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * DoH 直连尝试：解析真实 IP 并直连，任何失败返回 null（不抛出）
 *
 * 供各调用点在现有候选竞速列表中追加一个 DoH 直连候选，
 * 与系统直连/镜像并行。失败自动降级，不影响原逻辑。
 *
 * @param {string} url - 原始 URL（如 https://api.github.com/...）
 * @param {object} [options] - 透传给 fetchViaDoh 的请求选项
 * @returns {Promise<object | null>} fetch 兼容响应；失败返回 null
 */
export async function tryFetchViaDoh(url, options = {}) {
  try {
    const hostname = new URL(url).hostname;
    // endpoints / raceTimeoutMs 透传（测试可注入本地端点；生产默认走 DOH_ENDPOINTS）
    const ips = await resolveViaDoh(hostname, { endpoints: options.endpoints, raceTimeoutMs: options.raceTimeoutMs });
    if (!ips || !ips.length) return null;
    return await fetchViaDoh(url, { ...options, ip: ips[0] });
  } catch {
    return null;
  }
}

/** 清空 DoH 解析缓存与 in-flight 任务（测试用） */
export function clearDohCache() {
  cache.clear();
  inflightCache.clear();
}
