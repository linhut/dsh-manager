# DSH Manager
# (c) 2026 Jose AI (https://www.linhut.cn)
# https://github.com/linhut/dsh-manager
# Licensed under the MIT License. See the LICENSE file for details.

<#
.SYNOPSIS
    DSH Manager 一键安装脚本（源码方式）
.DESCRIPTION
    自动检测环境、启用 Windows 开发者模式（解决 npm workspace 符号链接权限问题）、
    克隆源码、安装依赖并启动 DSH Manager 桌面应用。
    适用于 Windows 10/11
.PARAMETER InstallDir
    安装目录，默认 $env:USERPROFILE\dsh-manager
.PARAMETER Branch
    源码分支，默认 main
.PARAMETER SkipStart
    安装后不自动启动
.EXAMPLE
    .\install.ps1
    .\install.ps1 -InstallDir D:\dsh-manager -SkipStart
#>

#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:USERPROFILE\dsh-manager",
    [string]$Branch = "main",
    [switch]$SkipStart
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/linhut/dsh-manager.git"

function Write-Step($Num, $Text) { Write-Host "`n[$Num/5] $Text" -ForegroundColor Cyan }
function Write-Success($Text) { Write-Host "✅ $Text" -ForegroundColor Green }
function Write-WarningMsg($Text) { Write-Host "⚠️  $Text" -ForegroundColor Yellow }
function Write-ErrorMsg($Text) { Write-Host "❌ $Text" -ForegroundColor Red }

Write-Host @"
╔══════════════════════════════════════════════════╗
║   🐳 DSH Manager 一键安装脚本（源码方式）          ║
║   DeepSeek Harness 安装与管理工具                  ║
╚══════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

Write-Host "本工具将自动完成以下步骤：" -ForegroundColor Gray
Write-Host "  1. 检查 Node.js 环境（>= 18）" -ForegroundColor Gray
Write-Host "  2. 启用 Windows 开发者模式（解决 npm 符号链接权限）" -ForegroundColor Gray
Write-Host "  3. 克隆源码到 $InstallDir" -ForegroundColor Gray
Write-Host "  4. npm install 安装依赖" -ForegroundColor Gray
Write-Host "  5. 启动 DSH Manager" -ForegroundColor Gray
Write-Host ""

# ===== 1. 检查 Node.js =====
Write-Step 1 "检查 Node.js 环境"

$nodeVersion = $null
try { $nodeVersion = node --version 2>$null } catch {}

if ($nodeVersion) {
    $versionStr = $nodeVersion -replace '[^0-9.]', ''
    $major = [int]($versionStr.Split('.')[0])
    if ($major -lt 18) {
        Write-ErrorMsg "Node.js 版本过低: $nodeVersion，需要 >= 18"
        Write-Host "请访问 https://nodejs.org 安装 Node.js 18+ 后重试"
        pause; exit 1
    }
    Write-Success "Node.js 已安装: $nodeVersion"
} else {
    Write-WarningMsg "未检测到 Node.js，尝试通过 winget 安装..."
    try {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
        $nodeVersion = node --version
        Write-Success "Node.js 安装成功: $nodeVersion"
    } catch {
        Write-ErrorMsg "Node.js 自动安装失败，请手动安装 https://nodejs.org 后重试"
        pause; exit 1
    }
}

# ===== 2. 启用 Windows 开发者模式 =====
Write-Step 2 "启用 Windows 开发者模式"

# 开发者模式允许无管理员权限创建符号链接，解决 npm workspaces 安装失败（errno -4094）
$devModePath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
try {
    $current = Get-ItemProperty -Path $devModePath -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
    if (-not $current -or $current.AllowDevelopmentWithoutDevLicense -ne 1) {
        $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($isAdmin) {
            New-Item -Path $devModePath -Force | Out-Null
            Set-ItemProperty -Path $devModePath -Name AllowDevelopmentWithoutDevLicense -Value 1 -Type DWord
            Write-Success "开发者模式已启用（如仍提示符号链接错误，请重启系统后重新运行）"
        } else {
            Write-WarningMsg "当前非管理员，无法自动启用开发者模式"
            Write-WarningMsg "请以管理员身份运行 PowerShell 执行: Start-Process powershell -Verb RunAs -ArgumentList '-Command', 'reg add ""HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f'"
            Write-WarningMsg "若 npm install 仍报 errno -4094，请重启系统后重试（开发者模式需重启生效）"
        }
    } else {
        Write-Success "开发者模式已开启"
    }
} catch {
    Write-WarningMsg "开发者模式设置失败（不影响安装，若 npm 报符号链接错误再处理）"
}

# ===== 3. 克隆源码 =====
Write-Step 3 "克隆源码"

try {
    if (-not (Test-Path "$InstallDir\.git")) {
        if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
        Write-Host "  正在克隆 $RepoUrl ..." -ForegroundColor Yellow
        git clone --branch $Branch --depth 1 $RepoUrl $InstallDir 2>&1
        Write-Success "源码克隆完成"
    } else {
        Write-Host "  已存在源码目录，拉取最新代码..." -ForegroundColor Yellow
        Push-Location $InstallDir
        git pull 2>&1
        Pop-Location
        Write-Success "源码已更新"
    }
} catch {
    Write-ErrorMsg "克隆源码失败: $($_.Exception.Message)"
    Write-Host "请确认已安装 git: https://git-scm.com/download/win"
    pause; exit 1
}

