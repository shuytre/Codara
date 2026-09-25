# 立项：MCP 工具接入（mcp.* 工具族）

> 对应规格：6 章「MCP 服务器接入：每个 MCP 服务器单独授权，经统一审批网关」口径的具象化。

## 范围

- MCP 客户端（主进程）：stdio 传输，管理子进程生命周期（启动/健康/退出/超时杀）。
- 服务器注册表（settings `mcp.servers[]`：name/command/args/env/白名单工具子集）。
- 工具桥接：发现阶段把 MCP `tools/list` 映射为 Codara 工具 `mcp.<server>.<tool>` 注入模型可见工具面；调用经 `tools.execute` 管道（schema 校验 → 角色矩阵 → 网关）。
- **授权模型（规格口径）**：
  - 启用某 MCP 服务器 = 用户单独确认（服务器级开关，默认关）。
  - 每服务器可配「auto 工具白名单」，其余工具每次 ask；服务器整体高危（如 fs 写类）可一键拒绝。
  - Goal 预授权不自动覆盖 mcp.*：预授权范围仅限用户显式勾选的服务器。
- 资源/提示（resources/prompts）一期只读展示，不进工具面。

## 非目标

- 不做 HTTP/SSE 传输（仅 stdio）；不做 MCP 服务器市场与自动安装。
- 不做服务器进程沙箱化（依赖服务器自身信任 + 网关审批拦截高危调用）。

## WBS

1. `electron/src/mcp/`：client（JSON-RPC over stdio，行分隔帧）+ registry + 生命周期管理（复用 sidecar manager 心跳经验）。
2. 工具桥接：动态 toolSpecs 合成 + `mcp.*` 在 ToolRuntime 的路由分支；审计事件 `mcp.tool.call`。
3. 网关：`policyFor('mcp.<server>.<tool>')` 按服务器白名单 → auto/ask/deny；审批卡注明来源服务器。
4. 设置 UI：服务器列表（增删改/启用开关/白名单编辑）；启用时确认卡（列明 command/args/可见工具数）。
5. 测试：mock MCP 服务器（tests/mock-mcp）协议测试 + 网关矩阵单测 + 集成（真实子进程 round-trip）；Win7 真机项（node 子进程 stdio 长稳）归档。

## 验收标准

- 启用服务器需显式确认；未启用时 `mcp.*` 工具完全不可见、不可调用。
- 白名单内工具 auto、白名单外 ask、Goal 预授权不越权覆盖。
- 服务器崩溃后健康检查标记离线，调用返回专用错误码，不拖垮主进程。
- 集成测试（含 mock server）全绿。

## 风险与体积成本

- 风险：第三方 MCP 服务器质量不可控（审批网关兜底 + 审计全量）；Win7 上 Node 子进程句柄泄漏风险（心跳+强杀，真机长稳验证）。
- 体积：主进程增量 <100KB（协议薄层）；不进安装包的服务器运行时由用户自备。
- 工期：1.5–2 周。
