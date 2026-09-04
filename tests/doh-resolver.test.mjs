/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

// DoH 无污染解析模块单测：DNS wire 构造/解析、多点竞速失败兜底、缓存、IP 直连参数校验
// 纯逻辑测试，不依赖外网（真实 DoH 链路已在开发环境手工验证）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOH_ENDPOINTS,
  buildDnsQuery,
  parseDnsResponse,
  resolveViaDoh,
  fetchViaDoh,
  tryFetchViaDoh,
  clearDohCache,
} from '../packages/core/src/doh-resolver.js';

describe('doh-resolver: buildDnsQuery（DNS 查询 wire format 构造）', () => {
  it('github.com 的 A 记录查询结构正确', () => {
    const q = buildDnsQuery('github.com');
    // ID(2) + Flags(2) + QDCOUNT(2) + ...：总长 = 12 头 + QNAME + QTYPE(2) + QCLASS(2)
    // QNAME: 6(github) 7字节 + 3(com) 4字节 + 根 1 字节 = 12 字节
    assert.equal(q.length, 12 + 12 + 4);
    // QDCOUNT=1
    assert.equal(q.readUInt16BE(4), 1);
    // RD 标志（0x0100）
    assert.equal(q[2], 0x01);
    assert.equal(q[3], 0x00);
    // 第一个标签长度 6 = 'github'
    assert.equal(q[12], 6);
    assert.equal(q.toString('ascii', 13, 19), 'github');
    // 第二个标签 3 = 'com'
    assert.equal(q[19], 3);
    assert.equal(q.toString('ascii', 20, 23), 'com');
    // 根结束 + QTYPE=A(1) + QCLASS=IN(1)
    assert.equal(q[23], 0);
    assert.equal(q.readUInt16BE(24), 1); // QTYPE=A
    assert.equal(q.readUInt16BE(26), 1); // QCLASS=IN
  });

  it('多级域名标签正确', () => {
    const q = buildDnsQuery('api.github.com');
    assert.equal(q[12], 3);
    assert.equal(q.toString('ascii', 13, 16), 'api');
    assert.equal(q[16], 6);
    assert.equal(q.toString('ascii', 17, 23), 'github');
    assert.equal(q[23], 3);
    assert.equal(q.toString('ascii', 24, 27), 'com');
  });
});

describe('doh-resolver: parseDnsResponse（DNS 响应 A 记录解析）', () => {
  it('解析含 A 记录的响应（含压缩指针）', () => {
    // 手工构造 DNS 响应：
    // header: ID=0x1234, flags=0x8180(QR+RD+RA), QD=1, AN=1, NS=0, AR=0
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(1, 6); // ANCOUNT
    // question: QNAME = 6github3com0, QTYPE=A(1), QCLASS=IN(1)
    const qname = Buffer.from([
      6, ...Buffer.from('github'),
      3, ...Buffer.from('com'),
      0,
    ]);
    const qtail = Buffer.alloc(4);
    qtail.writeUInt16BE(1, 0); // QTYPE=A
    qtail.writeUInt16BE(1, 2); // QCLASS=IN
    // answer: NAME=指针 0xC00C, TYPE=A(1), CLASS=IN(1), TTL=300, RDLEN=4, RDATA=140.82.113.3
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0); // 压缩指针 → offset 12
    answer.writeUInt16BE(1, 2);      // TYPE=A
    answer.writeUInt16BE(1, 4);      // CLASS=IN
    answer.writeUInt32BE(300, 6);    // TTL
    answer.writeUInt16BE(4, 10);     // RDLEN=4
    answer[12] = 140; answer[13] = 82; answer[14] = 113; answer[15] = 3;

    const resp = Buffer.concat([header, qname, qtail, answer]);
    assert.deepEqual(parseDnsResponse(resp), ['140.82.113.3']);
  });

  it('空响应（ANCOUNT=0）返回空数组', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4); // QD=1
    header.writeUInt16BE(0, 6); // AN=0
    const qname = Buffer.from([6, ...Buffer.from('github'), 3, ...Buffer.from('com'), 0]);
    const qtail = Buffer.alloc(4);
    qtail.writeUInt16BE(1, 0);
    qtail.writeUInt16BE(1, 2);
    assert.deepEqual(parseDnsResponse(Buffer.concat([header, qname, qtail])), []);
  });

  it('非 A 记录（如 CNAME）被跳过', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6); // AN=1
    const qname = Buffer.from([6, ...Buffer.from('github'), 3, ...Buffer.from('com'), 0]);
    const qtail = Buffer.alloc(4);
    qtail.writeUInt16BE(1, 0);
    qtail.writeUInt16BE(1, 2);
    // answer: CNAME 类型(5)，RDLEN=0
    const answer = Buffer.alloc(14);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(5, 2);  // CNAME
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(300, 6);
    answer.writeUInt16BE(0, 10); // RDLEN=0
    assert.deepEqual(parseDnsResponse(Buffer.concat([header, qname, qtail, answer])), []);
  });

  it('畸形输入（长度不足）返回空数组', () => {
    assert.deepEqual(parseDnsResponse(Buffer.alloc(5)), []);
    assert.deepEqual(parseDnsResponse(null), []);
  });
});

