# 第 6 轮：会话真正并行 + 工具卡折叠与时序

## 用户原始问题

> 在主任务进行时开启第二个任务，主任务的对话就会突然转到你那个其他的会话，然后快速停止，返回主界面会显示这样的

截图里主对话停在了一个工具卡上，卡住不动。这一句话背后其实是**四个独立缺陷**叠加，
修掉一个不够 —— 当时逐个试，每个修完还是复现。

用户在本轮明确选择了四项范围，并特别要求「改 sidecar 真正并行」、
「记得 Github Actions 哦，还有发链接」。

## 根因分解

按用户选项分四个独立缺陷，它们在同一个场景下互相掩盖：

### 缺陷 1：全局单例 AgentLoop + 无条件 abort

主进程只有一个 `AgentLoop`。`chatNew`/`chatSwitch`/`chatDelete` 会无条件
`abort()` + `reset()` 当前循环。所以「开第二个任务」这个动作本身，
就把第一个任务的循环杀掉了 —— 对话被拽过去、然后迅速停住。

### 缺陷 2：渲染层内容互相顶掉

`chat.entries` 和 `cards.list` 各只有一份。事件不带 `sessionId`，
两个会话的消息、工具卡全部写进同一个数组。

主对话还有一层特殊：左栏主对话 `activeId === null`，但事件按真实 `sessionId` 回来，
导致主对话的事件无处落地。

### 缺陷 3：sidecar 单线程同步 dispatch

主进程和渲染层都隔离了还不够。sidecar 侧每个请求在同一线程同步执行，
一个 `term.exec` 最长阻塞 300 秒。第二个会话的所有工具调用（包括 `msg.append`
这种轻量写）都排在前面那条长命令后面 —— 表现就是「开了第二个任务，但它一动不动」。

### 缺陷 4：右栏工具流水切会话后为空

历史路径只生成文本、从不生成 `ToolCallCard`，所以切换会话后右栏「暂无工具调用」。

## 解法

分两个独立提交，可各自回滚。

### 阶段 1（`550f446`）：主进程 + 渲染层

| 改动 | 位置 |
|---|---|
| `SessionRegistry`：每会话独立 `AgentLoop` + `BudgetLedger` + `ToolRuntime` + `approvals` | `electron/src/loop/sessionRuntime.ts`（新增） |
| `chatNew`/`chatSwitch` 不再 abort/reset；`chatDelete` 只 `sessions.drop` | `electron/src/ipc/handlers.ts` |
| 审批等待表按会话分桶；`sessionId` 由 `ToolRuntime` 构造参数透传 | 同上 + `tools/runtime.ts` + `tools/gateway.ts` |
| `chat.bySession` / `cards.bySession` 分区，`activeKey()` 解析当前分区 | `renderer/src/state/stores.ts`（重写） |
| 左栏主对话用 `convs.mainId` 兜底，事件按 `keyOf(sessionId)` 路由 | `renderer/src/App.tsx` |
| 工具卡：一行摘要（`search · pattern=* · mode=files`）+ 点击展开 | `cards/CardRenderer.tsx` + `layout.css` |
| 文本与卡片拆为独立 `role:'event'` entry，顺序即真实事件顺序 | `stores.ts` + `ConversationStream.tsx` |
| 用户气泡 `margin-right:auto` 靠左 + `raw.trim()` 消多余空行 | `layout.css` + `util/markdown.ts` |
| `chatSwitch` 回传结构化 `toolCalls`，历史工具卡重新进入右栏 | `handlers.ts` + `layout/LeftPane.tsx` |

摘要行算法在主进程（`toolSummaryLine`）和渲染层（`buildSummaryLine`）保持同算法，
两边结果必须一致 —— 否则实时卡和历史卡长得不一样。

### 阶段 2（`eaa43c8`）：sidecar 多线程 worker

- `AppState` 改为内部可变（`RwLock`/`AtomicBool`），以 `Arc` 共享给 worker
- 主线程只读帧与派发，**每请求 spawn 一个 worker**
- 响应由**独立写线程串行写 stdout** —— JSON-RPC 允许乱序（靠 id 配对），
  但同一帧写出绝不能被两个线程交错
- 有副作用的方法抢 workspace 级写锁，只读自由并发
- `dispatch` 及 16 个模块从 `&mut AppState` 改 `&AppState`

**为什么副作用必须串行**：两个会话同时改同一工作区、同时跑 git 会真出事
（快照半写、`git index.lock` 冲突、命令互相污染 cwd）。真正需要并发的
「读文件 / 搜索 / 列会话」不受此限 —— 那才是会话并行的收益所在。

## 两个值得记下的坑

### 坑 1：`is_exclusive` 漏登记会静默

并发安全的唯一策略入口最初返回 `bool`，未知方法默认 `true`。后果是：
新增一个 `fs.write` 忘了登记，并发写冲突直接上线，没人收到任何信号。

改成返回 `Option<bool>`，配一个扫源码的测试：

```
这些方法在 dispatch 里存在，但 is_exclusive 未登记分类（会被默认当排他，
并行度白白丢失）：["msg.list", "fs.writeNew"]
```

测试靠 `include_str!("dispatch.rs")` 扫 `dispatch` 的 match 分支，
而不是手抄一份清单 —— 手抄的清单会随 dispatch 增长而腐化，扫描不会。

### 坑 2：集成测试静默加载过期二进制

harness 原本「release 存在就用 release，否则用 debug」。改完 sidecar 只跑了
`cargo build`（debug），集成测试却仍加载**上次 release** 的旧二进制 ——
单线程版本。表现是 4 个并发测试全红，而根因离测试十万八千里。

现在 `pickBinary()` 会打印实际加载的路径和 mtime，排查时第一眼就能看见。
这个坑排查花的时间比写测试本身还长，值得记下来。

## 测试与验证

| 套件 | 结果 | 说明 |
|---|---|---|
| sidecar 单测 | 45 过 | 新增 5 个排他分类测试 |
| main | 195 过 | 新增 12 个 `session-parallel.test.ts` |
| renderer | 29 过 | 新增 22 个 `session-isolation.test.ts` |
| integration | 75 过 | 原 66 + 新 9 个 `sidecar-parallel.test.ts` |
| `pnpm -r typecheck` | 全绿 | |

集成测试总耗时从 22s 降到 8s —— 这本身就是并行的直接证据。

**注入验证**（确认测试不是永远通过的空壳）：

| 注入 | 预期 | 实际 |
|---|---|---|
| 新增未登记方法 `fs.writeNew` + 删掉 `msg.list` 登记 | 单测失败并点名 | ✅ 报出 `["msg.list", "fs.writeNew"]` |
| 把只读方法全改排他（等价退回单线程） | 并发测试失败 | ✅ 3 个并发测试精确失败 |

并发测试覆盖：只读穿过慢排他请求、多个只读并发穿锁、响应乱序、
按 id 正确配对（内容可区分的 6 个文件）、并发读各自内容不串台、
并发写同一文件不交错、排他请求耗时累加、50 并发无丢失、并发后仍能服务。

## 提交

| Commit | 内容 |
|---|---|
| `550f446` | 阶段 1：主进程 + 渲染层会话隔离、工具卡、消息气泡 |
| `eaa43c8` | 阶段 2：sidecar 多线程 worker |

两阶段改动范围无重叠，可独立回滚。