# ===== 4. 安装依赖 =====
Write-Step 4 "安装依赖 (npm install)"

Push-Location $InstallDir
try {
    Write-Host "  安装依赖可能需要几分钟，请耐心等待..." -ForegroundColor Yellow

    # 经验教训：npm install 中断会造成依赖树残缺，且 --offline 显示 "up to date"
    # 但实际文件缺失。以下策略增强安装可靠性：
    #   ① 优先尝试 npm ci（若 package-lock.json 存在、干净安装）
    #   ② 失败后回退到 npm install（增量兼容）
    #   ③ 安装后校验关键入口文件，残缺则自动重试一次

    $installOk = $false
    $lockFile = Join-Path $InstallDir "package-lock.json"
    $failDetail = $null

    # ① npm ci 干净安装（更可靠，避免残缺增量）
    if (Test-Path $lockFile) {
        Write-Host "  使用 npm ci 干净安装（package-lock.json 存在）..." -ForegroundColor Yellow
        npm ci --no-audit --no-fund 2>&1
        if ($LASTEXITCODE -eq 0) { $installOk = $true }
        else {
            Write-WarningMsg "npm ci 失败（错误码: $LASTEXITCODE），回退到 npm install..."
            $failDetail = "npm ci 失败"
        }
    }

    # ② npm install 增量安装
    if (-not $installOk) {
        Write-Host "  使用 npm install 安装依赖..." -ForegroundColor Yellow
        npm install --no-audit --no-fund 2>&1
        if ($LASTEXITCODE -eq 0) { $installOk = $true }
        else {
            Write-WarningMsg "npm install 失败（错误码: $LASTEXITCODE），尝试带兼容参数重试..."
            $failDetail = "npm install 失败: $LASTEXITCODE"
            npm install --no-audit --no-fund --legacy-peer-deps 2>&1
            if ($LASTEXITCODE -eq 0) { $installOk = $true }
        }
    }

    if (-not $installOk) {
        Write-ErrorMsg "依赖安装失败（npm ci / npm install 均失败）"
        Write-WarningMsg "$failDetail"
        Write-WarningMsg "常见原因: 1) 网络中断 2) Windows 符号链接权限 3) 依赖包已下架"
        Write-WarningMsg "修复建议: 请启用开发者模式（设置 → 隐私和安全性 → 开发者选项）后重启，或删除 node_modules 与 package-lock.json 后重试"
        pause; exit 1
    }

    # ③ 安装后完整性校验（关键入口文件）
    Write-Host "  校验关键依赖入口文件..." -ForegroundColor Yellow
    $keyEntries = @(
        "node_modules/electron/dist/electron.exe",
        "node_modules/execa/index.js",
        "packages/core/src/index.js",
        "packages/marketplace/src/index.js"
    )
    $missing = @()
    foreach ($entry in $keyEntries) {
        if (-not (Test-Path (Join-Path $InstallDir $entry))) { $missing += $entry }
    }
    if ($missing.Count -gt 0) {
        Write-WarningMsg "完整性校验发现缺失文件: $($missing -join ', ')"
        Write-WarningMsg "尝试重新安装（删除 node_modules 后 npm ci）..."
        if (Test-Path node_modules) { Remove-Item node_modules -Recurse -Force }
        if (Test-Path $lockFile) {
            npm ci --no-audit --no-fund 2>&1
        } else {
            npm install --no-audit --no-fund 2>&1
        }
        if ($LASTEXITCODE -ne 0) {
            Write-WarningMsg "二次安装仍失败，node_modules 可能仍不完整。"
            Write-WarningMsg "建议手动运行: cd $InstallDir; npm ci"
        } else {
            Write-Success "重装完成"
        }
    } else {
        Write-Success "完整性校验通过"
    }

    Write-Success "依赖安装完成"
} catch {
    Write-ErrorMsg "npm install 失败: $($_.Exception.Message)"
    pause; exit 1
} finally {
    Pop-Location
}

# ===== 5. 启动 =====
Write-Step 5 "启动 DSH Manager"

Write-Host @"
安装完成！DSH Manager 源码位于: $InstallDir

常用命令：
  cd $InstallDir
  npm start            启动 DSH Manager 桌面应用
  npm run dev          开发模式（带调试信息）
  npm run build:win    构建 Windows 安装包
"@ -ForegroundColor Cyan

if (-not $SkipStart) {
    $response = Read-Host "是否现在启动 DSH Manager？（Y/N）"
    if ($response -eq 'Y' -or $response -eq 'y') {
        Write-Host "正在启动 DSH Manager..." -ForegroundColor Cyan
        try {
            Push-Location $InstallDir
            npm start
            Pop-Location
        } catch {
            Write-ErrorMsg "启动失败: $($_.Exception.Message)"
            Write-Host "请手动运行: cd $InstallDir && npm start"
            pause
        }
    } else {
        Write-Host "你可以随时运行: cd $InstallDir && npm start" -ForegroundColor Gray
        pause
    }
} else {
    Write-Host "跳过启动（-SkipStart）。运行: cd $InstallDir && npm start" -ForegroundColor Gray
}
