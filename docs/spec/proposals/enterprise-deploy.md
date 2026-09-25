# 立项：企业部署模板（预置 endpoint / 锁设置 / MSI）

> 对应规格：ADR-11「企业化能力（统一管控、部署模板等）另行评估排期」；7.8「企业部署模板……降级为后续可选项，不进入首发」。
> 本立项 = 该可选项的启动评估。

## 范围

- **预置配置包**：管理员制作 `enterprise.json`（预置 endpoint/model/effort/白名单命令/代理/MCP 服务器清单/记忆初始内容），安装器检测 `%PROGRAMDATA%\Codara\enterprise.json` 自动导入向导跳过。
- **锁设置（managed policy）**：注册表策略键 `HKLM\SOFTWARE\Policies\Codara\`（锁 endpoint、禁遥测、禁 web.fetch/browser、禁设置页改动项），主进程启动读取 → settings 只读标记 + UI 置灰 + 状态徽标「由组织管理」。
- **MSI 分发**：NSIS 产物外提供 MSI 封装（WiX Toolset v3 构建），支持 GPO/SCCM 静默参数（`msiexec /i codara.msi /qn ENDPOINT=... LOCK=1`）。
- 升级链：MSI 升级复用 M6 备份/回滚计划（enterprise.json 不在备份剔除清单）。

## 非目标

- 不做设备管理/MDM 集成；不做集中日志回传服务端（仅本地审计日志导出）。
- 不做按用户策略（仅机器级）；不做自动更新策略锁（v1 保留 electron-updater 现状）。

## WBS

1. 策略读取层：主进程启动 `HKLM\...\Policies\Codara` → `managedSettings` 合成（优先级：策略 > enterprise.json > 用户 settings）。
2. enterprise.json 模板与导入器（向导跳过 + 校验 + 错误提示）。
3. UI：锁定项置灰 + 「由组织管理」徽标 + 导出审计日志入口。
4. WiX MSI 工程：封装 NSIS 产物或直接文件树 + 静默参数 + GPO 部署文档。
5. 测试：策略合成表驱动单测 + 导入器单测；真机项（Win7 SP1 域环境/无管理员运行、GPO 下发）归档回归。

## 验收标准

- 预置 endpoint 的机器首次启动零配置可用（无向导）。
- 锁定项在 UI 置灰且设置写入被拒（返回管理锁定错误码）；关遥测生效。
- MSI 静默安装/升级/卸载在 GPO 场景可复现；普通用户（无管理员）可正常使用已装应用。

## 风险与体积成本

- 风险：策略键与 settings 优先级回归复杂（表驱动单测覆盖 + 真机矩阵）；WiX 在 CI 的构建链维护成本。
- 体积：主进程增量 <150KB；MSI 工具链仅构建期依赖（不进安装包）。
- 工期：2 周。
- 建议节奏：个人版（首发）稳定 2 个版本后启动；先做 enterprise.json 预置（成本低、诉求强），锁设置与 MSI 按客户反馈分两期。
