# 工具调用失败修复报告（B1–B5）

日期：2026-09-27 　基线 commit：`7a45823`（CI #17 SUCCESS 之后）
范围：修复「无法调用工具 / 工具调用失败」一批缺陷，保持接口兼容、零新增依赖。

---

## 一、根因（5 条，均可稳定复现）

复现手段：真实 sidecar 二进制（`cargo build --release`）+ 假 OpenAI 兼容 SSE 服务端 + `ToolRuntime`/`AgentLoop` 单测。

| # | 根因 | 触发条件 | 复现证据 | 影响 |
|---|---|---|---|---|
| **B1** | 并行工具调用聚合错槽 | 厂商不下发 `tool_call.index` / `id` | 两个调用塌进同一槽：`name` 拼成 `readsearch`，`arguments` 串成 `{"path":"a"{"pattern":"x"}}` | 并行工具调用**整体失败**（unknown tool + JSON 解析失败） |
| **B2** | git 写操作审批令牌未透传 | git `commit` / `branch-create` / `worktree-*` / `revert` 经审批后 | `git.exec` 收到的 params 无 `approvalToken`；sidecar 返回 `4001 APPROVAL_REQUIRED` | 批准的 git 写操作**永远失败**（terminal 已透传，git 漏了） |
| **B3** | 运行时零参数校验 | 模型漏参 / 传错类型 | `read {path:123}` 原样透传 sidecar，返回 `"path is required"` | 错误信息**误导**，模型无法自纠，空转重试 |
| **B4** | 未知工具报错误导 | 模型幻觉工具名（如 `readfile`） | 落入网关 `deny` 兜底 → `"operation denied by policy"` | 模型误判为权限问题，**反复重试**不存在的工具 |
| **B5** | write 归因错误笼统 | `path` 已给但 `edits` 形态非法 | 报「缺少 path 或 edits」（即使 path 存在） | 模型去补 path，**永远修不好** |

## 二、修改文件

| 文件 | 改动 |
|---|---|
| `electron/src/model/client.ts` | B1：新增 `isJsonBalanced` / `firstUnclosedSlot`，重写无 index/id 时的槽位判定 |
| `electron/src/tools/runtime.ts` | B2/B3/B4/B5：新增工具注册表校验、`validateToolParams` + `TOOL_PARAM_SPECS`、git 令牌透传、write 错误归因细化 |
| `electron/src/loop/agentLoop.ts` | 统一三条失败路径的错误信封形状（新增 `toolErrorMsg`） |
| `tests/main/model-stream.test.ts` | 新增（13 例）：B1 聚合 + 厂商形态兼容 + 失败/超时/中止 |
| `tests/main/tool-validate.test.ts` | 新增（27 例）：五类场景（成功/失败/超时/无权限/参数错误）+ B2 令牌 |
| `tests/main/loop-toolcall.test.ts` | 新增（10 例）：AgentLoop 端到端调用与错误回注 |
| `tests/integration/sidecar.test.ts` | 新增 2 例：git 顶层 `approvalToken` 契约、高危命令凭据门禁 |

## 三、关键设计取舍

- **B1**：`arguments` 是否「括号闭合」是区分「续帧」与「新槽」的唯一可靠信号（厂商不给 index/id 时）。
  实现为字符串转义感知的轻量扫描，不做完整 `JSON.parse`（增量帧必然解析失败）。
  同帧内第 2..n 项必为新槽；跨帧无 name 片段按「未闭合槽」顺序配对。
- **B2**：令牌放在**顶层**（与 `args.preAuthorized` 通道并存），sidecar 二者皆认，不破坏既有调用方。
- **B3**：只做结构性校验（必填 / 类型 / 枚举），**刻意宽容**未知 vendor 字段；
  sidecar 侧校验**保留为最终防线**（前置层目的是「让错误可读」，不是替代）。
- **B4**：注册表校验置于角色矩阵之前、网关之前；`task.*` 在无 scheduler 上下文仍报「需要专家团预设」而非「未知工具」，语义更准。
- **兼容性**：错误码沿用既有 `ErrorCode`（`METHOD_NOT_FOUND -32601` / `INVALID_PARAMS -32602` / `4002`），
  `write` 归因错误码由 `1007` 修正为 `-32602`（原 `1007` 是 `FILE_NOT_FOUND`，语义不符）。

## 四、验证

```bash
pnpm build:shared
pnpm -r typecheck                 # shared / electron / renderer 全绿
cd tests && npx vitest run --project main          # 127 passed（原 77 + 新增 50）
cd tests && npx vitest run --project integration   # 59 passed（原 57 + 新增 2）
cd sidecar && cargo test                           # 28 passed
```

## 五、风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| B1 启发式误判 | 极端厂商格式下可能把新槽误判为续帧 | 仅在**无 index 且无 id** 时才启用；有 index/id 走原路径；13 例兼容性用例覆盖主流形态 |
| B3 误拒合法调用 | 校验过严可能挡下合法参数 | 只校验必填/类型/枚举，额外字段一律放行；每工具附 `hint` 便于模型自纠 |
| B2 令牌语义 | 顶层令牌与 `preAuthorized` 并存 | sidecar 两者皆接受，既有调用方不受影响 |

**回滚**：单次提交可整体 `git revert`；三处源码改动互相独立，也可按 Bug 单独回退。

## 六、已知残留（未在本轮范围）

1. 【架构】工作区外写入：网关批准 ≠ sidecar 放行（`PATH_ESCAPED 1001` 硬拒），模型仍可能绕道 terminal —— 待产品决策。
2. 【提示】LLM 偶发自称「Ask 模式」（历史污染）—— 建议 base prompt 加免疫声明。
3. 【功能】左栏会话列表为运行内存态，sidecar 无 `session.list`，重启丢历史列表。
