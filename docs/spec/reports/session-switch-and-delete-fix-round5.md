# 会话切换丢内容 / 删除按钮无响应 · 第 5 轮

> 触发：用户回传截图（左栏仅「主对话」+ 一条旧会话）并反馈两个问题：
> ① 切换对话记录后，之前的对话内容就消失了；② 点击删除按钮没有任何反应。
> 结论：两个问题都是**真缺陷**，且都属于「只在运行期语义下才暴露」的类型 ——
> typecheck 与既有单测全部绿灯，问题依然存在。

## 一、先说结论

| # | 问题 | 根因 | 代码位置 |
|---|---|---|---|
| 1 | 切换会话后内容消失 | 回传渲染层的历史消息被 `content` 非空过滤，**把带 `tool_calls` 的 assistant 行整条丢掉**（其 `content` 恰好被上游归一成 `null`） | `electron/src/ipc/handlers.ts` L341-346 |
| 1' | 切回「主对话」中栏一片空白 | `switchToMainAsync()` 只 `clearStream()`，**从未重建历史** | `renderer/src/components/layout/LeftPane.tsx` L181-196（改前） |
| 2 | 删除按钮点了没反应 | `const deleteConversation` 声明在 `return` **之后**，事件处理器触发时命中 **TDZ**：`ReferenceError: Cannot access 'deleteConversation' before initialization` | `LeftPane.tsx` L111/L131 引用 vs L155 定义（改前） |

> 关于「截图里看不到删除按钮」：这是**正常行为** —— 按钮由 `.conv-item:hover .conv-del` 控制
> 悬停显形，鼠标不在会话行上时本就不显示。这一点与「点击无响应」是两回事，后者才是真 bug。

## 二、问题一：切换会话后内容消失

### 2.1 丢消息的机制（已复现）

`chatSwitch` 先把带 `tool_calls` 的 assistant 行归一成 `content = null`（L319-321，
这是 OpenAI 兼容接口的要求），然后回传渲染层时却用：

```ts
.filter((m) => typeof m.content === 'string' && m.content.length > 0)
```

**同一条消息先被归一、后被丢弃。** 本地用 4 条历史的样例直接复现：

```
原始历史条数: 4
回传渲染层条数: 3
丢失的条目:
  ✗ assistant null (带 tool_calls)
```

副产物：上游 L330-338 的「孤立 tool 消息」清理**只作用于发给模型的副本**，
回传渲染层的副本没清 → 中栏出现一条**没有归属的 `role:'tool'` 原始 JSON**。

### 2.2 主对话路径完全没重建

`switchToMainAsync()` 拿到 `main.sessionId`、调完 `chatSwitch` 后只做了：

```ts
clearStream();
setActiveConversation(null);
```

**没有任何 appendEntry** → 点「主对话」必然白屏。用户还会把「白屏」误读成历史被删。

### 2.3 修复

- **主进程**（`handlers.ts`）：过滤条件改为保留工具行
  `Boolean(m.content) || Array.isArray(m.tool_calls) || m.role === 'tool'`；
  并带出 `toolName`，让 `content=null` 的 assistant 行合成一句可读摘要
  （`调用工具：read / search`），中栏不再是空白或无名 JSON。
- **渲染层**（`LeftPane.tsx`）：抽出公共 `renderHistory()`，供 `switchTo` 与
  `switchToMainAsync` 共用；`role:'tool'` 行渲染成「工具返回：…」系统条。
- **顺带修**：删除当前会话后回主对话时，同样调 `loadHistoryToCenter()` 重建。

## 三、问题二：删除按钮无响应

### 3.1 根因：TDZ（用真实 Solid 编译器验证）

`LeftPane.tsx` 里事件处理器引用 `deleteConversation`，而它声明在 `return` 之后。
Solid 会把 `return` 编译成**立即执行的构造箭头**：

```js
return (() => {
  var _el$ = _tmpl$(), _el$2 = _el$.firstChild, _el$3 = _el$2.nextSibling;
  _el$3.$$click = e => { e.stopPropagation(); void deleteConversation('s','t'); };
  return _el$;
})();
const deleteConversation = async (sessionId, title) => { ... };
```

渲染期「赋值闭包」不读绑定，所以不报错；但**点击触发时**求值 handler 就命中 TDZ。
本地实测：

```
render OK (赋值闭包本身不读绑定)
CLICK THROWS: ReferenceError - Cannot access 'deleteConversation' before initialization
```

该异常被 Solid 的事件委托机制吞掉 → 界面上表现为**「点了没反应」**。

> 为什么只有删除按钮中招？因为在同一文件里切回主对话用的是 `function switchToMain()`
> （函数声明会提升），而删除用的是 `const` 箭头函数（不提升）。两者行为差异正好对上
> 用户的观察：「点主对话有反应（但空白），点删除完全没反应」。

### 3.2 修复

把 `deleteConversation`（以及新增的 `renderHistory` / `loadHistoryToCenter`）
**统一上移到 `return` 之前**，并在原位置留下注释说明这个坑。

## 四、为什么 CI 没发现？—— 补上渲染层测试