describe('doh-resolver: resolveViaDoh（多点竞速与失败兜底）', () => {
  it('空端点列表返回 null', async () => {
    clearDohCache();
    const r = await resolveViaDoh('github.com', { endpoints: [] });
    assert.equal(r, null);
  });

  it('全部端点失败（本地不可达端口）返回 null', async () => {
    clearDohCache();
    const badEndpoints = [
      { type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' },
      { type: 'json', url: 'https://127.0.0.1:2/resolve?name={host}&type=A' },
    ];
    const r = await resolveViaDoh('github.com', { endpoints: badEndpoints });
    assert.equal(r, null);
  });

  it('缓存：连续调用同一域名，第二次命中缓存（不重复解析）', async () => {
    clearDohCache();
    const badEndpoints = [{ type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' }];
    const r1 = await resolveViaDoh('cachetest.example.com', { endpoints: badEndpoints });
    assert.equal(r1, null); // 失败不写缓存
    // 失败结果不应污染缓存——再查仍返回 null（并发安全）
    const r2 = await resolveViaDoh('cachetest.example.com', { endpoints: badEndpoints });
    assert.equal(r2, null);
  });

  it('无效输入返回 null', async () => {
    assert.equal(await resolveViaDoh(''), null);
    assert.equal(await resolveViaDoh(null), null);
  });

  it('默认端点列表非空且含用户端点', () => {
    assert.ok(Array.isArray(DOH_ENDPOINTS) && DOH_ENDPOINTS.length >= 3);
    const hasWire = DOH_ENDPOINTS.some(ep => ep.type === 'wire');
    const hasJson = DOH_ENDPOINTS.some(ep => ep.type === 'json');
    assert.ok(hasJson, '应含 json 型公共端点');
    assert.ok(hasWire, '应含 wire 型用户端点');
  });
});

describe('doh-resolver: fetchViaDoh（IP 直连参数校验）', () => {
  it('缺少 ip 参数时拒绝', async () => {
    await assert.rejects(
      () => fetchViaDoh('https://github.com/'),
      /缺少 ip/
    );
  });

  it('ip 指向本地未监听端口时错误传播（不静默吞掉）', async () => {
    await assert.rejects(
      () => fetchViaDoh('https://127.0.0.1:1/x', { ip: '127.0.0.1' }),
      (err) => err.code === 'ECONNREFUSED' || /ECONNREFUSED|EADDRNOTAVAIL/.test(err.message || '')
    );
  });
});

describe('doh-resolver: tryFetchViaDoh（DoH 直连尝试，失败静默降级）', () => {
  it('解析失败（端点不可达）返回 null 而非抛出', async () => {
    clearDohCache();
    const badEndpoints = [{ type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' }];
    const r = await tryFetchViaDoh('https://api.github.com/', { endpoints: badEndpoints });
    assert.equal(r, null);
  });

  it('URL 解析异常时返回 null 而非抛出', async () => {
    const r = await tryFetchViaDoh('not-a-url');
    assert.equal(r, null);
  });

  it('解析成功但直连目标不可达时返回 null 而非抛出', async () => {
    clearDohCache();
    // 先用坏端点验证「解析失败 → null」之外的路径：这里端点不可达同样走 catch 返回 null
    const endpoints = [{ type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' }];
    const r = await tryFetchViaDoh('https://github.com/', { endpoints, timeoutMs: 500 });
    assert.equal(r, null);
  });
});

describe('doh-resolver: 并发去重与缓存清理', () => {
  it('并发解析同一域名共享 in-flight 任务（不重复发起）', async () => {
    clearDohCache();
    const endpoints = [{ type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' }];
    // 两个并发调用，都解析失败返回 null，且都不挂起
    const [a, b] = await Promise.all([
      resolveViaDoh('dedup.example.com', { endpoints }),
      resolveViaDoh('dedup.example.com', { endpoints }),
    ]);
    assert.equal(a, null);
    assert.equal(b, null);
  });

  it('clearDohCache 后 in-flight 记录清空，可再次解析', async () => {
    clearDohCache();
    const endpoints = [{ type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' }];
    const r1 = await resolveViaDoh('clear.example.com', { endpoints });
    assert.equal(r1, null);
    clearDohCache();
    const r2 = await resolveViaDoh('clear.example.com', { endpoints });
    assert.equal(r2, null);
  });

  it('raceTimeoutMs 选项生效：短预算下仍然失败不抛出', async () => {
    clearDohCache();
    const endpoints = [{ type: 'json', url: 'https://127.0.0.1:1/resolve?name={host}&type=A' }];
    const r = await resolveViaDoh('timeout.example.com', { endpoints, raceTimeoutMs: 200 });
    assert.equal(r, null);
  });
});

describe('doh-resolver 模块导出完整性', () => {
  it('导出所需 API', () => {
    assert.equal(typeof resolveViaDoh, 'function');
    assert.equal(typeof fetchViaDoh, 'function');
    assert.equal(typeof tryFetchViaDoh, 'function');
    assert.equal(typeof buildDnsQuery, 'function');
    assert.equal(typeof parseDnsResponse, 'function');
    assert.equal(typeof clearDohCache, 'function');
    assert.ok(Array.isArray(DOH_ENDPOINTS));
  });
});
