# Codara 代码审查报告 · open-code-review (ocr v1.12.10)

- **审查工具**：`ocr` (alibaba/open-code-review) · **委托模式**（宿主 Agent 执行，未配置 LLM 端点）
- **审查范围**：`df900f2..HEAD`（全量历史），51 个可审查文件 / 6583 行新增
- **基线**：commit `1e68952` → 修复后 `HEAD`
- **审查时间**：2026-09-29

---

## 0. 既定设计口径（项目方 2026-09-29 确认，**不作为缺陷**）

> 以下为经项目方明确指定的架构口径，本次审查**确认保留**，后续审查不得再误报：

**人工审查中间层强制保留**
- 所有高危命令、读写类命令**全部提交人工审查**，该审查环节是唯一且强制的防线，**暂不额外划分其他权限**；
- 保留审批卡片；**危险命令不额外拦截**，与普通审查卡同一套流程处理；
- 模型**直接输出终端原始命令**，sidecar 不做约束、不改写、不做违禁词过滤；
- 模型**自行选定 Shell 类型**（CMD / Bash / PowerShell）并用括号标注，按正常流程流转，等待人工审核执行。

**审查基线推论**：`sidecar/src/governance/cmd_rules.rs` 仅保留「空命令 + 2000 字符上限」两条工程保护、`high_risk` 恒为 false，均为上述口径的**正确实现**，不是缺陷。风险识别上移到 Electron 网关、网关是唯一防线，亦为设计意图。

> 说明：原报告曾将「命令内容不过滤」「高风险不拦截」列为问题，现依项目方口径**全部撤除**。

---

## 1. 本轮已修复项（7 项）

### ✅ C1（严重）行区间形态对已存在文件触发整体覆盖 → 已修复

**位置**：`electron/src/tools/runtime.ts` `normalizeWriteParams`

**原缺陷链**
1. 行区间形态（`contentLines`/`lines` 无 `oldLines`）被打 `__append` 标记；
2. 随后 `create: hasAppend ? true : create` **强制覆写 `create=true`**；
3. `patch.rs` 判定 `overwrite_existing` → 走整文件覆盖分支，**不匹配锚点、不校验 baselineHash**；
4. 已存在文件被替换为仅含目标行的内容，**其余内容静默丢失**，并发写保护一并被绕过。

**PoC（修复前实测）**
```
[【危险】已存在文件 + 行区间]
  normalize → create = true | edits = [{"newText":"// 只改这一行"}]
  patch.rs → OVERWRITE(整体覆盖)
  ⚠️  原内容丢失；且 create 路径不做 baselineHash 校验 → 并发写保护被绕过
```

**修复**：`create` 改为三态分流，**不再臆造覆盖意图**
- `create === false` 且行区间无 `oldLines` → **返回 `null` 拒绝**（回注可自纠错误），绝不静默覆盖；
- `create === true` / 未声明 → 才允许拼接为整文件内容（新建/重写语义）。

**回归守卫**（`tests/main/write-normalize.test.ts` 新增 3 例）
- `create=false + 行区间无 oldLines → 必须 null`（原断言 `create===true` 已删除，该断言曾把错误行为固化）
- `create=false + 行区间带 oldLines → 精确替换且 create=false`
- `create=true + 行区间无原文 → 仍可整体覆盖`

### ✅ M1（中危）覆盖路径绕过基线校验 → 已修复
`sidecar/src/fsops/patch.rs` —— 移除 `exists` 分支内的冗余 hasher，**明确对所有已存在文件的写入（含覆盖分支）统一做 `baselineHash` 复核**，并加注释说明为何不能只护编辑分支。网关对 1002 的自愈重试流程保持不变。

### ✅ H2（决策落地）`write` 越界口径定稿 → 已固化
- 决策：**`write` 只写工作区内，越界由 sidecar 按 `PATH_ESCAPED(1001)` 硬拒，不签发越界放行令牌**（不留「批准即可越界」的口子）；
- `electron/src/tools/gateway.ts` 写入定稿注释；`write` 工具 `path` 参数描述补明「只能写工作区内文件，越界会被拒绝（错误码 1001）」；
- 残留风险：模型可能改道 `terminal` 达成越界写入 —— 需在 base prompt 侧约束（**待办，见第 3 节**）。

### ✅ M2（中危）审批监听器「一票通过」语义 → 已修复
`electron/src/tools/gateway.ts` —— 原 `for (const l of listeners) approved = (await l(card)) || approved` 会**逐个 await 全部监听器、任一 true 即放行**，且会在上一张卡仍等待时又弹下一张。改为**首响即决**：只取首个监听器裁决并立即返回，一次操作 = 一张卡 = 一次裁决；其余卡片由上层 `resolveApprovalCard` 统一收尾。

