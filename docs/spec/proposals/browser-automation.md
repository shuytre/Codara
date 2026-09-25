# 立项：浏览器自动化

> 对应规格：6 章「浏览器自动化（Win7 Chromium 108）」；与多模态预设联动做 UI 走查。

## 范围

- 内嵌 **Chromium 108（Win7 可用的最后完整主干）** 的受控浏览器：独立窗口，与 Codara 主进程 CDP（DevTools Protocol）直连。
- 工具族 `browser.*`（sidecar 或主进程 CDP 客户端）：
  - `browser.open/close`：会话生命周期（单实例会话，复用策略）。
  - `browser.goto`：导航 + 等待策略（load/domcontentloaded/超时）。
  - `browser.click/type/extract`：元素交互与文本/属性提取（选择器：CSS 优先）。
  - `browser.screenshot`：页面截图（走 Chromium 自身 capture，非 GDI，无遮挡限制）。
- 权限：导航到白名单域名 auto（复用 web-fetch 白名单）；其余 ask；下载默认拒绝（防落地恶意文件）。
- 与 web.fetch 分工：需 JS 渲染/登录态/交互的页面走 browser.*；纯静态走 web.fetch。

## 非目标

- 不做扩展体系、多窗口管理、Cookie 持久 UI（会话内内存 Cookie 可用）。
- 不承诺 Win7 上 Chromium 108 的安全更新（版本冻结，UI 明示；高风险站点提示用户）。

## WBS

1. Chromium 108 x64 获取与打包评估：官方快照 or ungoogled-chromium 构建；体积与 NSIS payload 集成。
2. CDP 客户端（Node ws 连接，零重量依赖）：导航/交互/截图/提取四组原语。
3. `browser.*` 工具面 + 网关策略 + 审计；失败恢复（浏览器崩溃自动重启会话）。
4. UI：浏览器窗口嵌入/独立窗（MVP 独立窗）；设置页浏览器区块（启用开关，默认关）。
5. 测试：CDP mock + 集成（本地测试页）；Win7 真机项归档（启动/渲染/截图/内存占用）。

## 验收标准

- Win7 SP1 启动 Chromium 108 会话，goto/click/type/extract/screenshot 全链路可用。
- 白名单外导航弹审批；下载默认拦截。
- 浏览器崩溃不拖垮 Codara 主进程，重开会话可继续。

## 风险与体积成本

- **体积主风险**：Chromium 108 x64 完整包 ~110–150MB（压缩后 ~60–90MB）→ **仅随离线安装包提供**（离线包预算 ≤180MB 将被击穿，需专项决策：a) 浏览器独立下载包按需安装（推荐）；b) 放宽离线包预算）。
- 风险：Chromium 108 在低补丁 Win7 快照的启动兼容（M0 矩阵先行验证）；CDP 版本差异。
- 工期：3–4 周（含打包分发链路）。
