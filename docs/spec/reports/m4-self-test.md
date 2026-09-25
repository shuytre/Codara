# Codara M4 自测报告（沙箱与长任务）

> 里程碑：M4 Goal 模式 + 预授权告知 + 崩溃恢复 + 沙箱三档 + 高危必审批
> 环境：Ubuntu 22.04 沙箱（Linux 交叉验证；Win7 专属项归档至 `docs/spec/win7-regression.md`）

## 一、改动清单

### Sidecar（Rust）
- 新增 `ckpt/lock.rs`：任务锁四件套
  - `lock.acquire`：TTL 时间戳锁（默认 TTL 30s / 心跳 10s）；持锁重复获取 → 9001 `LOCK_HELD`
  - `lock.heartbeat`：续期；`lock.release`：清理；`lock.inspect`：全量巡检，按 TTL 分组 `held` / `stale`
- 新增 `ckpt/checkpoint.rs`：WAL 式检查点
  - `ckpt.write`：临时文件 + 原子 rename + `LATEST` 序号标记
  - `ckpt.list` / `ckpt.load`：按任务回放；无 LATEST → 9003 `CHECKPOINT_CORRUPT`（不崩溃）
- `audit/rotating.rs`：`audit.note` 通道（goal.preauth.on/off/pass、approval.request/result 均落审计）
- `dispatch.rs`：注册 lock.* / ckpt.* / audit.note 共 8 个方法

### 主进程
- `tools/gateway.ts`：
  - `setGoalPreAuthorized(on)` / `isGoalPreAuthorized()`：预授权开关（开/关均写审计）
  - `check()` 新增预授权分支：`mode === 'goal' && 预授权开启 && risk !== 'high'` → 自动放行并审计 `goal.preauth.pass`；**高危无条件弹卡**（rm -rf / reg / revert 等 23 条高危正则）
  - deny 策略（未知工具）不受预授权影响
- `ipc/handlers.ts`：
  - `goal:preauthorize`：zod 校验 + **三项勾选全为 true 才开启**（工作区写入 / 白名单命令 / 预算上限），任一未勾维持逐次审批
  - `recovery:resolve`：resume = 释放过期锁 + `ckpt.load` 回放最后检查点到对话流；dismiss = 仅清理锁
  - `chat:abort`：**「停」即 `setGoalPreAuthorized(false)`**，回到逐次审批
- `main.ts`：启动时 `lock.inspect` → 有 stale 锁即向渲染层推送 `recovery:needed`（崩溃恢复入口）
- `preload.ts`：goalPreauthorize / recoveryResolve / onRecoveryNeeded 白名单暴露

### 渲染层
- `Composer.tsx`：Goal 模式发送前拦截 → **预授权告知卡**（三项逐项勾选：跳过审批范围 / 仍需审批的高危清单 / 预算上限与自动停机）；确认后 `goal:preauthorize` + 自动重放发送
- 新增 `RecoveryBanner.tsx`：订阅 `recovery:needed` → 恢复 / 忽略横幅
- `MainLayout.tsx`：挂载 RecoveryBanner
- `ipc.ts`：M4 三通道 + GoalPreauthorizePayload / RecoveryNeededPayload / RecoveryResolvePayload schema

### 本轮收尾（typecheck 清零 + 测试基建）
- 修复 20 处类型错误（9 文件）：
  - `agentLoop.ts` / `runtime.ts` / `scheduler.ts`：ROLE_DEFS / toolSpecsForRole / normalizePacket 归位到 `crew/roles` 导入（此前误从 `@codara/contract` 导入）
  - `agentLoop.ts`：消息数组访问改为局部变量（noUncheckedIndexedAccess）
  - `scheduler.ts`：`maxConcurrent` 改读 `budget.concurrency`（规格 4.5 单一配置源）；spawnInstance 透传 `upstreamArtifacts`；session.data 显式收窄
  - `client.ts`：`getApiKey()` 补 await（Promise<string>）；SSE 归一层补 `SsePayload` 结构化解包（修复 evt.choices/usage 在信封外层取值的结构性错误）
  - `ledger.ts`：snapshot.budget 类型改 `SettingsShape['budget']`
  - `preload.ts`：subscribe 泛型化（审批卡 payload 类型安全）
  - renderer：RecoveryBannerSlot 笔误、setSettings store setter 签名
- 测试基建：vitest workspace 的 main/integration/renderer 项目补显式 `root`；electron 包补 vitest devDep + `--passWithNoTests`；root 补 vitest devDep