### ✅ M4（中危）`msg.append` 的 role 未校验 → 已修复
`sidecar/src/db/sessions.rs` —— 在 sidecar 入口硬校验：
- `role ∈ {user, assistant, tool, system}`，非法值返回 `INVALID_PARAMS`（防污染历史回放 / 触发接口 400）；
- `role === "tool"` 必须携带 `toolCallId`，否则拒绝（防孤立工具消息在回放时被静默过滤丢弃）。

### ✅ M5（中危）审计日志日期换算无测试 → 已补测
`sidecar/src/audit/rotating.rs` 新增 3 个单测锁定跨年边界：`epoch 0 → 19700101`、`2024-01-01 / 2024-02-29 / 2023-12-31`、日内稳定性。

> 过程中测试**抓到了我自己写错的期望值**（把 2/28 的 19781 天当成 2/29），实现本身正确 —— 恰好印证该处逻辑值得用测试锁死。

### ✅ L2 / L3（低危）→ 已处理
- **L2** `electron/src/main.ts`：`if (ui.minimalMode) {...} else {...}` 两分支行为完全相同，已收敛为单一实现并注明「曾计划用于关动画但未接入，保留空 else 会制造已生效的错觉」；
- **L3** `electron/src/tools/gateway.ts`：给 `HIGH_RISK_TERMINAL` 补充**带路径前缀的可执行名**（`C:\...\{rd,del,format,...}.exe`）与 `rimraf/shred/wipe/sdelete` 形态，减少「危险命令未高亮」的误导。**仅影响风险标注，不影响「都必须人工审查」这一结论**，故不是安全边界。

---

## 2. 未修复项（需决策或后续排期）

### ⏳ M3（中危）`open_conn` 每 RPC 新建 SQLite 连接
`sidecar/src/db/sessions.rs:12-40` —— 每次调用打开新连接、依赖 `Drop` 关闭，且每连接执行一次 `CREATE TABLE IF NOT EXISTS`。高频 `msg.append`（每条流式消息一次）下反复创建/销毁。**建议**：连接复用或缓存，建表收敛到 `db.migrate` 单点。属性能与整洁性改进，非缺陷，本轮未动以免影响面扩大。

### ⏳ L4（低危）`redact` 只按键名脱敏
`sidecar/src/audit/rotating.rs:52-71` —— 凭据若出现在**值**里（如命令串 `--token=xxx`）不会被命中。建议补常见凭据模式正则。属加固项。

---

## 3. 需一并处理的关联待办

**base prompt 侧禁止以 terminal 规避 write 越界**
H2 已定稿「write 永不越界」，但模型仍可能改用 `terminal` 写工作区外文件（terminal 按既定口径不做内容过滤，只过人工审查卡）。**唯一防线是人工审查**，因此建议：
1. 在 base prompt 中明确「不得使用 terminal 绕过 write 的工作区边界」；
2. 顺带处理交接文档「已知问题 2」——LLM 偶发自称「Ask 模式」的免疫声明；
3. 顺带处理「已知问题 4」——base prompt 开头「极简长编码模式」措辞与三模式语义易混淆。

> 以上属 `docs/spec/modes/` 预设提示词改动，未在本轮代码修复范围内，请确认措辞后我再改。

---

## 4. 验证结果（本轮全部真机执行）

| 项目 | 结果 |
|---|---|
| `cargo test`（sidecar） | **43 passed / 0 failed** |
| `pnpm typecheck`（shared + electron + renderer） | **全绿** |
| `pnpm test:main` | **186 passed**(12 files)，含 `write-normalize` 10 例 |
| `pnpm test:renderer` | **7 passed** |
| `pnpm test:integration`（真实 sidecar 子进程 e2e） | **66 passed**(4 files) |
| sidecar release 编译 | 成功（`codara-sidecar` 8.8MB） |

> 与交接文档「electron 69 + integration 57」的差异系仓库后续提交新增用例所致，当前全绿。

---

## 5. 值得肯定（保持）

- `state.rs:54-94` 路径解析：词法规范化 + **真实路径二次校验**，明确覆盖符号链接/目录联接逃逸（Win7 `mklink /J` 免管理员），新建文件退化为校验父目录 —— 本仓库质量最高的一段安全代码；
- `ckpt/lock.rs:32-45`：`create_new` 原子占位规避 TOCTOU，注释直指「两进程可同时通过 exists 检查」；
- `runtime.ts:415-426`：自愈重试**只对 1002 生效且强制重读 hash**，明确拒绝「丢 hash 重试」；
- `main.ts:167-174`：8s 强制 show 兜底，贴合 Win7 GPU 崩溃场景；
- `markdown.ts`：模型输出经 marked + DOMPurify 消毒，XSS 面处理正确。

---

## 附：复现审查方式

```bash
npm install -g @alibaba-group/open-code-review
cd <repo>
ocr delegate preview --from <base> --to HEAD    # 可审查文件与范围
ocr delegate rule <file...> -b "<业务背景>"      # 该文件适用的审查规则
```

> 委托模式无需 LLM 端点；如需自动 LLM 审查，运行 `ocr config provider` 配置模型后使用 `ocr review --audience agent -b "<背景>"`。
