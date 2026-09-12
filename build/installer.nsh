; DSH Manager — NSIS 自定义钩子（electron-builder 自动加载 build/installer.nsh）
;
; 覆盖安装 / 卸载前自动关闭正在运行的应用（含子进程树）：
; 避免新版覆盖安装时旧实例仍占用 exe / 残留 DSH 子进程，导致升级卡死（僵尸进程）。
; 说明：仅 Windows（NSIS 安装器）需要此钩子；
;   - macOS：dmg 拖放安装无安装脚本时机，升级前请先退出应用（Cmd+Q）；
;   - Linux：deb/AppImage 替换运行中文件不产生占用冲突（inode 替换语义），无需额外处理。
; 配置数据（%APPDATA%\DSH Manager 与 %USERPROFILE%\.dsh）始终保留，
; 由 package.json build.nsis.deleteAppDataOnUninstall=false 显式声明，卸载不删除。

!macro customInstall
  nsExec::ExecToLog 'taskkill /IM "DSH Manager.exe" /F /T'
  nsExec::ExecToLog 'taskkill /IM "dsh-manager.exe" /F /T'
  Sleep 500
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /IM "DSH Manager.exe" /F /T'
  nsExec::ExecToLog 'taskkill /IM "dsh-manager.exe" /F /T'
  Sleep 500
!macroend
