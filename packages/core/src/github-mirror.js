/**
 * DSH Manager
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * GitHub 后备中转代理（国内网络访问 GitHub 不畅时自动切换）
 * 
 * 用法：代理前缀 + 原始 URL
 * 例如 https://gh-proxy.com/https://github.com/owner/repo.git
 * 
 * 渠道精简原则（经实测验证，2026-09）：
 * - 只保留真实可用且快的镜像，避免多渠道冗余：
 *   - gh-proxy.com：老牌稳定，支持 API/raw/git clone/release
 *   - cdn.gh-proxy.org / edgeone.gh-proxy.org：gh-proxy.org 的最快节点
 * - 已剔除实测超时/限流的：ghfast.top、ghproxy.net、mirror.ghproxy.com、
 *   github.moeyy.xyz、gh-proxy.net（429）、hk.gh-proxy.org（过慢）、
 *   github.akams.cn（是前端网站，不是代理端点）
 * - 多个候选并行竞速，取最快成功响应，坏节点自然淘汰
 */
export const GITHUB_PROXIES = [
  'https://gh-proxy.com/',
  'https://cdn.gh-proxy.org/',
  'https://edgeone.gh-proxy.org/',
];

/**
 * 将 GitHub 相关 URL 转换为代理地址
 * 
 * 返回 [原始URL, 代理1, 代理2, ...] 的数组，用于并行竞速。
 * 代理 URL 格式：https://gh-proxy.com/https://github.com/...
 * 
 * @param {string} url - 原始 URL
 * @returns {string[]} 原始 URL + 各代理 URL（去重）
 */
export function githubProxyUrls(url) {
  const result = [url];
  for (const proxy of GITHUB_PROXIES) {
    const proxied = proxy + url;
    if (!result.includes(proxied)) result.push(proxied);
  }
  return result;
}
