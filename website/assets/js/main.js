/**
 * DSH Manager Website - Main JavaScript
 * 
 * 功能：插件市场搜索、统计数据加载、导航控制、复制功能
 */

// ========== Navigation ==========
document.addEventListener('DOMContentLoaded', () => {
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');

  if (navToggle) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.toggle('active');
    });
  }

  // Close mobile nav on link click
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('active');
    });
  });

  // Navbar scroll effect
  let lastScroll = 0;
  window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    const currentScroll = window.pageYOffset;
    
    if (currentScroll > 100) {
      navbar.style.background = 'rgba(11, 13, 23, 0.95)';
    } else {
      navbar.style.background = 'rgba(11, 13, 23, 0.8)';
    }
    
    lastScroll = currentScroll;
  });

  // Load GitHub stats
  loadGitHubStats();
  
  // Load initial plugins
  loadPlugins('');

  // Animate stats on scroll
  animateStats();
});

// ========== GitHub Stats ==========
async function loadGitHubStats() {
  try {
    const response = await fetch('https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=100');
    const data = await response.json();
    
    // Count total plugins
    const pluginCount = data.items?.length || 0;
    animateNumber('statPlugins', pluginCount);
    
    // Calculate total stars (approximate)
    const totalStars = data.items?.reduce((sum, repo) => sum + repo.stargazers_count, 0) || 0;
    animateNumber('statStars', totalStars);
    
    // Download count (use stars as proxy)
    const downloads = totalStars * 10;
    animateNumber('statDownloads', downloads);
  } catch (error) {
    console.log('Stats loading deferred (GitHub API may be rate-limited)');
    // Set default values
    document.getElementById('statStars').textContent = '10+';
    document.getElementById('statPlugins').textContent = '5+';
    document.getElementById('statDownloads').textContent = '100+';
  }
}

function animateNumber(elementId, target) {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  let current = 0;
  const increment = Math.ceil(target / 30);
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) {
      current = target;
      clearInterval(timer);
    }
    element.textContent = current >= 1000 ? `${(current / 1000).toFixed(1)}k` : current;
  }, 50);
}

// ========== Plugin Search ==========
let searchTimeout = null;

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query = document.getElementById('pluginSearch').value.trim();
    loadPlugins(query);
  }, 300);
}

async function loadPlugins(query) {
  const grid = document.getElementById('pluginGrid');
  if (!grid) return;

  // Show skeleton
  grid.innerHTML = `
    <div class="plugin-card skeleton">
      <div class="skeleton-line w-60"></div>
      <div class="skeleton-line w-80"></div>
      <div class="skeleton-line w-40"></div>
    </div>
    <div class="plugin-card skeleton">
      <div class="skeleton-line w-60"></div>
      <div class="skeleton-line w-80"></div>
      <div class="skeleton-line w-40"></div>
    </div>
    <div class="plugin-card skeleton">
      <div class="skeleton-line w-60"></div>
      <div class="skeleton-line w-80"></div>
      <div class="skeleton-line w-40"></div>
    </div>
  `;

  try {
    let url = 'https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=30';
    
    if (query) {
      url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+topic:dsh-plugin&sort=stars&order=desc&per_page=30`;
    }

    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.items || data.items.length === 0) {
      grid.innerHTML = `
        <div class="no-results" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
          <p style="font-size: 3rem; margin-bottom: 16px;">🔍</p>
          <p style="font-size: 1.1rem;">未找到相关插件</p>
          <p style="font-size: 0.9rem; margin-top: 8px;">尝试其他关键词，或在 GitHub 上标记你的仓库为 <code>dsh-plugin</code></p>
        </div>
      `;
      return;
    }

    // Display plugins
    grid.innerHTML = data.items.slice(0, 30).map(repo => `
      <div class="plugin-card">
        <div class="plugin-card-header">
          <a href="${repo.html_url}" target="_blank" class="plugin-name">${repo.full_name}</a>
          <span class="plugin-stars">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="#F59E0B"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>
            ${repo.stargazers_count}
          </span>
        </div>
        <p class="plugin-desc">${repo.description || '暂无描述'}</p>
        <div class="plugin-meta">
          ${repo.language ? `<span>${repo.language}</span>` : ''}
          <span>${repo.open_issues_count} issues</span>
          <span>${repo.forks_count} forks</span>
        </div>
        <div style="margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap;">
          ${(repo.topics || []).slice(0, 3).map(tag => 
            `<span class="plugin-tag">${tag}</span>`
          ).join('')}
        </div>
        <button class="plugin-install-btn" onclick="showInstallCmd('${repo.full_name}')">
          📥 安装命令
        </button>
      </div>
    `).join('');

  } catch (error) {
    grid.innerHTML = `
      <div class="no-results" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p style="font-size: 3rem; margin-bottom: 16px;">⚠️</p>
        <p style="font-size: 1.1rem;">暂时无法加载插件数据</p>
        <p style="font-size: 0.9rem; margin-top: 8px; color: var(--text-dim);">${error.message}</p>
        <p style="font-size: 0.9rem; margin-top: 8px;">
          请直接访问 
          <a href="https://github.com/topics/dsh-plugin" target="_blank" style="color: var(--primary-light);">GitHub dsh-plugin 主题</a>
        </p>
      </div>
    `;
  }
}

function showInstallCmd(fullName) {
  const cmd = `dshm install plugin github:${fullName}`;
  
  // Create a temporary input
  const input = document.createElement('input');
  input.value = cmd;
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
  
  // Show feedback
  const btn = event.target;
  const originalText = btn.textContent;
  btn.textContent = '✅ 已复制';
  setTimeout(() => {
    btn.textContent = originalText;
  }, 2000);
}

// ========== Copy Code ==========
function copyCode(btn) {
  const code = btn.parentElement.querySelector('code');
  const text = code.textContent.trim();
  
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✅ 已复制';
    btn.classList.add('copied');
    
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    
    btn.textContent = '✅ 已复制';
    setTimeout(() => {
      btn.textContent = '复制';
    }, 2000);
  });
}

// ========== Stats Animation on Scroll ==========
function animateStats() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.stat').forEach(stat => {
    stat.style.opacity = '0';
    stat.style.transform = 'translateY(20px)';
    stat.style.transition = 'all 0.6s ease-out';
    observer.observe(stat);
  });
}

// ========== Smooth Scroll for Anchor Links ==========
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function(e) {
    const href = this.getAttribute('href');
    if (href === '#') return;
    
    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ========== Console Easter Egg ==========
console.log('%c⚡ DSH Manager', 'font-size: 24px; font-weight: bold; color: #4F46E5;');
console.log('%cDeepSeek Harness 管理工具', 'font-size: 14px; color: #9CA3AF;');
console.log('%cGitHub: https://github.com/dsh-manager/dsh-manager', 'font-size: 12px; color: #6B7280;');