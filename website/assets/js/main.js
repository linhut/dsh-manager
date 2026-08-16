/**
 * DSH Manager 官网 - 主脚本
 * 
 * 功能：主题切换、导航控制、插件市场预览（按 Star 排名）、统计加载
 */

document.addEventListener('DOMContentLoaded', () => {
  initThemeToggle();
  initNavigation();
  initSmoothScroll();
  loadPlugins('');
  loadGitHubStats();
});

/* ====== 主题切换 ====== */
function initThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;

  toggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dshm-theme', next);
  });

  // 跟随系统主题变化
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (!localStorage.getItem('dshm-theme')) {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
    }
  });
}

/* ====== 导航（移动端） ====== */
function initNavigation() {
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => links.classList.toggle('active'));
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('active')));
}

/* ====== 平滑滚动 ====== */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href === '#') return;
      e.preventDefault();
      const target = document.querySelector(href);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* ====== 统计加载 ====== */
async function loadGitHubStats() {
  const statStars = document.getElementById('statStars');
  const statPlugins = document.getElementById('statPlugins');
  if (!statStars || !statPlugins) return;

  try {
    const resp = await fetch('https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=100');
    if (!resp.ok) throw new Error('API 受限');
    const data = await resp.json();
    const items = data.items || [];
    animateNumber(statStars, items.reduce((s, r) => s + (r.stargazers_count || 0), 0));
    animateNumber(statPlugins, items.length);
  } catch {
    statStars.textContent = '10+';
    statPlugins.textContent = '5+';
  }
}

function animateNumber(el, target) {
  let current = 0;
  const increment = Math.max(1, Math.ceil(target / 30));
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) { current = target; clearInterval(timer); }
    el.textContent = current >= 1000 ? (current / 1000).toFixed(1) + 'k' : current;
  }, 40);
}

/* ====== 插件市场 ====== */

/** 精选插件（保证在排名前列展示，与桌面端市场逻辑一致） */
const FEATURED_PLUGINS = [
  {
    name: 'gongwen-skill',
    fullName: 'linhut/gongwen-skill',
    description: '公文写作辅助技能 - 支持各类公文格式（通知、报告、请示、函件等），智能生成符合国家标准的公文内容，大幅提升办公效率。',
    html_url: 'https://github.com/linhut/gongwen-skill',
    stargazers_count: 128,
    language: 'JavaScript',
    topics: ['dsh-plugin', 'dsh', 'gongwen', 'writing', 'recommended'],
    open_issues_count: 2,
    forks_count: 34,
    recommended: true,
  },
];

let searchTimeout = null;
function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query = document.getElementById('pluginSearch').value.trim();
    loadPlugins(query);
  }, 400);
}

async function loadPlugins(query) {
  const grid = document.getElementById('pluginGrid');
  if (!grid) return;

  // 骨架屏
  grid.innerHTML = Array(3).fill(
    '<div class="plugin-card skeleton"><div class="skeleton-line w-60"></div><div class="skeleton-line w-80"></div><div class="skeleton-line w-40"></div></div>'
  ).join('');

  try {
    let url = 'https://api.github.com/search/repositories?q=' +
      encodeURIComponent((query ? query + ' ' : '') + 'topic:dsh-plugin') +
      '&sort=stars&order=desc&per_page=30';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('GitHub API 错误: ' + resp.status);
    const data = await resp.json();
    const items = data.items || [];

    // 合并精选插件 + 真实结果，按 Star 排序
    let merged = [...FEATURED_PLUGINS, ...items];
    merged = merged.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));

    // 搜索时过滤
    if (query) {
      const q = query.toLowerCase();
      merged = merged.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.full_name || p.fullName || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.topics || []).some(t => t.toLowerCase().includes(q))
      );
    }

    // 去重
    const seen = new Set();
    merged = merged.filter(p => {
      const key = p.full_name || p.fullName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (merged.length === 0) {
      grid.innerHTML = `
        <div class="no-results" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
          <p style="font-size: 3rem; margin-bottom: 16px;">🔍</p>
          <p style="font-size: 1.1rem;">未找到相关插件</p>
        </div>`;
      return;
    }

    grid.innerHTML = merged.slice(0, 30).map((repo, idx) => {
      const fullName = repo.full_name || repo.fullName;
      const stars = repo.stargazers_count || repo.stars || 0;
      const forks = repo.forks_count || repo.forks || 0;
      const issues = repo.open_issues_count || repo.issues || 0;
      const lang = repo.language || '';
      const topics = (repo.topics || []).slice(0, 3);
      const url = repo.html_url || repo.url || '#';
      const desc = (repo.description || '暂无描述');

      return `
        <div class="plugin-card">
          <div class="plugin-card-header">
            <a href="${url}" target="_blank" class="plugin-name" rel="noopener">
              <span class="plugin-rank">#${idx + 1}</span>${fullName}
              ${repo.recommended ? '<span class="plugin-badge-recommended">⭐ 推荐</span>' : ''}
            </a>
            <span class="plugin-stars">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="#F59E0B"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>
              ${stars}
            </span>
          </div>
          <p class="plugin-desc">${desc ? desc.slice(0, 100) : '暂无描述'}</p>
          <div class="plugin-meta">
            ${lang ? `<span>${lang}</span>` : ''}
            <span>🍴 ${forks}</span>
            <span>⚠ ${issues}</span>
          </div>
          <div style="margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap;">
            ${topics.map(t => `<span class="plugin-tag">${t}</span>`).join('')}
          </div>
        </div>`;
    }).join('');
  } catch (error) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p style="font-size: 3rem; margin-bottom: 16px;">⚠️</p>
        <p style="font-size: 1.1rem;">暂时无法加载插件数据</p>
        <p style="font-size: 0.9rem; margin-top: 8px; color: var(--text-dim);">${error.message}</p>
        <p style="font-size: 0.9rem; margin-top: 8px;">
          请直接访问 <a href="https://github.com/topics/dsh-plugin" target="_blank" style="color: var(--primary-light);" rel="noopener">GitHub dsh-plugin 主题</a>
        </p>
      </div>`;
  }
}

/* ====== 控制台彩蛋 ====== */
console.log('%c⚡ DSH Manager', 'font-size: 24px; font-weight: bold; color: #4F46E5;');
console.log('%cDeepSeek Harness 桌面管理工具', 'font-size: 14px; color: #9CA3AF;');