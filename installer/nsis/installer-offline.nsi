; 离线全量安装版（≤180MB 压缩态）：Electron/sidecar/MinGit/字体随包
; 变体：per-user（-DPER_USER=1）/ admin（默认）；BUILD_FLAVOR=offline
; 资源目录：installer/payload/（构建流水把 electron-dist、sidecar、MinGit、fonts 放入）

!define APP_VERSION_DEF "0.1.0"
!define BUILD_FLAVOR    "offline"

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
  Call PreInstallBackup

  ; 全量组件（打包时由 build 流水固化进 payload 目录）
  File /r "payload\*.*"

  ; Win7 SHA-2 补丁链引导文件随包分发（缺 KB 时用户可手动安装，#14 非阻塞）
  ; payload\redist\KB4474419-*.msu / KB4490628-*.msu / WMF5.1 说明

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
