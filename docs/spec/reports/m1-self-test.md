# Codara M1 自测报告（含 M2 Sidecar 侧）

> 里程碑：M1 对话骨架与首次启动（连带完成 M2 sidecar 侧闭环）
> 环境：Ubuntu 22.04 沙箱（Linux 交叉验证），目标平台 Win7 SP1+ 待回归清单覆盖

## 一、改动清单

### 基础设施（M0/M1）
- pnpm monorepo：`shared/`（契约）、`electron/`（主进程+preload）、`renderer/`（SolidJS UI）、`sidecar/`（Rust 1.77.2）、`tests/integration/`
- Rust 工具链 pin 1.77.2（Win7 Tier1 上限），`rust-toolchain.toml` 固定
- 国内镜像链：rustup（上交）/ crates（rsproxy）/ electron（npmmirror），`/root/.cargo/config.toml` 全局生效

### Shared 契约（TypeScript）
- `envelope.ts`：统一信封 `{ok, data, error?, truncated?, cacheRef?}` + 错误码常量（1001-9003）
- `tools.ts`：五类工具参数/TaskPacket/Artifact 类型
- `model.ts`：ModelConfig/StreamEvent 判别联合 + 6 个国产/本地厂商模板
- `cards.ts`：九类卡片 + BudgetState；`ipc.ts`：IPC 白名单 + zod payload

### Sidecar（Rust，编译通过 + release 18s）
- stdio 行分隔 JSON-RPC（MAX_FRAME 1MB）；`fs.read/patch/meta`（BOM→UTF-8→GB18030 探测、CRLF 保真、基线哈希防过期补丁）
- `search.run`（rg/files/symbols 三模式、glob 含 `!` 排除）；`term.open/exec/close`（持久 cwd、超时轮询 kill）
- `git.exec`（只读/写分级、commit 任务 ID 校验、worktree codara/ 前缀）
- `snap.create/list/restore`（Git 隐藏分支 + CAS 双形态）；`secret.*`（DPAPI/MOCKDPAPI）
- `db.migrate/query/exec`（v1+v2 迁移：会话/消息/用量/任务/实例/交接物/检查点）
- `gov.validate` + 治理管线六步 + 审计轮转（脱敏、500MB 上限）+ `ckpt.*` + TTL 锁

### 主进程（Electron 22.3.27）
- `SidecarManager`：spawn/帧解析/请求-响应关联/崩溃自动重启
- `ModelClient`：手写 SSE 解析、429/5xx 指数退避（尊重 Retry-After）、usage 对账
- `ToolRuntime` + `ApprovalGateway`（auto/ask/deny + 高危正则）+ `AgentLoop`（tool_calls 循环、diff 卡片、三模式系统提示词）
- `BudgetLedger`（200 轮/token/费用熔断）+ `registerIpcHandlers`（全通道 zod 校验）

### 渲染层（SolidJS，chrome108 target）
- 首次启动三步向导、主布局（左会话树/中对话流/右状态）、九类卡片渲染、设置页、用量面板

## 二、本轮修复（测试暴露的 9 个缺陷）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | CAS 快照首次调用**死锁** | `match state.cas.lock().unwrap().as_mut()` 的锁守卫在 None 分支存活，分支内重复 lock | 先判 `is_none()` 再分段加锁（snapshot/mod.rs） |
| 2 | CAS manifest 写失败 ENOENT | `manifests/` 目录从未创建 | `CasStore::new` 预建 blobs/manifests（cas.rs） |
| 3 | git commit 预授权返回 4001 | `preAuthorized` 在 args 内，git.rs 只读顶层 | 顶层/args 双兼容（git.rs） |
| 4 | worktree 创建 fatal already exists | 路径写到 `/tmp/<name>-wt`，跨运行残留 | 改 `.codara/worktrees/<name>` + `-B` 强制分支（git.rs） |
| 5 | term.exec 非零退出信封无 data | `err_with` 把 data 放 `error.data`，顶层为空 | 退出码优先：非零退出（含超时 124）信封 ok=true，exitCode 走 data（session.rs） |
| 6 | fs.patch create=true 新建失败 | 空文件仍尝试 oldText 匹配 → 1006 | create 模式直接以 newText 拼接为初始内容（patch.rs） |
| 7 | PS 子集校验漏放行 | 仅对 `powershell` 前缀命令校验 | windows 平台含禁用 cmdlet 即拒（保留原始大小写进 message）（cmd_rules.rs） |
| 8 | db 参数化查询 0 行 | `Value::to_string()` 给字符串包 JSON 引号 | JSON→rusqlite 类型映射 `json_to_sql`（db/mod.rs） |
| 9 | mock-llm 3 测试全挂 | server.mjs 第 62 行语法错误（对象未闭合）server 起不来 | 修复括号 |
| 10 | 落盘内容为截断后文本 | govern 落盘 `truncated_out` | 落盘改存去噪后**完整输出**，聚合只影响返回视图（pipeline.rs） |

## 三、决策理由

1. **term.exec 非零退出 = ok:true**：信封 ok 表达"RPC 是否成功执行"，命令失败由 `data.exitCode/stderr` 承载（规格 3.3.4 退出码优先）；校验拒绝（3001 等）才走 ok:false。
2. **聚合不进落盘**：落盘是用户回看原始输出的通道，保留原始；返回上下文用聚合视图省 token。
3. **worktree 收进工作区**：`../` 外溢路径在 Windows 与多任务下均不可控，`.codara/worktrees/` 随快照/清理体系统一管理。
4. **验证口径**：沙箱为 Linux，Windows 专属项（DPAPI 真实加解密、cmd/PS 语义、IE11 内嵌）全部列入 `docs/spec/win7-regression.md` 由用户回归。

## 四、自测结果

| 套件 | 结果 |
|---|---|
| Rust 单元测试（治理管线 6 项） | **6 passed / 0 failed** |
| 集成测试 sidecar.test.ts（协议/fs/补丁/编码/治理/PS/高危/git/快照双形态/secret/db/ckpt/lock/audit 脱敏） | **38 passed** |
| 集成测试 mock-llm.test.ts（SSE 流式/429 三次恢复/工具调用） | **3 passed** |
| 三包构建（shared tsc / electron esbuild / renderer vite chrome108） | **全绿** |
| Electron Linux 冒烟（xvfb + --no-sandbox） | **通过**：sidecar spawn → db.migrate → lock.inspect 返回 ok:true → IPC 注册 → 窗口创建，进程存活无应用层错误 |

## 五、遗留问题

1. Win7 专属回归项待用户在 Windows 执行（docs/spec/win7-regression.md A1-A6/B1-B7/C1-C7/D1-D3）。
2. mock-llm 的 usage 对账为字符估算（chars/4），真实端点接入后需按厂商 usage 字段校准。
3. Electron 冒烟未覆盖渲染层交互（无 xvfb 截图断言），窗口内容以人工检查 + Win7 回归为准。
4. M2「3 个真实仓库」验收（含 GBK/CRLF 老项目端到端）需真实环境，沙箱内以编码保真集成测试替代覆盖。

## 六、下一步（M3 专家团内核）

1. 7 角色定义（提示词/工具权限矩阵/交接物模板），Builder 桩
2. 双层状态机 + `.codara/tasks/<id>/` 任务工作区 + Task Packet/Artifact schema（zod 校验）
3. CrewScheduler：并发信号量（默认 2）+ 429 退避共享 + 排队可观测
4. sidecar `msg.append/msg.list` 会话隔离强制校验（跨角色读历史 100% 失败）
5. task.spawn/handoff 调度工具（主进程 ToolRuntime 特判，不进 sidecar 工具面）
