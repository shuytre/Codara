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

---

# 续：terminal「时好时坏 + 批准了还失败」修复（C1–C4）

日期：2026-09-28 　基线 commit：`dd5dfc5`（B1–B5 修复后）
范围：仅针对 terminal 工具，在 B1–B5 之外的第二批线上缺陷；同样零新增依赖、不改契约。

## 一、根因（4 条，均有截图与真实 sidecar 探针复现）

复现手段：以线上截图中的原文命令喂给真实 sidecar 的 `validate_command` 探针，逐条对齐「PASS/REJECT」。

| # | 根因 | 触发条件 | 证据 | 影响 |
|---|---|---|---|---|
| **C1** | 提示词与 sidecar 规则**自相矛盾** | 需要多步命令时 | prompt 第 4 条教「链式命令用分号分隔」，而 sidecar `split_semicolons` **拒绝引号外分号** | 模型照提示词写，命令**必被拒**，形成系统性失败 |
| **C2** | PS 一行式**长度门槛**误杀正确命令 | 命令 >200 字符且不含 `.ps1` | 222 字符 `Invoke-WebRequest + try/catch`（常见真实写法）全被拒；201 拒 / 199 放行 | terminal **时好时坏**，且规则拦的是长度而非危险性 |
| **C3** | 校验发生在**审批之后** | C1/C2 命中的命令 | 用户点「批准」→ sidecar 仍以同规则拒绝 | 审批卡成为**无效交互**：卡上「已批准」，工具流 ✗ |
| **C4** | Electron 从不读 `exitCode` | 命令 `exitCode≠0` / 超时 124 | `grep -rn exitCode electron/src` 无匹配；sidecar 遵规格 3.3.4 仍回 `ok=true` | **失败命令被标成「完成」**：卡片/审计/回注三处都显示成功，模型据此产出「已验证」幻觉 |

> 关键判别：`-File swebench_parse.ps1`（短命令、有 `.ps1`）成功且已批准，紧接着 terminal 仍 ✗ —— 证明单靠 C2 无法解释全貌，C2 与 C4 是**两条独立**的失败通道。

## 二、修改文件

| 文件 | 改动 |
|---|---|
| `sidecar/src/governance/cmd_rules.rs` | **删除** `>200 字符且不含 .ps1` 的 PS 一行式规则（C2）。该规则位于 2000 字符 `CMD_OVERFLOW_BLOCKED` 之后，实为**永不可达的死规则**，且拦长度不拦风险 |
| `electron/src/tools/runtime.ts` | ①`precheckTerminalCommand` 把 sidecar 四条硬规则（空/溢出/`&&`\|`\|\|`/引号外分号 + PS `-NoProfile`）**前置到审批前**（C1/C3）；②`hasUnquotedSemicolon` 引号感知判定；③`promoteTerminalExit` 将 `exitCode≠0` 提升为 `ok:false`（124→`2002 TERM_TIMEOUT`，其余→`3001 CMD_REJECTED`），**原样保留 data**（C4） |
| `electron/src/loop/agentLoop.ts` | 提示词第 4 条改写：**禁止 `&&`/`\|\|` 与分号链式**，多步落成 `.ps1` 后 `-File`；一行式 >2000 字符会被拒（C1 矛盾消解） |
| `sidecar/src/governance/cmd_rules_test.rs` | **新增（12 例）**：cmd_rules 首次获得测试覆盖，含 C2 关键回归（>200 字符一行式放行） |
| `sidecar/src/governance/mod.rs` | 注册 `cmd_rules_test` 模块 |
| `tests/main/terminal-discipline.test.ts` | **新增（24 例）**：预检规则 / 引号感知 / 退出码提升 / 校验前置于审批 / 失败不再渲染成功 |

## 三、设计要点

- **单一事实来源**：`TERM_CMD_LIMIT = 2000` 与 sidecar 溢出上限对齐，避免三处规则再次漂移（C1 的教训）。
- **前置≠放宽**：主进程预检只做「能给出可自纠建议」的规则；sidecar `validate_command` **保留为最终防线**，不放宽任何一条。
- **审批卡语义修正**：非法命令**根本不弹卡**，错误直接回注模型自纠，同时省掉一次无意义的用户打扰。
- **退出码对偶**：RPC 成功 ≠ 命令成功。主进程在**不丢 data** 前提下把命令失败转成业务失败，使卡片、审计、模型回注三处一致。

## 四、验证

```bash
pnpm build:shared
pnpm -r typecheck                                   # shared / electron / renderer 全绿
pnpm test:main                                      # 151 passed（127 + 新增 24）
pnpm test:integration                               # 59 passed
RUSTUP_TOOLCHAIN=stable cargo test --manifest-path sidecar/Cargo.toml   # 40 passed（28 + 新增 12）
```

## 五、风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| C2 删规则后长一行式放行 | 少了一道「长命令」提示 | 2000 字符硬上限仍在；>2000 由 `CMD_OVERFLOW_BLOCKED` 兜底；提示词引导落 `.ps1` |
| C4 误报失败 | 某些命令以非零退出表达「正常否定」（如 `findstr` 无匹配 =1） | 错误信息明确标注退出码与输出尾部，模型可判读；**不隐藏 data**；仅命令类改写，上游 `ok=false` 原样透传 |
| 前置校验与 sidecar 漂移 | 两侧规则若再各自修改会重现 C1 | 常量集中 + 两侧测试各自锁定同一批样本命令 |

**回滚**：单次提交可整体 `git revert`；`cmd_rules.rs` 删规则与 Electron 两函数互相独立，可按条回退。

## 六、交付与流水线状态

| 项 | 值 |
|---|---|
| 提交链 | `8ac69b5`（cmd_rules 删规则）→ `01ecadb`（注册测试模块）→ `79b0466`（报告）→ `1616cb1`（提示词）→ `5220de1`（runtime 前置+退出码）→ `1127150`（回归测试） |
| 远端 HEAD | `1127150`（`origin/main`） |
| CI 运行 | [run 36324847847](https://github.com/shuytre/Codara/actions/runs/36324847847) — **success** |
| CI 详情 | `Test (ubuntu)` 全部步骤 ✓（含真实 Rust 1.77.2 rust-tests 与真实 sidecar 子进程 e2e）；`build` 全部步骤 ✓（NSIS 安装器 + 便携完整包产出） |
| 逐文件校验 | 7/7 文件 `git hash-object` 与 `origin/main` blob SHA **逐字节一致** |

> 早期数条 run 为 `cancelled`：工作流 `concurrency.cancel-in-progress=true`，连续 push 时旧 run 被新 run 取代，属预期行为，非失败。
