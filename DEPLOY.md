# DSH Manager 官网部署指南

## 目录结构

```
website/
├── index.html          # 首页
├── assets/
│   ├── css/style.css   # 样式（明暗双主题）
│   └── js/main.js      # 交互逻辑
```

纯静态站点，零后端依赖，可直接用 nginx / Caddy / Apache / 对象存储等托管。

---

## 方式一：nginx 部署（推荐）

### 1. 上传代码

将 `website/` 目录下的所有文件上传到服务器，例如 `/var/www/dsh-manager/`。

### 2. nginx 配置

创建 `/etc/nginx/sites-available/dsh-manager.conf`：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名

    root /var/www/dsh-manager;
    index index.html;

    # 开启 gzip 压缩
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 256;

    # 静态资源缓存
    location /assets/ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # 单页应用路由：所有非文件请求返回 index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

### 3. 启用站点（Ubuntu/Debian）

```bash
sudo ln -s /etc/nginx/sites-available/dsh-manager.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. 配置 HTTPS（推荐）

使用 Certbot 自动获取 Let's Encrypt 证书：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 方式二：Docker + nginx

创建 `Dockerfile`：

```dockerfile
FROM nginx:alpine
COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

创建 `nginx.conf`：

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /assets/ { expires 7d; add_header Cache-Control "public, immutable"; }
}
```

构建运行：

```bash
docker build -t dsh-manager-site .
docker run -d -p 80:80 --name dsh-manager-site dsh-manager-site
```

---

## 方式三：GitHub Pages（免费）

如果不想自建服务器，可直接用 GitHub Pages：

1. 在 GitHub 创建一个新仓库，如 `yourname/dsh-manager-site`
2. 将 `website/` 内容推送到该仓库的 `main` 分支
3. 仓库 Settings → Pages → 选择 `main` 分支 `/root`
4. 访问 `https://yourname.github.io/dsh-manager-site`

---

## 域名配置

### 方式一：使用 GitHub Pages 自定义域名

1. 在你的域名 DNS 管理中添加 CNAME 记录，指向 `yourname.github.io`
2. 在仓库 Settings → Pages → Custom domain 中输入你的域名
3. 在 `website/` 根目录创建 `CNAME` 文件，内容为你的域名

### 方式二：自建服务器

1. 在 DNS 管理中添加 A 记录指向你的服务器 IP，或 CNAME 指向你的 CDN
2. 按上方 nginx 配置设置反向代理

---

## 验证部署

访问 `https://your-domain.com` 检查：

- [x] 页面正常加载
- [x] 明暗主题切换正常
- [x] 插件市场加载正常（显示 GitHub 上 dsh-plugin 标签的仓库）
- [x] 移动端响应式布局正常
- [x] HTTPS 证书有效（如果配置了）