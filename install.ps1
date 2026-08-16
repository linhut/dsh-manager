#!/usr/bin/env pwsh
<#
.SYNOPSIS
    DSH Manager 一键安装脚本
.DESCRIPTION
    自动检测环境并安装 DSH Manager，无需任何编程知识
    适用于 Windows 10/11
#>

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

# 颜色定义
$Colors = @{
    Green = "Green"
    Cyan = "Cyan"
    Yellow = "Yellow"
    Red = "Red"
    Gray = "Gray"
}

function Write-Color($Text, $Color) {
    Write-Host $Text -ForegroundColor $Color
}

function Write-Step($Num, $Text) {
    Write-Host "`n[$Num/5] $Text" -ForegroundColor Cyan
}

function Write-Success($Text) {
    Write-Host "✅ $Text" -ForegroundColor Green
}

function Write-Warning($Text) {
    Write-Host "⚠️  $Text" -ForegroundColor Yellow
}

function Write-Error($Text) {
    Write-Host "❌ $Text" -ForegroundColor Red
}

Clear-Host

Write-Host @"

╔══════════════════════════════════════════════════╗
║                                                  ║
║   ⚡ DSH Manager 一键安装脚本                      ║
║                                                  ║
║   DeepSeek Harness 安装与管理工具                  ║
║                                                  ║
╚══════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

Write-Host "本工具将自动完成以下步骤：" -ForegroundColor Gray
Write-Host "  1. 检查系统环境" -ForegroundColor Gray
Write-Host "  2. 安装 Node.js（如需要）" -ForegroundColor Gray
Write-Host "  3. 安装 DSH Manager" -ForegroundColor Gray
Write-Host "  4. 安装 DeepSeek Harness" -ForegroundColor Gray
Write-Host "  5. 启动管理界面" -ForegroundColor Gray
Write-Host ""

# 检查是否以管理员身份运行
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Step 1 "检查系统环境"

# 检查 Node.js
$nodeVersion = $null
try {
    $nodeVersion = node --version 2>$null
} catch {}

if ($nodeVersion) {
    $majorVersion = [int]($nodeVersion -replace '[^0-9]', '').Substring(0,2)
    Write-Success "Node.js 已安装: $nodeVersion"
    if ($majorVersion -lt 18) {
        Write-Warning "Node.js 版本过低，需要 >= 18，准备升级..."
        $nodeVersion = $null
    }
} else {
    Write-Warning "未检测到 Node.js，准备自动安装..."
}

# 检测系统架构
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
Write-Host "  系统架构: $arch" -ForegroundColor Gray

# 检测 PowerShell 版本
$psVersion = $PSVersionTable.PSVersion
Write-Host "  PowerShell 版本: $psVersion" -ForegroundColor Gray

# ===== 安装 Node.js =====
if (-not $nodeVersion) {
    Write-Step 2 "安装 Node.js"
    
    Write-Host "  正在下载 Node.js 安装程序..." -ForegroundColor Yellow
    
    $nodeUrl = "https://nodejs.org/dist/v20.18.3/node-v20.18.3-x64.msi"
    $installerPath = "$env:TEMP\node-installer.msi"
    
    try {
        # 下载 Node.js
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($nodeUrl, $installerPath)
        
        Write-Success "下载完成"
        
        # 安装 Node.js
        Write-Host "  正在安装 Node.js（请稍候）..." -ForegroundColor Yellow
        
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$installerPath`" /qn /norestart" -Wait -PassThru -NoNewWindow
        
        if ($process.ExitCode -eq 0) {
            Write-Success "Node.js 安装成功"
            # 刷新 PATH
            $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
        } else {
            Write-Error "Node.js 安装失败（错误码: $($process.ExitCode)）"
            Write-Host "请手动访问 https://nodejs.org 下载安装 Node.js 后重试" -ForegroundColor Yellow
            pause
            exit 1
        }
    } catch {
        Write-Error "下载 Node.js 失败: $($_.Exception.Message)"
        Write-Host "请手动访问 https://nodejs.org 下载安装 Node.js 后重试" -ForegroundColor Yellow
        pause
        exit 1
    } finally {
        # 清理安装文件
        if (Test-Path $installerPath) {
            Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
        }
    }
}

# ===== 安装 DSH Manager =====
Write-Step 3 "安装 DSH Manager"

Write-Host "  正在通过 npm 安装..." -ForegroundColor Yellow

try {
    $npmOutput = npm install -g @dsh-manager/cli 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "DSH Manager 安装成功"
    } else {
        # 如果全局安装失败，尝试从 GitHub 直接安装
        Write-Warning "全局安装失败，尝试从源码安装..."
        
        $tempDir = "$env:TEMP\dsh-manager-install"
        if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
        
        # 克隆仓库
        git clone https://github.com/linhut/dsh-manager.git $tempDir 2>&1
        Set-Location $tempDir
        
        # 安装依赖
        npm install 2>&1
        
        # 创建符号链接
        $npmGlobalDir = npm root -g 2>$null
        if (-not $npmGlobalDir) {
            $npmGlobalDir = "$env:APPDATA\npm\node_modules"
        }
        
        # 创建全局链接
        npm link 2>&1
        
        Write-Success "DSH Manager 安装成功（源码模式）"
    }
} catch {
    Write-Error "安装失败: $($_.Exception.Message)"
    pause
    exit 1
}

# ===== 安装 DSH =====
Write-Step 4 "安装 DeepSeek Harness"

Write-Host "  正在安装 DeepSeek Harness..." -ForegroundColor Yellow

try {
    # 使用 dshm 安装 DSH
    $dshmPath = "$env:APPDATA\npm\dshm.cmd"
    if (-not (Test-Path $dshmPath)) {
        $dshmPath = "dshm"
    }
    
    & $dshmPath install dsh --verbose 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Success "DeepSeek Harness 安装成功"
    } else {
        # 直接通过 npm 安装
        npm install -g @deepseek-ai/dsh 2>&1
        Write-Success "DeepSeek Harness 安装成功（npm 模式）"
    }
} catch {
    Write-Warning "DSH 安装失败，可以稍后通过 dshm 命令安装"
}

# ===== 启动 =====
Write-Step 5 "启动 DSH Manager"

Write-Host @"

╔══════════════════════════════════════════════════╗
║           🎉 安装完成！                            ║
║                                                  ║
║   你可以使用以下命令：                              ║
║                                                  ║
║     dshm           启动交互式管理界面               ║
║     dshm status    查看 DSH 状态                  ║
║     dshm doctor    系统诊断                       ║
║     dshm marketplace  浏览插件市场                 ║
║                                                  ║
╚══════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

Write-Host "是否现在启动 DSH Manager？（Y/N）" -ForegroundColor Yellow
$response = Read-Host

if ($response -eq 'Y' -or $response -eq 'y') {
    Write-Host "正在启动 DSH Manager..." -ForegroundColor Cyan
    try {
        # 尝试启动
        $dshmPath = "$env:APPDATA\npm\dshm.cmd"
        if (Test-Path $dshmPath) {
            & $dshmPath
        } else {
            & dshm
        }
    } catch {
        Write-Host "请手动在终端中运行 'dshm' 命令启动" -ForegroundColor Yellow
        pause
    }
} else {
    Write-Host "你可以随时在终端中运行 'dshm' 来启动管理界面" -ForegroundColor Gray
    pause
}