# 立项：web.fetch 网页抓取工具

> 对应规格：待决策「web.fetch 一期是否提供」、表 6-1 权限矩阵、Researcher 角色裁剪说明。
> 结论口径：**默认随总网络开关关闭；开启后白名单域名 auto、其余 ask**（规格 6-1 原文口径）。

## 范围

- sidecar 新增 `web.fetch` 方法：输入 URL → 抓取 → HTML 转纯文本/Markdown 摘要 → 统一信封返回（含 `truncated` 与缓存引用，复用 1MB 帧与缓存机制）。
- 总网络开关（settings `network.webFetchEnabled`，默认 **关**）：关时返回固定错误码 `WEB_DISABLED`（复用 8002 风格），附开启指引。
- 域名策略：白名单域名（settings 可配）→ 网关 auto；其余域名 → 网关 ask（每次审批或本次会话放行）。
- Researcher 角色解锁 `web.fetch`（白名单矩阵更新）；标准预设可选启用。
- 抓取安全：仅 http/https、重定向次数 ≤5、响应体 ≤2MB、超时 ≤30s、禁内网地址（默认拒绝 127.0.0.0/8、10/8、192.168/16、169.254/16）。

## 非目标

- 不做浏览器渲染（JS 执行）；纯静态 HTML 提取。需要渲染走 browser-automation 立项。
- 不做搜索引擎 API 集成（关键词检索由模型经 fetch 搜索页实现或后续独立立项）。
- 不做 Cookie 持久化与登录态。

## WBS

1. sidecar `web/` 模块：fetch + 大小/超时/重定向/内网防护 + HTML→文本（零依赖手写提取器）。
2. 错误码与信封接入、缓存接入（URL+内容 hash）。
3. electron：settings 开关 + 白名单编辑（settingsStore/IPC），网关 `policyFor('web.fetch')` 白名单判定。
4. roles.ts：Researcher/标准预设解锁；UI 设置页「网络」区块（总开关 + 白名单）。
5. 单测（模块级）+ 集成（mock http server：超时/超大/内网拒绝/白名单 auto）。Win7 真机项归档。

## 验收标准

- 关闭时调用返回专用错误码与开启指引；开启后白名单域名无需审批，非白名单弹审批卡。
- 2MB 响应截断且 `truncated:true`；内网地址默认拒绝并审计。
- Linux 集成测试全绿；Win7 SP1 真机抓取 http/https 各一（归档回归）。

## 风险与体积成本

- 风险：Win7 TLS 1.2 根证书过期站点抓取失败（引导用户导入根证书更新 KB）；HTML 提取器对站点适配有限（定位为「够用即可」，渲染需求转 browser-automation）。
- 体积：sidecar 增量 <300KB（零依赖实现）；安装包影响可忽略。
- 工期：1 周内（含测试）。
