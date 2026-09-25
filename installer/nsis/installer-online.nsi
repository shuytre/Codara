; 在线安装版公共壳（stub ≤10MB）：运行时经 INetC 下载全量组件包后安装
; 变体：per-user（-DPER_USER=1）/ admin（默认）；BUILD_FLAVOR=online
; INetC 为 NSIS 3 自带插件（零第三方依赖）

!define APP_VERSION_DEF "0.1.0"
!define BUILD_FLAVOR    "online"
!define DOWNLOAD_URL    "https://dl.codara.example.com/stable/${APP_VERSION_DEF}/codara-${APP_VERSION_DEF}-win7-x64-full.7z"

!ifdef PER_USER
  RequestExecutionLevel user
  InstallDir "$LOCALAPPDATA\Codara"
!else
  RequestExecutionLevel admin
  InstallDir "$PROGRAMFILES64\Codara"
!endif

!include "common.nsh"

Section "Install"
  SetOutPath "$INSTDIR"
  DetailPrint "正在下载全量组件包（约 180MB）…"

  ; INetC：Windows 版 NSIS 3 自带插件；Linux 构建宿主无此插件 → 冒烟分支跳过
  !ifdef CODARA_HAS_INETC
    INetC::get /CAPTION "下载组件" /QUESTION "" "${DOWNLOAD_URL}" "$TEMP\codara-full.7z" /END
    Pop $0
  !else
    DetailPrint "[smoke] INetC unavailable on build host; skip download"
    StrCpy $0 "OK"
  !endif
  ${If} $0 != "OK"
    MessageBox MB_ICONSTOP|MB_OK "组件包下载失败（$0）。$\n$\n请检查网络后重试，或改用离线全量安装包。"
    Abort
  ${EndIf}

  Call PreInstallBackup

  ; 释放 7z 自解包（NSIS 无内置 7z 解压：组件包为自解压 exe，静默释放到 $INSTDIR）
  ExecWait '"$TEMP\codara-full.7z" -o"$INSTDIR" -y' $R9
  ${If} $R9 != 0
    MessageBox MB_ICONSTOP|MB_OK "组件包释放失败（退出码 $R9）。"
    Abort
  ${EndIf}
  Delete "$TEMP\codara-full.7z"

  ; 开始菜单 + 卸载登记
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\Codara.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME} ${APP_VERSION}"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
SectionEnd

Section "un.Uninstall"
  ; 数据页回调已设置 $KeepDataState（可选保留，规格 7.8）
  ${If} $KeepDataState != ${BST_CHECKED}
    RMDir /r "$APPDATA\${APP_NAME}"
  ${Else}
    DetailPrint "已保留用户数据目录：$APPDATA\${APP_NAME}"
  ${EndIf}

  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
SectionEnd
