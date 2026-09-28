# 命令口径反转 + 人工审查中间层（工具调用失败第三轮）

> 2026-09-28 · 分支 `main` · 承接 `docs/spec/reports/tool-call-fix.md`（第一、二轮）

## 零、本轮定性

第二轮我把「sidecar 白名单」当成需要**修正**的东西（只是放宽误杀）。本轮口径**反转**：
这层白名单本身就被判定为设计错误，整块移除。安全职责**全部上移**到 Electron 侧的
**人工审查中间层**，且该环节**强制保留**。

用户原话：

> 搭建人工审查中间层：所有高危命令、读写类命令全部提交人工审查，该审查环节强制保留。
> 暂不额外划分其他权限。保留审批卡片，危险命令不额外拦截，同普通审查卡片处理。
> 模型直接输出终端原始命令，不做约束、改写、违禁词过滤。模型先自主选定 Shell 类型
> （CMD/Bash/PowerShell），用括号标注所选 Shell，后续按正常流程流转，等待人工审核执行。

## 一、根因：三轮事故的同一个结构性缺陷

三轮截图，三种表象，同一个病根 —— **中间件在「生成/审批」与「执行」之间插了一道
内容审查，且这道审查位于审批之后**：

| 轮次 | 表象 | 真正被拦的地方 | 拦截理由的性质 |
|---|---|---|---|
| 一 | `terminal {"command":"python --version"}` ✓，下一条 ✗ | 参数校验 / 令牌传递 | 工程缺陷 |
| 二 | 222 字符 `Invoke-WebRequest` 命令卡「已批准」却 ✗ | sidecar 一行式长度规则（>200 字符） | **拦长度，不拦危险性** |
| 三 | `Get-ChildItem -Force \| Select-Object Name` ✗ | sidecar PS 禁用词表（`select-object`） | **拦写法，不拦危险性** |

共同后果：**审批卡沦为无效交互**。用户点了「批准」，命令仍被下游同一条规则拒绝，
卡片状态与工具流状态永久打架（卡片「已批准」/ 工具「✗」）。

## 二、修复（四个改动面）

### A. sidecar：删除全部内容审查

`sidecar/src/governance/cmd_rules.rs` 重写。删除：

- `HIGH_RISK_PATTERNS` 高危语义识别（28 条模式）
- `check_ps_forbidden` PowerShell 禁用词表（14 个词元，含 `select-object` 等只读 cmdlet）
- `split_semicolons` 分号链式检测
- `&&` / `||` 链式拦截
- `-NoProfile` 前缀强制

**保留两条工程性保护**（非内容审查，属传输层约束）：

| 保留项 | 错误码 | 理由 |
|---|---|---|
| 空命令 | 3001 CMD_REJECTED | 空串不是命令，属缺参；避免拿空串去 spawn 进程 |
| 长度 > 2000 字符 | 3002 CMD_OVERFLOW_BLOCKED | 撑爆 stdio 行分隔 RPC 帧 |

新增 `detect_shell_hint()`：只读回显模型标注的 shell（`(PowerShell)` / `(CMD)` / `(Bash)`），
命中即回显、未命中按可执行名粗判。**纯展示用，不参与放行判定**。

### B. Electron：预检同步收窄

`electron/src/tools/runtime.ts`：

- `precheckTerminalCommand` 从 4 条规则砍到 **1 条**（长度上限）。
- 删除 `PS_FORBIDDEN_RULES`（上一轮我加的等价写法建议表—— 与本次「不附带等价写法」
  的要求直接冲突，全部移除）。
- 删除 `psSubsetViolation`、`hasUnquotedSemicolon`。
- `TERM_CMD_LIMIT = 2000` 保留，与 sidecar `CMD_MAX_LEN` 对齐。

### C. Electron：人工审查中间层强化（**强制保留**）

`electron/src/tools/gateway.ts`。这是本轮真正承载安全的模块。

| 工具 | 策略 | 说明 |
|---|---|---|
| `terminal` | **ask** | 每条命令都审，无内容白名单、无例外 |
| `write` | **ask** | 读写类 → 审 |
| `git` 写操作 | **ask** | commit/push/checkout/revert… → 审 |
| `git` 只读 | auto | status/diff/log/show/branch/worktree-list |
| `read` / `search` | auto | 纯只读 |
| `index.symbols` / `index.semantic` | auto | 只读查询，sidecar 无写通道 |

