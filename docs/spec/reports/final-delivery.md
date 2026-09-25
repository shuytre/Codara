# Codara M1–M4 统一交付报告

> 交付范围：《Codara 对话式编程 Agent 开发主提示文档 (v1.1)》M1–M4 全部里程碑
> 验证环境：Ubuntu 22.04 沙箱（Linux 交叉验证）；Win7 专属项归档 `win7-regression.md`
> 报告日期：本轮交付（M1/M3/M4 详见 `reports/m1-self-test.md` / `m3-self-test.md` / `m4-self-test.md`）

## 一、交付总览

| 里程碑 | 交付物 | 状态 |
|---|---|---|
| M1 协议与文件内核 | sidecar（Rust，stdio 行分隔 JSON-RPC，1MB 帧）+ 统一信封 + fs.read/meta + secret + db + 审计 | ✅ 完成 |
| M2 补丁与治理 | oldText/newText 精确补丁、编码保真（GBK/BOM/CRLF）、CAS+隐藏分支快照、git 分级、terminal 治理管线、缓存 | ✅ 完成 |
| M3 专家团内核 | 7 角色编制、双层状态机、CrewScheduler（并发 2）、sidecar 强制会话隔离、调度工具、左栏角色树 | ✅ 完成 |
| M4 沙箱与长任务 | Goal 预授权（三项勾选）、高危必审批、崩溃恢复（TTL 锁 + WAL 检查点）、审计闭环 | ✅ 完成 |

## 二、验证矩阵（最终态）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck`（shared/electron/renderer） | **0 错误** |
| `pnpm build`（contract→sidecar→main→renderer 四段） | **通过** |
| 集成测试（vitest） | **54/54**：sidecar 42 + mock-llm 3 + gateway 7 + crash-recovery 2 |
| main 项目单测（网关/预授权） | **7/7** |
| Rust 单测（治理管线） | **6/6** |
| Electron 冒烟（装配 + 主会话创建 + 启动锁巡检） | **通过** |

## 三、关键架构决策（跨里程碑）

1. **统一信封 `{ok, data, error?, truncated?, cacheRef?}`**：sidecar 全方法一致，错误码分段（1xxx fs / 2xxx 终端 / 3xxx 命令治理 / 4xxx 审批 / 5xxx 快照 / 6xxx 凭据 / 7xxx 会话 / 9xxx 锁与检查点）。
2. **隔离是架构约束不是提示词约定**：会话角色绑定校验在 Rust 层 `msg.append/msg.list` 强制（7002），任何上层 bug 无法跨角色读历史。
3. **白名单只是减摩擦层（ADR-06）**：安全边界 = 高危正则无条件升级人工审批 + 快照回滚 + 全量审计；Goal 预授权显式排除 high risk。
4. **退出码即验收**：非零退出（含超时 124）是 RPC 成功返回的业务数据；Tester 验收以退出码与断言为准，模型自述不作数。
5. **调度工具在主进程、执行器在 sidecar**：sidecar 保持文件系统/终端单一职责，编排语义归主进程。
6. **编码保真**：GBK/GB18030/BOM/CRLF 读改写字节级一致，二进制拒绝编辑。

## 四、本轮收尾改动（typecheck 清零 + M4 测试补齐）

- 修复 20 处类型错误（9 文件）：crew 角色定义导入归位（agentLoop/runtime/scheduler）、`getApiKey()` 补 await、SSE 归一层结构化解包（`SsePayload`）、消息数组越界访问（noUncheckedIndexedAccess）、`maxConcurrent` 改读 `budget.concurrency`、session.data 收窄、preload subscribe 泛型化、renderer 两处（RecoveryBanner 笔误 / setSettings 签名）。
- 新增测试：`tests/main/gateway.test.ts`（预授权 7 例）、`tests/integration/crash-recovery.test.ts`（崩溃恢复 e2e 2 例，含 SIGKILL 真实崩溃路径）。
- 测试基建：vitest workspace 三项目显式 root；electron/root 补 vitest devDep；renderer/main `--passWithNoTests`。
- 新增报告：`docs/spec/reports/m4-self-test.md`。

## 五、已知限制与后续

1. **真实 LLM 联测**：双 Developer 并行、Goal 题库、Coordinator 自动派发等模型行为用例在沙箱内以 mock-llm 覆盖协议层；接入真实 Key 后按 M3/M4 报告遗留清单首验。
2. **WAITING_BUDGET 自动续跑**：当前置态广播 + 人工重发；自动恢复需上下文重放，列入下轮迭代。
3. **terminal 只读白名单 auto 档**：命令分级表待 Win7 真机回归后定稿（网关已留桩）。
4. **Win7 专属回归**：运行时矩阵（Win7 SP1/8.1/10）、老机模式内存 ≤250MB、DPAPI 真机加解密等，按 `docs/spec/win7-regression.md` 清单执行。
5. 左栏角色树实时 token 计数、检查点回放升级为会话重建：字段与设施已预留，UI/逻辑后续迭代。

## 六、交付清单

```
codara/
├── shared/          # @codara/contract：信封/错误码/工具契约/crew 契约/IPC 白名单
├── sidecar/         # Rust 执行器：fs/patch/terminal/git/snapshot/db/sessions/audit/lock/ckpt
├── electron/        # 主进程：ModelClient(SSE+退避)/AgentLoop/ToolRuntime/ApprovalGateway/CrewScheduler/IPC
├── renderer/        # SolidJS：三栏布局/对话流/审批卡/diff 卡/设置页/角色树/预授权卡/恢复横幅
├── tests/           # vitest workspace：main(7)/integration(47，含真实 sidecar 子进程)
├── docs/spec/       # 规格书/ADR/modes/registers/reports(m1,m3,m4)/win7-regression.md
└── scripts/         # sidecar 构建/依赖 pin
```

运行方式：`pnpm install && pnpm build && pnpm test`；开发调试 `pnpm dev`。
