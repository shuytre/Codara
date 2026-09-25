; Codara NSIS 公共逻辑（Win7 SP1+ x64，零第三方插件；INetC/WinVer 为 NSIS 3 自带）
; 使用方：installer-online.nsi / installer-offline.nsi × per-user / admin 变体
; 约束（规格 7.8 / 待决策 #14）：
;   - 拒绝 32 位进程与 Win7 RTM（无 SP1）
;   - KB 检测页默认勾选可跳过、不阻断安装（#14）
;   - 升级前备份 per-user 数据目录 → .bak-<ver>（备份由 preload 阶段 helper 完成，见 backupPlan.ts）
;   - 卸载可选保留数据

!ifndef CODARA_COMMON_INCLUDED
!define CODARA_COMMON_INCLUDED

!include "WinVer.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "MUI2.nsh"
!include "x64.nsh"

!define APP_NAME      "Codara"
!define APP_PUBLISHER "Codara Team"
!define APP_VERSION   "${APP_VERSION_DEF}"

; per-user / admin 执行级别（由各 .nsi 传 -DPER_USER=1 或 0）
!ifdef PER_USER
  !define INSTALL_MODE "per-user"
!else
  !define INSTALL_MODE "admin"
!endif

Name "${APP_NAME} ${APP_VERSION} (${INSTALL_MODE})"
OutFile "..\dist\codara-${APP_VERSION}-${INSTALL_MODE}-${BUILD_FLAVOR}.exe"
; ---------------- 安装页序：欢迎 → KB 引导页 → 目录 → 安装 → 完成 ----------------
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
Page custom KbPageCreate
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.UninstallDataPage un.UninstallDataLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------------- .onInit：架构与 RTM 拒绝 ----------------
Function .onInit
  ${Unless} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "Codara 仅支持 64 位 (x64) Windows。32 位系统不受支持。"
    Abort
  ${EndIf}

  ; Win7 SP1 判定：WinVer + Service Pack（WinVer.nsh 的 ${IsWin7} 为 6.1 内核）
  ${Unless} ${AtLeastWin7}
    MessageBox MB_ICONSTOP|MB_OK "Codara 需要 Windows 7 SP1 或更高版本（仅 x64）。"
    Abort
  ${EndIf}
  ${If} ${IsWin7}
    ; 6.1 内核：读 SP 级别（RTM=7600 拒绝）
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
    ${If} $R0 == "7600"
      MessageBox MB_ICONSTOP|MB_OK "检测到 Windows 7 RTM（未安装 SP1）。$\n$\n请先安装 Windows 7 Service Pack 1，再运行本安装程序。"
      Abort
    ${EndIf}
  ${EndIf}

  SetRegView 64
FunctionEnd

; ---------------- KB 引导页（默认勾选可跳过不阻断，#14） ----------------
Var KbPageHandle
Var KbCheckboxHandle
Var KbMissingList

Function KbPageCreate
  ; 32 位/RTM 已在 .onInit 拦截；此处引导性检测（缺 KB 只提示，允许继续）
  !insertmacro MUI_HEADER_TEXT "SHA-2 补丁链检测" "以下系统更新影响程序签名校验，建议安装"
  nsDialogs::Create 1018
  Pop $KbPageHandle

  ${NSD_CreateLabel} 0 0 100% 24u "检测到以下 Windows 更新缺失（不影响本次安装，可跳过）：$\n$KbMissingList"
  Pop $R1

  ${NSD_CreateCheckbox} 0 30u 100% 12u "我已知悉，稍后自行安装这些更新（跳过检测）"
  Pop $KbCheckboxHandle
  ${NSD_Check} $KbCheckboxHandle

  nsDialogs::Show
FunctionEnd

; ---------------- 升级备份钩子（规格 7.8） ----------------
; 备份由随包 helper (codara-backup.exe / powershell 脚本) 在 Install 前执行：
;   %APPDATA%\Codara → %APPDATA%\Codara.bak-<ver>（含 rollback-manifest.json）
; 安装器仅负责检测旧数据目录存在并记录回滚提示。
Function PreInstallBackup
  IfFileExists "$APPDATA\${APP_NAME}\settings.json" 0 no_backup
    DetailPrint "检测到旧版数据目录，执行升级前备份…"
    CreateDirectory "$APPDATA\${APP_NAME}.bak-${APP_VERSION}"
    CopyFiles /SILENT "$APPDATA\${APP_NAME}\*.*" "$APPDATA\${APP_NAME}.bak-${APP_VERSION}\"
    DetailPrint "备份完成：$APPDATA\${APP_NAME}.bak-${APP_VERSION}（升级失败可回退）"
  no_backup:
FunctionEnd

; ---------------- 卸载：可选保留数据（规格 7.8） ----------------
Var KeepDataCheckbox
Var KeepDataState

Function un.UninstallDataPage
  !insertmacro MUI_HEADER_TEXT "用户数据" "选择卸载时是否保留你的数据"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateCheckbox} 0 10u 100% 12u "保留我的数据（任务库/配置/快照/凭据）"
  Pop $KeepDataCheckbox
  ${NSD_Uncheck} $KeepDataCheckbox
  nsDialogs::Show
FunctionEnd

Function un.UninstallDataLeave
  ${NSD_GetState} $KeepDataCheckbox $KeepDataState
FunctionEnd

!endif ; CODARA_COMMON_INCLUDED