关键语义：

- **危险命令不额外拦截**：命中 `HIGH_RISK_TERMINAL`（扩充了 `Remove-Item` / `Clear-Disk` /
  `Stop-Computer` / `Set-ExecutionPolicy`）只让卡片标注 `risk='high'`，
  走的仍是同一张普通审查卡、同一套批准流程。
- **Goal 预授权只能跳过非高危审查**：高危命令在 `goal` 模式下即使已预授权
  也**必弹卡**。否则「挂机自驱」会退化成无人看守的破坏性执行。
- **sidecar 不再二次拒绝**：用户批准 = 放行，不存在「批准了还被拒」的第二道门。

### D. 提示词：从「纪律约束」改为「环境事实 + 自主选择」

`electron/src/loop/agentLoop.ts` 的 `buildSystemPrompt`：

删除：禁 `;` 链式、禁 `&&`/`||`、强制 `-NoProfile`、>2000 字符必须落 `.ps1`。

改注入**运行环境事实**（让「自由选用 shell」不退化成为盲猜）：

```
运行环境（据此自主选定 shell，无需询问用户）：
- 目标平台：Windows 7 SP1+ x64（终端由 sidecar 托管，按你标注的 shell 启动对应解释器）
- 可用 shell：CMD（cmd.exe，系统自带，最稳）、Windows PowerShell（powershell.exe，Win7 自带 2.0+）、
  Bash（若环境存在 git-bash/WSL；不存在时会执行失败，注意回退）
- 选择建议：文件/目录操作与 .bat 用 CMD；需要对象管道、正则、JSON 处理用 PowerShell；
  跨平台脚本或已有 .sh 用 Bash
- 工作区根目录由系统注入，所有相对路径都相对它解析
```

新增铁律第 4、5 条：

```
4. Shell 自由选择：命令内容不受任何限制或改写——不设违禁词、不禁链式（&& / || / ;）、
   不要求特定前缀。由你自主决定用哪种 shell（CMD / Bash / PowerShell），并在命令开头用
   括号标注所选 shell，例如 `(PowerShell) Get-ChildItem -Force`、`(CMD) dir /b`、
   `(Bash) ls -la`。标注纯属声明，便于审查卡展示，不会被改写或校验。
5. 人工审查是唯一防线：**所有命令与写操作都会弹审批卡**，由用户决定是否执行。
   高危命令（删除、格式化、注册表、提权、关机等）会以高风险样式标出，但同样走普通
   审查卡、不额外拦截。请在发起工具调用前用一句话说明你要做什么、为什么；被拒绝时
   不要重试同一条命令，改成询问用户或换方案。
```

### E. 附带：上一轮已批准的 B 组改动（会话不丢 + 挂起有痕）

本轮一并交付（用户此前已 `确认，全部修复`）：

- **sidecar 新增 `session.list` / `session.rename`**（`db/sessions.rs` + `dispatch.rs` 注册）。
  `session.list` 按 `kind='main'` 倒序列出 `(id, title, createdAt)`；不做角色隔离断言
  （列表不含消息正文，隔离仍在 `msg.list`/`msg.append`）。
- **Electron 新增 IPC `chat:list` / `chat:rename`**（`shared/src/ipc.ts`、`preload.ts`、
  `handlers.ts`、`renderer/src/ipc/client.ts`）。
- **渲染层启动时拉取 `session.list` 填充左栏**（`App.tsx`）—— 修复「重启后对话记录消失」。
  左栏会话列表此前是纯内存 `convs.list`，进程一重启就只剩「主对话」。
- **首条用户消息回填会话标题**（`Composer.tsx` → `chat:rename`）—— 左栏显示
  「帮我修复工具调用失败」而不是「对话 2026/9/28 18:49」。
- **`budgetSuspended` 收尾**（`App.tsx`）—— 此前只 `setUsage`，不解除 `streaming`、
  不收尾 live 条目、不插系统消息，导致「执行完就断」后中栏空白。现在补齐三项：
  `streaming=false` + `finalizeLiveEntry()` + 插入系统消息
  「已达本轮轮次/预算上限，任务在此暂停（进度已保存）。直接继续发送消息即可接着跑。」

## 三、修改文件清单

