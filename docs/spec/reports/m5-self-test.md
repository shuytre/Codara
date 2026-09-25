# M5 自测报告（索引与记忆）

里程碑：M5 — 代码索引（tree-sitter 符号 + SQLite 全文 + BM25F 轻量语义）与记忆体系（全局/项目两层 + 兼容导入）。

## 交付清单

| 模块 | 文件 | 说明 |
|---|---|---|
| 索引核心 | `sidecar/src/index/mod.rs` | IndexState、SQLite schema（meta/idx_files/idx_symbols/idx_terms/idx_doclen）、7 个 RPC 方法、增量对账、tick 消费 |
| 遍历 | `sidecar/src/index/walk.rs` | 全量 walk（mtime/size）+ 未建库文件名快路径 |
| 语言检测 | `sidecar/src/index/lang.rs` | 扩展名 → 语言标签 |
| 符号提取 | `sidecar/src/index/parse.rs` | tree-sitter 0.21（Rust/TS/TSX/JS/Python/Go）+ 启发式回落；容器追踪（impl/class/trait/receiver） |
| 排序 | `sidecar/src/index/rank.rs` | 标识符感知分词、编辑距离、模糊匹配、BM25、BM25F 字段融合 `fuse()` |
| RPC 注册 | `sidecar/src/dispatch.rs` | `index.build/status/pause/resume/configure/symbols/semantic` |
| 错误码 | `sidecar/src/rpc/error.rs` | `INDEX_BUSY=8001`、`SEMANTIC_DISABLED=8002` |
| symbols 模式 | `sidecar/src/search/grep.rs` | `search.run mode=symbols` 委托 index_symbols |
| 记忆路径 | `electron/src/memory/paths.ts` | 全局 `%USERPROFILE%\.codara\AGENTS.md`、项目 `AGENTS.md`、`.codara/` |
| 记忆解析 | `electron/src/memory/parse.ts` | `## ` 章节切分/还原、8KB 截断读取、幂等追加 |
| 记忆加载 | `electron/src/memory/load.ts` | `loadMemory()` → `{global, project}`，失败静默降级 |
| 记忆注入 | `electron/src/memory/inject.ts` | `withMemory()`；`sandbox:true` 跳过项目记忆正文（规格 4.8） |
| 兼容导入 | `electron/src/memory/import.ts` | `.codex/AGENTS.md`、`.workbuddy/memory/MEMORY.md` → 项目 AGENTS.md，章节幂等 |
| 工具注册 | `electron/src/tools/runtime.ts` | `index.symbols` / `index.semantic` 模型可见工具 + sidecar 路由 |
| 角色矩阵 | `electron/src/crew/roles.ts` | 6 个有 search 权限的角色（除 builder）均可用 index 工具 |
| 网关 | `electron/src/tools/gateway.ts` | index.* 只读 → auto 放行 |
| 注入点 | `electron/src/loop/agentLoop.ts` | systemPrompt 统一过 `withMemory()`；`CrewRunContext.sandbox` |
| IPC | `shared/src/ipc.ts` + `electron/src/ipc/handlers.ts` + `preload.ts` | `memory:load/import/save`、`index:status/configure/build`（全 zod 校验） |
| UI | `renderer/src/components/settings/SettingsPage.tsx` | 记忆状态区块 + 一次性导入按钮 |
| 设置 | `electron/src/config/settingsStore.ts` | `memoryImported` 一次性向导标记 |

## 验证矩阵

| 检查项 | 结果 | 证据 |
|---|---|---|
| Rust 单测（pipeline 6 + parse 8 + rank 15） | ✅ 28/28 | `cargo test` 全绿 |
| main 单测（gateway 7 + memory 17 + index-tools 7） | ✅ 31/31 | vitest project=main |
| 集成测试（M5 新增 10 + 原有 47） | ✅ 57/57 | vitest project=integration |
| 全仓 typecheck | ✅ 0 错误 | `pnpm -r typecheck` |
| electron / renderer / sidecar 构建 | ✅ | esbuild + vite + cargo release |

## 关键行为验证（集成测试，真实 sidecar 进程）

1. **索引生命周期**：status 未初始化 → build 两 tick → `files≥2, symbols≥2, gen≥1`，cacheRef 格式 `idx:<wsHash>:<gen>`。
2. **符号查询**：`index.symbols {name:"greet"}` 返回 trait `Greeter` 与 impl `User` 两个符号，容器正确。
3. **快路径**：未建库时 `index.symbols` 返回 `fastPath:true` + 文件名匹配（首搜 <1s 口径）。
4. **语义开关**：默认 `index.semantic` 返回 `8002 SEMANTIC_DISABLED`；`index.configure {semantic:true}` 后返回排序结果。
5. **BM25F 三字段融合**（冒烟）：query "payment" 下三字段全中的 `payment_service.py`（score 5.496）> 纯文件名/弱命中 `docs/payment-notes.md`（2.425）> 无命中（不入榜）；分数单调递减。
6. **暂停/恢复**：pause 后 build 返回 `paused:true, scanned:0`；resume 后正常消费队列。
7. **search 委托**：`search.run mode=symbols` 走代码索引。
8. **记忆注入**：项目 `AGENTS.md` 注入 system 消息（`### 项目记忆` 块）；无记忆时不追加注入块。
9. **沙箱豁免（规格 4.8）**：`crew.sandbox=true` 时全局记忆保留、项目记忆正文不出现在 system 消息。
10. **全员注入（规格 4.5）**：普通 crew 角色 system 消息含全局+项目两层记忆；会话历史隔离不变。

## 规格对齐

- **3.7/5.2**：无启动全量扫描；增量对账 + tick 分片（默认 ≤500 文件/tick）；可限速可暂停。
- **5.4**：轻量语义默认关闭，需显式 configure；关闭时 8002 附开启指引。
- **7.6**：两层记忆路径与 `.codara/` 目录约定；`.codex/`、`.workbuddy/` 一次性兼容导入（幂等防重复灌入）；可视化编辑器基础（memory:save）。
- **4.5**：记忆统一注入所有角色。
- **4.8**：沙箱临时技术会话不注入项目记忆正文。

## 已知限制

1. tree-sitter 符号提取支持 Rust/TS/TSX/JS/Python/Go，其余语言走行级启发式回落（规格允许）。
2. 单文件 512KB 上限（超限只记元数据）、单文件 4096 词条上限、记忆单文件 8KB 上限。
3. `index.semantic` 候选 term 上限 2000 行/查询词（超大工作区长尾词可能截断）。
4. 可视化记忆编辑器本期仅提供保存通道（memory:save）与状态展示，完整编辑器 UI 属后续里程碑。