仓库 `tests/vitest.workspace.ts` **早已声明 renderer 项目**，`renderer/package.json`
也有 `test` 脚本，但 `tests/renderer/` 目录**从来不存在**；加上脚本带
`--passWithNoTests`，CI 里也从没调用过 `test:renderer` —— 于是渲染层等于**零覆盖**，
「只在渲染期语义下暴露」的缺陷可以完美穿过 typecheck + main + integration 三道关。

本轮补齐：

| 新增 | 内容 |
|---|---|
| `tests/renderer/package.json` | 独立测试包（babel + solid + vitest） |
| `tests/renderer/leftpane.test.ts` | **7 个测试**，见下 |
| `pnpm-workspace.yaml` | 纳入 `tests/renderer` |
| `package.json` | 新增 `test:renderer` 脚本 |
| `.github/workflows/build.yml` | Job 1 新增 `Renderer tests` 步骤 |

测试设计（不是快照，是**会真的失败**的断言）：

1. **反例**：把 `const` 放在 `return` 之后 → 用真实 Solid 编译器编译、真的点一下，
   断言抛 `ReferenceError: ... before initialization`（**这就是线上 bug 本身**）。
2. **正例**：声明在 `return` 之前 → 点击不抛错且副作用生效。
3. **静态守卫**：读取真实 `LeftPane.tsx`，扫描 `return` 之后声明的 `const` 与
   `onClick` 里引用的标识符，交集非空即失败 —— **防止这个坑再次被写回来**。
4. **R2-1**：历史映射保留工具行 + 带出工具名。
5. **R2-2**：旧实现（按 content 非空过滤）会丢 1 条并留下孤立 tool 行 —— **反证**。
6. **R2-3**：多工具并行调用时工具名全部带出。
7. **R2-4**：纯文本消息不受影响。

## 五、修改文件

| 文件 | 改动 |
|---|---|
| `electron/src/ipc/handlers.ts` | 回传历史保留工具行 + 生成可读 `toolName` 摘要；返回类型 `content: string \| null` |
| `renderer/src/components/layout/LeftPane.tsx` | `deleteConversation` 等上移到 `return` 前；抽出 `renderHistory()` / `loadHistoryToCenter()`；`switchToMainAsync` 补历史重建；删除活动会话后回主对话也重建 |
| `renderer/src/ipc/client.ts` | `chatSwitch` 返回类型同步（`content: string \| null` + `toolName?`） |
| `tests/renderer/package.json` | 新建（测试包） |
| `tests/renderer/leftpane.test.ts` | 新建（7 测试） |
| `pnpm-workspace.yaml` / `package.json` / `pnpm-lock.yaml` | 纳入新包 + `test:renderer` 脚本 |
| `.github/workflows/build.yml` | Job 1 新增 renderer 测试步骤 |
| `renderer/package.json` | 补 `@babel/core` / `babel-preset-solid` 测试依赖 |

> 本轮同时包含上一轮（round4）尚未推送的 A/B/C 三块修复（参数自愈、发送前清洗历史、
> 会话删除五层贯通），故 diff 中可见 `agentLoop.ts` / `runtime.ts` / `preload.ts` /
> `shared/src/ipc.ts` / `sidecar/*` / `tests/main/*` / `tests/integration/*` 等文件。

## 六、验证命令与结果

```
pnpm install --frozen-lockfile                     # ✅ Lockfile is up to date
pnpm build:shared                                  # ✅
pnpm -r typecheck                                  # ✅ 6/6 全绿
pnpm --filter @codara/main test                    # ✅ 183 / 183
pnpm --filter @codara/renderer test                # ✅ 7 / 7  （此前 0）
pnpm --filter @codara/tests-integration test       # ✅ 66 / 66
cd sidecar && RUSTUP_TOOLCHAIN=stable cargo test --offline   # ✅ 40 / 40
pnpm build:renderer                                # ✅ vite build 通过
```

## 七、风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 回传历史变多（含工具行）导致渲染层条目增加 | 低 | 工具行本就该可见；`toolName` 让它们可读而非裸 JSON |
| `content: string \| null` 是**破坏性类型变更** | 低 | 三处消费方（handlers / client / LeftPane）已同步；typecheck 6/6 通过 |
| 新增 workspace 包影响 CI 安装 | 低 | `--frozen-lockfile` 本地已验证通过 |
| renderer 测试引入 babel 依赖 | 低 | 仅 devDependencies，不进产物（`pnpm build:renderer` 已验证） |

**回滚**：`git revert` 本轮 commit 即可；若只想回滚渲染层测试，删掉
`tests/renderer/` 并撤销 `pnpm-workspace.yaml` / `package.json` / workflow 三处新增即可，
不影响两个 bug 的修复本身。

## 八、一句话复盘

> 这两个 bug 都属于「**类型正确、单测通过、但用户一用就坏**」。
> 删按钮是 **TDZ**（Solid 的立即执行编译产物碰上 `const` 不提升）；
> 内容消失是**归一化与过滤条件自相矛盾**（上游把 `content` 置 `null`，下游却按非空过滤）。
> 真正的教训是：**渲染层此前零测试覆盖** —— 本轮把这条覆盖补上，并让 CI 强制跑它。