| 文件 | 改动 |
|---|---|
| `sidecar/src/governance/cmd_rules.rs` | 重写：删除全部内容审查，只留空命令 + 长度上限；新增 `detect_shell_hint` |
| `sidecar/src/governance/cmd_rules_test.rs` | 重写：12 例，断言过去被误杀的命令全部放行 |
| `sidecar/src/db/sessions.rs` | 新增 `session_list` / `session_rename` |
| `sidecar/src/dispatch.rs` | 注册 `session.list` / `session.rename` |
| `electron/src/tools/runtime.ts` | `precheckTerminalCommand` 砍到 1 条规则；删除 `PS_FORBIDDEN_RULES`/`psSubsetViolation`/`hasUnquotedSemicolon` |
| `electron/src/tools/gateway.ts` | 审查策略矩阵重写；高危只标注不额外拦截；扩充高危特征 |
| `electron/src/loop/agentLoop.ts` | 提示词：删纪律约束，注入运行环境事实 + shell 标注约定 |
| `electron/src/ipc/handlers.ts` | 新增 `chatList` / `chatRename`；`chatNew` 支持标题入参 |
| `electron/src/preload.ts` | 暴露 `chatList` / `chatRename` |
| `shared/src/ipc.ts` | 新增通道常量 `chatList` / `chatRename` |
| `renderer/src/ipc/client.ts` | 新增 `chatList` / `chatRename` 与 `ConversationListResult` |
| `renderer/src/App.tsx` | 启动拉取会话列表；`budgetSuspended` 三项收尾 |
| `renderer/src/components/layout/LeftPane.tsx` | `newChat(title?)` 支持标题透传 |
| `renderer/src/components/chat/Composer.tsx` | 首条消息回填标题 |
| `tests/main/terminal-discipline.test.ts` | 改写为新口径；文件头加口径反转说明 |
| `tests/main/gateway.test.ts` | 新增「人工审查中间层」5 例 |
| `tests/integration/sidecar.test.ts` | 新增 `session.list` / `session.rename` 4 例 |

## 四、验证

```
pnpm -r typecheck                → 全绿（shared / electron / renderer）
pnpm --filter @codara/main test  → 163 passed（原 151）
pnpm --filter @codara/tests-integration test → 63 passed（原 59）
cargo test（sidecar）            → 40 passed
```

关键回归用例：

- `destructive_commands_pass_sidecar_but_are_left_to_human_review` —— `rm -rf` / `format C:`
  在 sidecar 层放行，且 `high_risk` 恒为 false（风险判定已上移网关）。
- `read_only_pipeline_cmdlets_are_allowed` —— 截图里失败的那条现在放行。
- `chained_commands_are_allowed` / `powershell_without_no_profile_is_allowed`。
- `人工审查中间层：高危与读写类命令强制审查` —— terminal 每条都审；
  高危只标 `risk='high'` 不额外拦截；Goal 预授权不能跳过高危审查。
- `session.list 返回 main 会话且按时间倒序` / `session.rename 回填标题`。

## 五、保留项与理由

| 保留 | 为什么不删 |
|---|---|
| 长度上限 2000 字符 | 传输层约束，不是内容审查；不设会撑爆 stdio 行帧 |
| 空命令拒绝 | 缺参，不是命令 |
| `promoteTerminalExit`（exitCode≠0 → ok=false） | **如实上报**，非过滤。这是第二轮「失败被当成完成」的解药 |
| 审批卡三处状态同步 | 卡片一致性，与命令内容无关 |
| Goal 预授权对高危仍强制弹卡 | 用户明确要求「审查环节强制保留」 |

## 六、口径对照速查

| 维度 | 旧 | 新 |
|---|---|---|
| 命令内容过滤 | 违禁词 + 子集 + 链式 + 高危识别 | **无** |
| 链式 `&&`/`;` | 拒绝 | 放行 |
| `-NoProfile` | 强制 | 不要求 |
| shell 选择 | 提示词钉死 PowerShell | 模型自主选 + 括号标注 |
| 等价写法建议 | 每条拒绝附建议 | **不附** |
| 高危命令 | 额外拦截（sidecar 复判） | 不额外拦截，同普通审查卡 |
| 审查范围 | terminal 审 / write 审 / 高危升级 | terminal **每条**审 / write 审 / git 写审 |
| 安全承载者 | sidecar 白名单 + 网关 | **网关（人工审查，强制保留）** |