## 二、决策理由

1. **预授权是减摩擦层而非安全边界**（ADR-06 延续）：白名单/预授权只减少弹卡次数；真正边界 = 高危正则无条件升级 + CAS 快照回滚 + 全量审计。因此预授权分支显式排除 `risk === 'high'`，且 deny 策略先于预授权判定。
2. **「停」的语义落在 chatAbort**：用户中断流即视为撤回授权（规格 4.7），比在 UI 上单独放撤销按钮更不可绕过——任何中止路径（预算终止/审批拒绝后的 abort）都复用同一入口。
3. **三项勾选与服务端校验二选一取严**：渲染层强制逐项勾选才提交，主进程再次 `&&` 聚合；防止渲染层 bug 直接开预授权。
4. **崩溃恢复以 sidecar 文件为事实源**：锁与检查点都是 sidecar 落盘文件（appData 下），主进程崩溃不影响数据；恢复流程 = 重启后 inspect（stale）→ release → ckpt.load → 回放。e2e 测试用 SIGKILL 真实模拟崩溃路径。
5. **锁 TTL 30s / 心跳 10s**：心跳频率远小于 TTL，误判 stale 的概率低；测试用可注入 ttlMs 避免真实等待。
6. **SSE 解包修正**：httpStream 分帧层产出 `{payload|done|error}` 信封，归一层此前直接在信封上取 choices/usage——类型修正在此暴露为结构错误，一并修正而非绕过。

## 三、自测结果

| 验收项（表 9-1 M4） | 结果 |
|---|---|
| Goal 预授权告知卡三项勾选 | **通过**（Composer 拦截 + zod + 服务端三项聚合；单测覆盖全勾/部分勾/拒绝路径） |
| 预授权范围内自动放行 | **通过**（gateway 单测：goal + 非高危 → allowed 且零弹卡；plan 模式不受影响） |
| 高危必审批 | **通过**（预授权开启下 rm -rf / reg add / git revert 仍弹卡 3 例；用户拒绝 → allowed=false + reason） |
| 「停」回到逐次审批 | **通过**（chatAbort 置 false；单测覆盖开→关往返） |
| 崩溃恢复入口 | **通过**（e2e：持锁 + 写检查点 → SIGKILL → 重启 → stale 分组含任务 → ckpt.load 恢复 step 2 → release → 重新 acquire 成功） |
| WAL 检查点原子性 | **通过**（tmp+rename+LATEST；无 LATEST 返回 9003 而非崩溃） |
| 锁语义 | **通过**（持锁重复获取 9001；心跳续期后 held；过期后 stale） |
| 审计闭环 | **通过**（preauth.on/off/pass、approval.request/result、崩溃恢复动作均落 audit.note） |
| 沙箱三档 auto/ask/deny | **通过**（policyFor：read/search=auto，write/terminal/写 git=ask，未知=deny；Ask 模式禁写类） |
| 全量回归 | **通过**：集成 **54/54**（sidecar 42 + mock-llm 3 + gateway 7 + crash-recovery 2）+ Rust **6/6** + main 项目 7/7 + typecheck **0 错误** + 四包构建通过 |

## 四、遗留问题

1. 双 Developer 并行 + Goal 题库端到端联测依赖真实 LLM Key，沙箱内以 mock-llm 覆盖协议层（429 退避/流式/工具往返），真实模型行为联测列入交付后首验。
2. WAITING_BUDGET 实例的自动恢复（续预算后从挂起点继续）当前为「置态广播 + 人工重发」，与崩溃恢复共用锁/检查点设施；全自动续跑需要模型上下文重放，列入下轮迭代。
3. terminal 白名单 auto 档（只读命令免审批）在网关中留有注释桩（`policyFor` terminal 一律 ask），沙箱细化命令分级表待 Win7 真机回归后定稿。
4. 渲染层角色树未展示实例实时 token 计数（字段已预留，见 M3 遗留 #3）。
5. `recoveryResolve` 的 resume 分支将检查点回放为一条对话消息；后续可升级为重建会话上下文（msg.list 拼装）。

## 五、交付状态

M1–M4 全部里程碑代码完成，验证矩阵全绿（typecheck / build / cargo test / vitest 全套）。Win7 专属回归项已归档 `docs/spec/win7-regression.md`（运行时矩阵 A1-A6、性能指标 B 系列、DPAPI、paths 等），交付后在 Windows 环境按清单执行。
