# Codara M3 自测报告（专家团内核）

> 里程碑：M3 专家团内核（标准预设）
> 环境：Ubuntu 22.04 沙箱（Linux 交叉验证）

## 一、改动清单

### Shared 契约
- 新增 `shared/src/crew.ts`：CrewRole（7 角色）/ TaskStatus / InstanceStatus / 双层状态机迁移表 / TaskPacket / CrewArtifact / CrewInstanceView（渲染层角色树）
- `ipc.ts`：新增 crew 通道（crew:start-task / crew:spawn / crew:status / crew:instance / crew:task / crew:card / crew:artifact）
- `tools.ts`：删除早期 TaskPacket/Artifact 旧定义（schema 统一到 crew.ts）；ToolSpec.name 放宽为 string 以容纳 task.* 调度工具

### Sidecar（Rust）
- 新增 `db/sessions.rs`：`session.create` / `msg.append` / `msg.list`
  - **会话隔离架构约束**：msg 读写强制校验调用方 roleId 与会话绑定角色（sessions.role），不匹配 → 7002 `session isolation violation`
  - 主对话（kind=main）仅接受 roleId=main；crew 会话仅接受绑定角色
  - 防御性建表 + db 目录自动创建

### 主进程
- 新增 `crew/roles.ts`：7 角色定义（系统提示词 / 工具权限矩阵 / 交接物模板 / 轮次上限）；Builder 为桩实现；Researcher 明示一期仅库内调研
- 新增 `crew/state.ts`：TaskWorkspace（`.codara/tasks/<id>/{task.json, artifacts/, logs/}`）+ 双层状态机迁移断言
- 新增 `crew/scheduler.ts`：CrewScheduler
  - 并发信号量（默认 2，可配 1-4）+ 全局排队
  - 实例驱动循环：session.create（crew 绑定）→ Task Packet 注入 → AgentLoop（角色提示词/工具过滤/持久化）→ 交接物落盘 + db 登记 → 状态迁移
  - 标准流转迁移：architect 完成 → PLANNED；developer 完成 → REVIEW；tester 完成 → DONE
  - handoff：新开实例只带交接物与目标（不回放旧对话历史）
  - 事件广播：crew:instance / crew:task / crew:card / crew:artifact
- `tools/runtime.ts`：角色工具矩阵校验（越权 4002，矩阵唯一来源 ROLE_DEFS）；task.spawn / task.handoff / task.status / artifact.write 四个调度工具（仅 Coordinator 放行）
- `loop/agentLoop.ts`：run() 支持 CrewRunContext（角色提示词 / toolSpecsForRole 过滤 / 消息经 msg.append 持久化 / 轮次上限取角色矩阵）；attachMainSession() 主对话持久化
- `main.ts`：装配重构（gateway/tools/scheduler 单次创建注入；修复 AgentLoop 缺 tools 参数的装配错误；主对话 session 创建）
- `ipc/handlers.ts`：crew 三个 handler（zod 校验）；删除重复创建的 ToolRuntime
- `preload.ts`：crew 白名单暴露

### 渲染层
- `stores.ts`：crew store（tasks + instances）
- `LeftPane.tsx`：升级为**专家团角色会话树**（任务 → 角色实例 → 状态徽标）；修复 settings store 用法
- `App.tsx`：订阅 crew 事件更新角色树；修复 settings setter
- 修复存量类型错误：RightPane 无用导入、SettingsPage settings() 调用

## 二、决策理由

1. **隔离放在 sidecar 而非提示词**（规格 4.1「隔离是架构约束」）：msg.append/msg.list 在 Rust 层校验 roleId 绑定，任何主进程 bug 或提示词注入都无法跨角色读历史；集成测试断言 7002。
2. **task.* 工具在主进程而非 sidecar**：任务编排是主进程语义（调度器/模型循环都在主进程），sidecar 保持「文件系统/终端执行器」单一职责。
3. **实例复用 AgentLoop**：每个实例独立 AgentLoop 对象 → 内存 messages 天然隔离 + 持久化按 sessionId 绑定；避免新写第二套循环。
4. **roleTools 矩阵单一来源**：runtime.ts 直接引用 ROLE_DEFS，防止两处维护漂移。
5. **WAITING_BUDGET 本轮只置态广播**：续预算后的实例恢复与 M4 崩溃恢复共用恢复流程，避免两套恢复逻辑。

## 三、自测结果

| 验收项（表 9-1 M3） | 结果 |
|---|---|
| 隔离测试：角色互读历史 100% 失败 | **通过**（4 个集成测试：developer 往返 / reviewer 读 developer → 7002 / 伪造 roleId 写入 → 7002 / main↔crew 互读 → 7002 / 幽灵会话 → 7002） |
| schema 校验 100% | **通过**（TaskPacket/CrewArtifact 类型化 + IPC crew payload zod 校验 + 状态机迁移断言） |
| 7 角色（Builder 桩、Researcher 裁剪） | **通过**（ROLE_DEFS 完整定义，Builder 提示词声明桩行为，Researcher 明示无 web.fetch） |
| 双 Developer 并行无冲突 | **调度器并发 2 信号量实现完成**；端到端并行用例需模型接入（mock 层已验证 ModelClient 429/流式），列入 M4 Goal 题库联测 |
| 429 退避演练 | **通过**（mock-llm：前 3 次 429 后恢复；主进程与调度器共享 ModelClient 退避） |
| 全量回归 | **45/45 集成测试 + 6/6 Rust 单测 + 三包构建 + typecheck 全绿** |
| Electron 冒烟 | **通过**（新装配含调度器/主会话创建） |

## 四、遗留问题

1. 双 Developer 端到端并行（真实 LLM）在 M4 Goal 题库联测中覆盖。
2. WAITING_BUDGET 实例恢复流程归入 M4 崩溃恢复统一实现。
3. 左栏角色树暂未展示实时 token 计数（instance.turns/tokens 字段已预留）。
4. Coordinator 在主对话中的启用依赖「标准预设」切换 UI，本轮极简模式默认路径不变（规格 M2 交付说明已注明）。

## 五、下一步（M4 沙箱与长任务）

1. 三档沙箱落地核对（auto/ask/deny）+ Goal 预授权告知卡（跳过范围/仍需审批/预算上限三项勾选）
2. 高危命令必审批审计闭环（approval.granted/denied 入审计日志）
3. 崩溃恢复入口：启动检测过期锁 → 恢复/终止卡 → 重建会话从最后检查点继续
4. Goal 模式预授权传递（gateway 对预授权范围自动放行，高危除外）
