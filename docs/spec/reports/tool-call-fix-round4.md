# 工具调用失败修复 · 第 4 轮

> 触发：用户回传三张截图，暴露三个**新的独立缺陷**（write 缺 `edits` 连环失败 / HTTP 400 整轮中断 / 左栏无法删除会话）。
> 结论：A、B 共享同一根因（**非法 `arguments` 被钉进历史并反复回放**），C 是**能力完全缺失**。

## 一、现象与复现

| 截图 | 现象 | 复现路径 |
|---|---|---|
| ① | `write` 连挂两次：先 `32502 缺少必填参数：[edits]`，再 `arguments JSON 解析失败: {"create": true, "path": "get_child.xlsx"}` | 模型输出 `{"create":true,"path":"desktop_pet.py"}`，缺 `edits` |
| ② | **HTTP 400**：`Invalid request content. Assistant tool call ***.arguments must be valid JSON` | 同一段坏 `arguments` 被写进 `this.messages`，下一轮原样回放 |
| ③ | 左栏堆满 9/25–9/27 旧会话，无法删除 | 全链路无 `session.delete` / `chatDelete`（grep 确认） |

**先复现，不臆测**：三个现象都在本地用单测直接钉住了（见第四节）。

## 二、根因分析

### A. 参数自愈缺失 → 弱模型死循环

`run()` 里原来的 `parseToolArgs` 只做 `JSON.parse`。一旦模型吐出常见坏形态（带围栏、尾逗号、单引号、被截断），立刻抛错；catch 之后 `params = {}`，模型**只看到「缺参数」三个字，看不到正确形状**，于是原样重发同样的坏 JSON —— 这就是截图①里 `write` 连挂两次的直接原因。

### B. 坏参数被钉进历史 → 整轮 HTTP 400 中断

`this.messages.push(assistantMsg)` 把 `tool_calls[].function.arguments` **原样**存了下来。OpenAI 兼容端点在校验请求体时会检查 `arguments must be valid JSON`，命中即 **400 拒绝整个请求**，会话从这一轮起彻底断掉。这是截图②「执行完就断」的根因。

> A 与 B 是**同一枚硬币的两面**：A 让坏 JSON 有机会被生成，B 让它留下来污染后续每一轮。

### C. 会话删除能力完全缺失

`IPC` 白名单没有 `chatDelete`；preload 没有桥接；主进程没有 handler；sidecar 没有 `session.delete` RPC；左栏没有删除入口。所以「怎么没有删除？」的答案是：**从来没实现过**。

## 三、修复方案（最小改动）

### A 端 · 三层自愈 + 精确回注

1. **迭代式 JSON 修复**（`parseToolArgs`）：
   - 第一轮**保守**：原文 → 剥围栏 → 花括号切片，各自再试一次「尾逗号修复」；
   - 第二轮**放宽**：调用 `relaxJson()` —— 单引号转双引号（`convertSingleQuotedStrings` 逐字符状态机，键与值都转，双引号串内不动）+ 去尾逗号 + 用栈配平括号（正确跳过字符串与转义），只在结果以 `{` / `[` 开头时采纳。
2. **schema 驱动的缺参回注**（`coerceToolArgs`）：解析成功但缺必填时，不再让 sidecar 报一句干巴巴的「缺少必填参数」，而是由 `schemaHint()` 生成**必填清单 + 类型 + 描述 + 最小示例**，末尾附 `禁止原样重发，请补齐后重新调用。`，并带 `code:-32602` 与 sidecar 同口径。
3. **`write` 安全特例**：仅当 `name==='write'` **且**缺失项**恰好只有** `edits` **且** `create===true` 时，补 `edits:[{newText:''}]` 并按「新建空文件」处理（`create!==true` 绝不触发，避免把未知形状误当空文件）。配套修 `normalizeWriteParams`：新增 `firstStringAllowEmpty` + `hasNewKey` 守卫，让空串 `newText` 能被识别。

### B 端 · 发送前清洗历史

`sanitizeOutgoingMessages()` 在**每次请求前**对 `this.messages` 做浅拷贝清洗：把无法解析的 `arguments` 替换为 `JSON.stringify({__invalid_arguments__: raw.slice(0,200)})` —— **保留 tool_call 以维持 `assistant.tool_calls` 与 `tool.tool_call_id` 的配对**，只换掉非法载荷；`content:''` 归一为 `null`。坏参数再也进不了请求体，400 消失。

### C 端 · 会话删除五层贯通

`shared/src/ipc.ts`（`chatDelete` 通道）→ `electron/src/preload.ts`（桥接）→ `electron/src/ipc/handlers.ts`（handler：`session.delete` → 若删的是当前绑定会话则 `abort` + 清预授权 + `reset` + `detachAndReturnToOrigin`）→ `renderer/src/ipc/client.ts` + `state/stores.ts`（`removeConversation`）→ `LeftPane.tsx`（悬停显形删除按钮 + `confirm`）。sidecar 侧 `session_delete` 在**单个事务**里先删 `messages` 再删 `sessions` 行，`removed===0` 返回 `7002 session not found`。

