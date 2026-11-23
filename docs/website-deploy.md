<!--
DSH Manager
(c) 2026 Jose AI (https://www.linhut.cn)
https://github.com/linhut/dsh-manager
Licensed under the MIT License. See the LICENSE file for details.
-->

# 官网云服务器部署指南

> 将官网（`website/` 纯静态站）部署到自有云服务器（Nginx + HTTPS）。
> **服务器仅托管官网页面，不存储安装包**：下载与自动更新继续走 GitHub Releases（见文末说明）。

## 一、部署架构

| 内容 | 位置 | 说明 |
|------|------|------|
| 官网页面 | 云服务器 Nginx 静态托管 | `website/` 整目录（HTML/CSS/JS，无构建步骤） |
| 安装包下载 | GitHub Releases | 官网按钮指向 `releases/latest`，自动跟随最新正式版 |
| 应用内自动更新 | GitHub provider | electron-updater 读取打包内的 `app-update.yml`（linhut/dsh-manager） |

## 二、准备服务器

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx

# CentOS / AlmaLinux / 麒麟 / UOS
sudo dnf install -y nginx certbot python3-certbot-nginx
# 或 yum install -y nginx certbot
```

1. 域名解析：在 DNS 服务商为你的域名添加 A 记录，指向云服务器公网 IP（如官网用 `www.linhut.cn` 或子域 `site.linhut.cn`）。
2. 放行端口：安全组 / 防火墙开放 80 与 443。

## 三、Nginx 配置

1. 复制配置模板：`website/nginx.conf.example`
2. 替换其中 `<your-domain>` 与证书路径占位符
3. 安装到服务器：

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/dsh-manager
sudo sed -i 's/<your-domain>/你的域名/g' /etc/nginx/sites-available/dsh-manager
sudo ln -s /etc/nginx/sites-available/dsh-manager /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 四、HTTPS 证书（Let's Encrypt）

```bash
# 若已按第三节配置好 80 端口站点，certbot 自动改写并续期
sudo certbot --nginx -d 你的域名
```

证书每 90 天自动续期（certbot 定时任务默认启用）。

## 五、部署官网（同步 website/ 到服务器）

使用仓库内置脚本 `scripts/deploy-website.mjs`：

```bash
# 全量同步（默认 scp，Windows Git Bash 可用）
node scripts/deploy-website.mjs --host root@1.2.3.4 --path /var/www/dsh-manager/website

# 增量同步（服务器与本地装有 rsync 时推荐：增量、删除、排除 Thumbs.db）
node scripts/deploy-website.mjs --host root@1.2.3.4 --path /var/www/dsh-manager/website --rsync

# 演练：只看将执行的命令，不真正同步
node scripts/deploy-website.mjs --host root@1.2.3.4 --path /var/www/dsh-manager/website --dry-run
```

也可用环境变量免输参数：`DSH_DEPLOY_HOST`、`DSH_DEPLOY_PATH`。

## 六、验证

```bash
curl -I https://你的域名/                 # 200 + text/html
curl -I https://你的域名/assets/css/style.css   # 200 + 缓存头
curl -I https://你的域名/#download        # 锚点正常（页面可滚动到下载区）
```

浏览器打开官网：
- 过渡效果（Hero 错峰入场、滚动揭示、ScrollSpy 高亮等）全部生效——纯前端 CSS/JS，静态托管直接支持；
- 「GitHub 直连下载 / 加速镜像」按钮跳转 `releases/latest`，跟随最新正式版安装包（v2.0.1）。

## 七、下载与自动更新说明

- **服务器不存储安装包**：官网下载按钮与应用内自动更新均保持 GitHub Releases（`linhut/dsh-manager`），无需在服务器配置更新目录。
- 最新版安装包完整性已验证：`latest.yml` 的 SHA-512 与实际安装包匹配，应用内 `electron-updater` 已接入（静默下载 + 提示重启安装，每 4 小时检查一次）。
- 未来如想将**更新源也切到服务器**（国内下载更快）：需在服务器托管安装包 + `latest.yml` + `.blockmap`，并把 `package.json` 的 `build.publish` 改为 `{ "provider": "generic", "url": "https://你的域名/updates" }` 后重新发布。届时再联系扩展。
