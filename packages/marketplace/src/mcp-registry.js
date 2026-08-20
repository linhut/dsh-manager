/**
 * MCP 市场注册表（本地调试文件，不参与仓库同步）
 * 
 * 内置常用公共 MCP 服务器清单，供 MCP 市场页面展示与一键安装。
 * 数据来源：https://github.com/modelcontextprotocol/servers 等公开目录。
 * 
 * 说明：本文件仅作为本地开发调试的参考数据源，条目配置可能需要
 * 根据实际环境调整（如命令路径、参数、环境变量）。
 */

export const MCP_MARKET_REGISTRY = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: '读写访问本地文件系统（官方参考服务器）',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['filesystem', 'local', 'official'],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Git 仓库操作：clone、status、diff、log、commit 等',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['git', 'vcs', 'official'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub API 操作：仓库、Issues、PR、Actions',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['github', 'devops', 'official'],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: '基于知识图谱的持久记忆存储',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['memory', 'knowledge', 'official'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'HTTP 抓取与网页内容提取',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['web', 'http', 'official'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: '结构化、逐步的推理工具',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['thinking', 'reasoning', 'official'],
  },
  {
    id: 'everything',
    name: 'Everything',
    description: '参考测试服务器：MCP 所有特性演示（stdio 与 streamable-http 双格式）',
    category: 'official',
    transport: 'streamable-http',
    url: 'https://router.mcp.so/sse',
    install: { transport: 'streamable-http', url: 'https://router.mcp.so/sse' },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['test', 'demo', 'official', 'http'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: '浏览器自动化：网页操作、截图、表单填写',
    category: 'community',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    install: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    source: 'https://github.com/microsoft/playwright-mcp',
    tags: ['browser', 'automation', 'e2e'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: '无头 Chrome 浏览器自动化',
    category: 'community',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['browser', 'automation'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'SQLite 数据库操作：查询、建表、执行 SQL',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['database', 'sql', 'official'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'PostgreSQL 数据库操作（只读/读写）',
    category: 'community',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['database', 'postgres', 'sql'],
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Redis 缓存/键值存储操作',
    category: 'community',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-redis'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['database', 'redis', 'cache'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: '网络搜索（Brave Search API，需要环境变量 BRAVE_API_KEY）',
    category: 'community',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['search', 'web', 'brave'],
  },
  {
    id: 'time',
    name: 'Time',
    description: '时间和时区信息查询（官方演示）',
    category: 'official',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-time'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['time', 'utility', 'official'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Slack 工作区消息与频道管理',
    category: 'community',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    install: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['slack', 'chat', 'team'],
  },
  {
    id: 'mcp-remote',
    name: 'MCP Remote (SSE)',
    description: '远程 MCP 服务器（SSE 传输），通过配置 URL 连接',
    category: 'community',
    transport: 'streamable-http',
    url: 'https://mcp-demo.example.com/sse', // 示例地址，实际使用时请替换
    install: { transport: 'streamable-http', url: 'https://mcp-demo.example.com/sse' },
    source: 'https://github.com/modelcontextprotocol/servers',
    tags: ['remote', 'http', 'sse'],
  },
];

/**
 * 搜索 MCP 市场
 * @param {string} query - 搜索关键词
 * @param {string} [category] - 分类过滤（all/official/community）
 * @returns {Array}
 */
export function searchMcpMarket(query = '', category = 'all') {
  const q = String(query || '').toLowerCase().trim();
  return MCP_MARKET_REGISTRY.filter(item => {
    if (category !== 'all' && item.category !== category) return false;
    if (!q) return true;
    return (item.name || '').toLowerCase().includes(q)
      || (item.description || '').toLowerCase().includes(q)
      || (item.tags || []).some(t => t.toLowerCase().includes(q))
      || (item.id || '').toLowerCase().includes(q);
  });
}

/**
 * 获取 MCP 市场中某个条目的安装配置
 * @param {string} id
 * @returns {object|null}
 */
export function getMcpMarketItem(id) {
  return MCP_MARKET_REGISTRY.find(i => i.id === id) || null;
}

/**
 * 获取市场分类统计
 */
export function mcpMarketStats() {
  const stats = { official: 0, community: 0, total: MCP_MARKET_REGISTRY.length };
  for (const item of MCP_MARKET_REGISTRY) {
    stats[item.category] = (stats[item.category] || 0) + 1;
  }
  return stats;
}
