# M6 自测报告（安装与分发）

里程碑：M6 — Win 检测逻辑、升级备份计划、NSIS 双形态安装包、NOTICES/更新配置生成。
交付口径（用户确认）：**脚本 + 逻辑 + 单测**；真机项归档 `win7-regression.md` E 节。

## 交付清单

| 模块 | 文件 | 说明 |
|---|---|---|
| Win 检测 | `installer/lib/winDetect.ts` | `parseOsInfo`（RTM/SP1 判定）、`requiredKbs`（KB4490628→KB4474419 顺序）、`needsWmf`、`parseKbList`/`missingKbs` 纯解析、`detectKbs`（exec 参数注入，生产走 wmic） |
| 备份计划 | `installer/lib/backupPlan.ts` | `planBackup`（.bak-<ver> 避让）、`buildRollbackEntries`/`executeBackup`（回滚清单落盘）、`planRollback`、`uninstallCleanup`（keepData） |
| NSIS 公共 | `installer/nsis/common.nsh` | 32 位/RTM 拒绝页、KB 引导页（默认勾选可跳过不阻断，#14）、升级备份钩子、卸载数据页 |
| 在线 stub | `installer/nsis/installer-online.nsi` | INetC 下载全量组件（Win 端 NSIS 3 自带插件；构建宿主无插件时走冒烟分支） |
| 离线全量 | `installer/nsis/installer-offline.nsi` | payload 随包（Electron/sidecar/MinGit/字体/KB 引导包） |
| 双模式 | `-DPER_USER=1` 变体 | per-user → `%LOCALAPPDATA%` 免管理员；admin → `%PROGRAMFILES64%` |
| 构建流水 | `installer/scripts/build-installer.mjs` | 四变体编译 + 体积预算硬校验（online ≤10MB / offline ≤180MB） |
| 许可证 | `installer/scripts/gen-notices.mjs` | 扫描 node_modules(213) + Cargo.lock(79) + 手工条目（MinGit GPLv2 / ripgrep / 字体 OFL）→ NOTICES.txt |
| 更新配置 | `installer/scripts/gen-update-yml.mjs` | electron-updater 锁版（6.3.9）+ 主源/国内镜像 latest.yml + dev-app-update.yml |

## 验证矩阵

| 检查项 | 结果 | 证据 |
|---|---|---|
| winDetect 表驱动单测 | ✅ 15/15 | RTM/SP1/8.1/10 判定、KB 解析归一、缺失计算、detectFailed 非阻塞口径 |
| backupPlan 单测 | ✅ 10/10 | 目录避让、清单生成、复制回滚、卸载保留 |
| NSIS 四变体语法冒烟 | ✅ 4/4 编译产物 | Linux makensis 3.09：`codara-0.1.0-{admin,per-user}-{online,offline}.exe`（stub ~155KB） |
| 生成脚本冒烟 | ✅ | NOTICES.txt（npm=213, cargo=79）、latest.yml/dev-app-update.yml |
| 体积预算 | ✅ stub 在预算内 | 真实 payload 体积归档真机项 E11 |

## 沙箱边界（真机归档项）

以下项目 Linux 沙箱不可验，已归档 `docs/spec/win7-regression.md` **E 节（E1–E13）**：
RTM/32 位拒绝弹窗、per-user/admin 真实安装、KB 页真机交互、INetC 真实下载、断网离线安装、升级备份回退实测、卸载保留数据、体积实测（真实 payload）、SHA-2 签名链验证、NOTICES 随装检查。

## 关键设计决策

1. **KB 检测非阻塞**（#14）：`detectFailed=true`（wmic 异常）时 missing=全部 required 但放行安装，KB 页提示跳过。
2. **零第三方插件**：仅 NSIS 3 自带（MUI2/nsDialogs/INetC/x64.nsh/WinVer.nsh）；Linux 冒烟宿主缺 INetC 时以 `CODARA_HAS_INETC` 条件编译隔离。
3. **per-user/admin 双 .nsi 变体**：共享 common.nsh 90% 逻辑，规避 Win7 上 NSIS 插件差异风险。
4. **备份职责分层**：安装器仅做轻量 CopyFiles 兜底；精确备份/回滚清单由 `backupPlan.ts` 逻辑（随包 helper）承担，逻辑可在沙箱单测覆盖。
