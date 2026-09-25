# M5–M7 最终交付报告

项目：Codara 对话式编程 Agent（Win7 SP1+ / .NET 约束侧下限 Electron 22.3.27 + Rust 1.77.2 MSRV）
范围：《Codara 对话式编程 Agent 开发主提示文档 (v1.1)》里程碑 **M5 / M6 / M7**（M1–M4 已于上一阶段交付）。
用户确认口径：M5 轻量本地方案（纯 Rust BM25F，零模型文件）；M6 脚本+逻辑+单测（真机项归档）；M7 立项文档。

---

## 总览

| 里程碑 | 主题 | 状态 |
|---|---|---|
| M5 | 代码索引（tree-sitter 符号 + SQLite 全文 + BM25F 轻量语义）与记忆体系 | ✅ 完成 |
| M6 | 安装分发（Win 检测 / 备份计划 / NSIS 双形态 / NOTICES / 更新配置） | ✅ 完成 |
| M7 | 六项后续能力立项文档 | ✅ 完成 |

## M5 交付

**索引（sidecar `src/index/`）**
- 7 个 RPC：`index.build/status/pause/resume/configure/symbols/semantic`（增量 tick ≤500 文件、mtime+size+hash 变更检测、禁启动扫描 3.7/5.2）。
- tree-sitter 0.21（锁 MSRV）五语言符号提取（Rust/TS/TSX/JS/Python/Go）+ 启发式回落；容器追踪（impl/class/trait/receiver）。
- SQLite 库 `appData/index/<wsHash>.db`（per-user）：idx_files/idx_symbols/idx_terms/idx_doclen + meta。
- BM25F 三字段融合（name×3 / path×2 / content×1，`fuse()` 封顶防淹没）；标识符感知分词；模糊匹配（前缀/子串/编辑距离 ≤2）。
- `index.semantic` 默认关（8002 附指引，5.4）；`index.symbols` 未建库文件名快路径（首搜 <1s）；`search.run mode=symbols` 委托索引。
- 错误码：`INDEX_BUSY 8001`、`SEMANTIC_DISABLED 8002`。

**记忆（electron `src/memory/`）**
- 两层：全局 `%USERPROFILE%\.codara\AGENTS.md` + 项目根 `AGENTS.md`；单文件 8KB 截断（token 膨胀防护）。
- `withMemory()` 统一注入所有角色 system prompt（4.5）；**沙箱临时会话跳过项目记忆正文**（4.8，`CrewRunContext.sandbox`）。
- 兼容导入 `.codex/AGENTS.md`、`.workbuddy/memory/MEMORY.md`（章节幂等 + `memoryImported` 一次性向导标记）。
- IPC 六通道（memory:load/import/save + index:status/configure/build，全 zod 校验）+ preload 暴露 + 设置页记忆区块与导入按钮。
- `index.symbols` / `index.semantic` 注册为模型工具（6 角色 + 极简模式，builder 除外），网关只读 auto 放行。

## M6 交付（`installer/`）

- `lib/winDetect.ts`：RTM/SP1 判定、KB4490628→KB4474419 补丁链、WMF5.1 需求、wmic 输出解析、exec 参数注入（#14 非阻塞口径）。
- `lib/backupPlan.ts`：升级备份计划（`.bak-<ver>` 避让）、回滚清单落盘、卸载保留数据决策（7.8）。
- `nsis/`：common.nsh（32 位/RTM 拒绝页、KB 引导页默认勾选可跳过不阻断、升级备份钩子、卸载数据页）+ 在线 stub（INetC）+ 离线全量两形态 × per-user/admin 变体；**零第三方插件**（仅 NSIS 3 自带）。
- `scripts/`：build-installer.mjs（四变体 + 体积预算硬校验 ≤10MB/≤180MB）、gen-notices.mjs（npm=213/cargo=79 + MinGit GPLv2/字体 OFL 手工条目）、gen-update-yml.mjs（electron-updater 锁版 6.3.9 + 国内镜像）。
- 真机项 E1–E13 归档 `docs/spec/win7-regression.md` E 节。

## M7 交付（`docs/spec/proposals/`，每篇一页：范围/非目标/WBS/验收标准/风险与体积成本）

| 文档 | 核心口径 |
|---|---|
| `web-fetch.md` | 总开关默认关；白名单域名 auto、其余 ask；内网地址默认拒绝 |
| `multimodal-preset.md` | 标准 + screenshot/视觉输入；Win7 GDI 兜底先行；非视觉底座禁用 |
| `mcp-tools.md` | stdio 传输；每服务器单独授权纳入网关；Goal 预授权不越权覆盖 |
| `browser-automation.md` | Chromium 108；体积主风险 → 独立按需下载包（推荐）或放宽离线预算 |
| `ptc-preset.md` | run_code 单工具；安全边界由工具管道承担；建议实验开关灰度 |
| `enterprise-deploy.md` | enterprise.json 预置先行，锁设置/MSI 分期；ADR-11 对齐 |

## 验证矩阵（最终全量）

| 检查项 | 结果 |
|---|---|
| `pnpm -r typecheck` | ✅ 0 错误 |
| main + contract 单测（gateway 7 / memory 17 / index-tools 7 / winDetect 15 / backupPlan 10） | ✅ 56/56 |
| 集成测试（真实 sidecar 进程；M5 新增 10） | ✅ 57/57 |
| Rust 单测（pipeline 6 / parse 8 / rank 15） | ✅ 28/28 |
| 构建（shared/electron/renderer/sidecar release） | ✅ 全绿 |
| NSIS 四变体编译冒烟（makensis 3.09） | ✅ 产物 4 份 |

## 关键证据（行为级）

1. BM25F 三字段竞争冒烟：query "payment" → 三字段全中代码文件（5.496）> 纯文件名/散文（2.425）> 无命中不入榜，分数单调递减。
2. 语义开关：默认 8002 → configure 开 → 排序结果；pause 后 build `scanned:0`，resume 恢复。
3. 沙箱豁免（4.8）：`sandbox:true` 会话 system 消息含全局记忆、**不含**项目记忆正文；普通 crew 角色两层齐全（4.5）。
4. 兼容导入幂等：重复导入 skipped，正文不重复；已有项目记忆追加不覆盖。
5. winDetect 表驱动：RTM 拒绝/SP1 需两 KB/8.1·10 不适用；wmic 异常 detectFailed=true 且放行（非阻塞）。

## 自测报告索引

- `docs/spec/reports/m5-self-test.md`
- `docs/spec/reports/m6-self-test.md`
- `docs/spec/reports/final-delivery.md`（M1–M4，上一阶段）

## 已知限制与后续

1. 符号提取支持五语言（其余启发式回落，规格允许）；单文件 512KB / 4096 词条 / 记忆 8KB 上限。
2. 可视化记忆编辑器仅保存通道与状态展示，完整编辑器随后续迭代。
3. M6 真机项（E1–E13）需 Win7 SP1 实机执行后闭环。
4. NSIS online 变体在 Windows 构建宿主需启用 `CODARA_HAS_INETC`（Linux 冒烟走桩分支）。
5. M7 六项均为**立项未排期**状态，进入开发需按各自 WBS 与验收标准重新评审。