## 四、修改文件（14 个）

| 文件 | 改动 |
|---|---|
| `electron/src/loop/agentLoop.ts` | `parseToolArgs` 迭代修复；新增 `relaxJson` / `convertSingleQuotedStrings` / `coerceToolArgs` / `schemaHint` / `sanitizeOutgoingMessages` / `isParseableObject`；`run()` 接入自愈 + `argsErrorCode` 透传；新增 `getActiveSessionId()` / `detachAndReturnToOrigin()` |
| `electron/src/tools/runtime.ts` | `firstStringAllowEmpty` + `hasNewKey`，空 `newText` 不再被过滤 |
| `electron/src/ipc/handlers.ts` | `chatDelete` handler（含活动会话回退） |
| `electron/src/preload.ts` | `chatDelete` 桥接 |
| `shared/src/ipc.ts` | `chatDelete: 'chat:delete'` |
| `renderer/src/ipc/client.ts` | `CodaraBridge.chatDelete` + noop |
| `renderer/src/state/stores.ts` | `removeConversation()` |
| `renderer/src/components/layout/LeftPane.tsx` | 悬停删除按钮（`IconTrash`）+ `deleteConversation()` |
| `renderer/src/theme/layout.css` | `.conv-del` / `.conv-name` 样式 |
| `sidecar/src/db/sessions.rs` | `session_delete()` 事务级联 |
| `sidecar/src/dispatch.rs` | 注册 `session.delete` |
| `tests/main/loop-toolcall.test.ts` | +18 测试（A 自愈 7 / A 回注 4 / A 端到端 2 / B 清洗 5） |
| `tests/main/tool-args.test.ts` | 截断与单引号自修复断言（替换旧「必须抛错」断言） |
| `tests/integration/sidecar.test.ts` | +2 测试（`session.delete` 级联 / 幂等边界） |

## 五、验证命令与结果

```
pnpm build:shared                                 # ✅ 改了 shared/ 必须先重建
pnpm -r typecheck                                 # ✅ 5/5 全绿
pnpm --filter @codara/main test                   # ✅ 183 / 183
pnpm --filter @codara/tests-integration test      # ✅ 66 / 66
cd sidecar && RUSTUP_TOOLCHAIN=stable cargo test --offline   # ✅ 40 / 40
```

**五类场景覆盖**（用户要求：成功 / 失败 / 超时 / 无权限 / 参数错误）：
成功 → `create=true 仅给 path` 补齐后成功建文件；失败 → 缺 `path` 回注精确错误且**不触达 sidecar**；超时 → 沿用既有 `TERM_TIMEOUT 2002` 用例；无权限 → 审查中间层 `ask` 卡（第三轮已覆盖）；参数错误 → 截断 / 单引号 / 尾逗号 / 围栏 / 缺必填全部自愈或精确回注。

## 六、风险与回滚

| 风险 | 评估 | 缓解 / 回滚 |
|---|---|---|
| `relaxJson` 误修「本意就是坏的」参数 | 低 | 只在保守轮全失败后启用；且要求结果以 `{`/`[` 开头；`write` 特例限定 `create===true` 且仅缺 `edits` |
| `sanitizeOutgoingMessages` 改变了历史语义 | 低 | 只替换**无法解析**的 `arguments`，保留 tool_call 维持配对；可解析的一律原样 |
| 删除会话误删活动会话 | 中 | handler 内 `wasActive` 判定 + `abort/reset/detachAndReturnToOrigin` 回退；UI 侧 `window.confirm` 二次确认 |
| 事务级联删除慢（大会话） | 低 | 消息与行在同一 tx，索引在 `session_id` 上 |

**回滚**：单独 revert 本轮的 14 个文件即可；A/B/C 三块互相独立，也可只回滚其中一块（例如仅回滚 C 不影响 A/B）。

## 七、复现证据（单测钉死）

- `tests/main/loop-toolcall.test.ts` → `A: parseToolArgs 常见坏形态自修复`（围栏 / 尾逗号 / 单引号 / 截断 / 双引号内不动）
- 同上 → `A: coerceToolArgs 缺参精确回注`（回注含示例、`code=-32602`、`write` 特例只认 `create===true`）
- 同上 → `A 端到端: 截图里的 write 缺 edits 不再死循环`（第二次调用带上正确 `edits`，**不再原样重发**）
- 同上 → `B: sanitizeOutgoingMessages 发送前清洗历史`（坏 `arguments` 被替换、tool_call 配对保留、可解析的不动）
- `tests/integration/sidecar.test.ts` → `session.delete 级联删除` / `session.delete 幂等边界`
