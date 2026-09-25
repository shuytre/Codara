# ADR 记录索引

所有 ADR 编号与规格 7.2 对齐，正文各立一文。

| ADR | 决策 | 状态 |
|---|---|---|
| ADR-01 | Electron 22 冻结（否决 Tauri/Qt/原生） | accepted |
| ADR-02 | TypeScript 主进程 + Rust sidecar，热点与存储下沉 | accepted |
| ADR-03 | 单底座模型客户端（OpenAI 兼容 + capability），切换=全局整体切换 | accepted |
| ADR-04 | 会话物理隔离：分库存储、无跨角色读历史 API | accepted |
| ADR-05 | 补丁管线是唯一写通道（编码/换行保真 + 基线哈希） | accepted |
| ADR-06 | 软沙箱诚实边界：白名单是减摩擦层，安全边界=高危人工审批+快照回滚+审计 | accepted |
| ADR-07 | sidecar 独立进程 + stdio 行分隔 JSON-RPC（放弃 N-API）；Rust 锁 1.77.2 | accepted |
| ADR-08 | 存储归 sidecar：rusqlite bundled，Node 侧零原生 DB | accepted |
| ADR-09 | 仅 x64 + 要求 SP1；不支持场景安装器明确提示 | accepted |
| ADR-10 | 极简长编码为默认预设（五工具/cmd/治理/Token 纪律） | accepted |
| ADR-11 | 个人开发者优先（v1.1） | accepted |
| ADR-12 | 首发双安装形态（在线 stub + 离线全量），不做便携版（v1.1） | accepted |
| ADR-13 | 渲染层 SolidJS（覆盖待决策 #3 默认值，用户确认于 M1 前） | accepted |
