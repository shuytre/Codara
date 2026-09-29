// 渲染层回归测试：左栏会话切换 / 删除
//
// 这个文件的存在本身就是一次教训：仓库早已在 vitest.workspace.ts 里声明了 renderer
// 项目、renderer 包也有 test 脚本，但 tests/renderer/ 目录一直不存在（--passWithNoTests
// 让 CI 一路绿灯）。于是「删除按钮点击无效」这种**只在渲染期语义下才暴露**的缺陷
// 完美躲过了 typecheck（类型合法）与 main/integration 测试（不碰组件）。
//
// 本文件覆盖两类缺陷，均来自真实用户反馈：
//   1. 删除按钮无响应 —— 事件处理器引用 TDZ 中的 const
//   2. 切换会话后内容消失 —— 历史消息映射把工具调用行整条丢弃
import { transformSync } from '@babel/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 仓库根：本文件在 <root>/tests/renderer/ 下 */
const REPO_ROOT = resolve(__dirname, '../..');

/**
 * 用真实 Solid 编译器把组件源码编译成可执行 JS，并真的去点一下。
 * 返回 click()：调用它会执行挂载在按钮上的 $$click 处理器。
 */
function compileAndClick(componentSource: string): () => void {
  const out = transformSync(componentSource, {
    filename: 'probe.jsx',
    presets: [require('babel-preset-solid')],
    parserOpts: { plugins: ['jsx'] },
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error('Solid 编译失败');

  // 剥掉 import 行（求值环境用注入的参数代替），并把 export 去掉
  const body = out.code
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');

  // 注入 Solid 运行时替身。
  // template(html) 必须返回**一个工厂函数**：Solid 的用法是
  //   const _tmpl$ = template(`<div>...`);   // 编译期调用一次 → 拿到工厂
  //   var _el$ = _tmpl$();                   // 运行期调用工厂 → 拿到真实节点
  // 替身节点只支持 firstChild / nextSibling 链，$$click 会挂到链末端的按钮上。
  const makeNode = (): Record<string, unknown> => ({});
  const template = (_html: string) => {
    const btn = makeNode();
    const first = makeNode();
    first.nextSibling = btn;
    const node: Record<string, unknown> = {
      firstChild: first,
      nextSibling: btn,
      cloneNode: () => template(_html)(),
    };
    return () => node;
  };
  const insert = () => undefined;
  const createComponent = () => makeNode();
  const delegateEvents = () => undefined;

  // Solid 编译产物用 _$(template|insert|...) 等名字，还会 hoist 一个 _tmpl$ 模板常量
  // （形如 `var _tmpl$ = /*#__PURE__*/template(...)`，后续用 `_tmpl$()` 复用）。
  // 这里把 hoist 常量名换成 __tpl，并把它的用法一并改名，避免与注入的 template 参数遮蔽。
  const renamed = body
    .replace(/_\$template\b/g, 'template')
    .replace(/_\$insert\b/g, 'insert')
    .replace(/_\$createComponent\b/g, 'createComponent')
    .replace(/_\$delegateEvents\b/g, 'delegateEvents')
    // 先改声明：var _tmpl$ = template(...) → const __tpl = template(...)
    .replace(/\bvar\s+_tmpl\$\s*=/, 'const __tpl =')
    // 再把剩余引用 _tmpl$ 改为 __tpl
    .replace(/\b_tmpl\$/g, '__tpl');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn2 = new Function(
    'template',
    'insert',
    'createComponent',
    'delegateEvents',
    `${renamed}\n; return typeof Comp === 'function' ? Comp : null;`,
  ) as (
    t: unknown,
    i: unknown,
    c: unknown,
    d: unknown,
  ) => null | (() => Record<string, unknown>);

  const Comp = fn2(template, insert, createComponent, delegateEvents);
  if (!Comp) throw new Error('未能从编译产物中取到 Comp');

  // 执行组件函数体 → Solid 的构造箭头会在此挂载 $$click
  const root = Comp();
  const handler = root.$$click ?? (root.nextSibling as Record<string, unknown> | undefined)?.$$click;
  const click =
    (handler as ((e: unknown) => void) | undefined) ??
    (() => {
      throw new Error('$$click 未挂载到替身节点');
    });
  return () => click({ stopPropagation: () => undefined });
}

describe('R1: Solid 组件内事件处理器不得引用 return 之后的 const（TDZ）', () => {
  // Solid 会把 JSX 编译成「立即执行的构造箭头」：
  //   return (() => { _el.$$click = e => { void handler(); }; return _el; })();
  // 若 handler 是 const 且声明在 return 之后，渲染期只是"赋值闭包"尚不报错，
  // 但**点击触发时**求值 handler 就命中 TDZ：
  //   ReferenceError: Cannot access 'handler' before initialization
  // 该异常被 Solid 的事件委托吞掉，界面上表现就是「点了没反应」。

  it('反例：const 声明在 return 之后 → 点击抛 ReferenceError（这就是线上「点了没反应」）', () => {
    const src = `
function Comp() {
  return (
    <div class="conv-item">
      <span>t</span>
      <button class="conv-del" onClick={(e) => { e.stopPropagation(); void doDelete('s','t'); }}>
        <i />
      </button>
    </div>
  );
  const doDelete = async () => { globalThis.__DELETED = true; };
}
`;
    expect(compileAndClick(src)).toThrowError(/before initialization/);
  });

  it('正例：声明在 return 之前 → 点击正常执行（当前 LeftPane 的写法）', () => {
    (globalThis as Record<string, unknown>).__DELETED = false;
    const src = `
function Comp() {
  const doDelete = async () => { globalThis.__DELETED = true; };
  return (
    <div class="conv-item">
      <span>t</span>
      <button class="conv-del" onClick={(e) => { e.stopPropagation(); void doDelete('s','t'); }}>
        <i />
      </button>
    </div>
  );
}
`;
    expect(compileAndClick(src)).not.toThrow();
    expect((globalThis as Record<string, unknown>).__DELETED).toBe(true);
  });

  it('真实 LeftPane.tsx：deleteConversation / renderHistory 均在 return 之前声明', () => {
    const file = resolve(REPO_ROOT, 'renderer/src/components/layout/LeftPane.tsx');
    const text = readFileSync(file, 'utf8');
    const returnIdx = text.indexOf('\n  return (');
    expect(returnIdx, 'LeftPane 应存在 return 语句').toBeGreaterThan(-1);

    const before = text.slice(0, returnIdx);
    const after = text.slice(returnIdx);

    // return 之后声明的 const —— 若被事件处理器引用即 TDZ 风险
    const afterConsts = [...after.matchAll(/^\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]!);
    // 事件处理器里出现的标识符（onClick={...} 内）
    const handlerRefs = [...text.matchAll(/onClick=\{[^}]*?\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!);
    const beforeDecls = new Set([...before.matchAll(/(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));

    const risky = afterConsts.filter((name) => handlerRefs.includes(name) && !beforeDecls.has(name));
    expect(risky, `以下标识符在 return 之后声明却被事件处理器引用，会触发 TDZ：${risky.join(', ')}`).toEqual([]);
  });
});

describe('R2: 历史消息映射必须保留工具调用行（否则切换会话内容「消失」）', () => {
  // 复刻 handlers.ts chatSwitch 中「内部上下文 → 渲染层 messages」的映射。
  // 旧实现按 `typeof content === 'string' && content.length > 0` 过滤，而带 tool_calls
  // 的 assistant 行 content 恰好被归一成 null —— 于是工具调用记录被整条丢弃，
  // 只剩孤立的 role='tool' 行，中栏显示为一段无归属的原始 JSON。
  interface Persisted {
    role: string;
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }

  /** 与 handlers.ts 保持一致的映射（修改逻辑时两侧同步） */
  function toRendererMessages(history: Persisted[]) {
    return history
      .filter((m) => Boolean(m.content) || Array.isArray(m.tool_calls) || m.role === 'tool')
      .map((m) => {
        let content = typeof m.content === 'string' ? m.content : null;
        let toolName: string | undefined;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          toolName = m.tool_calls
            .map((t) => t.function?.name)
            .filter((n): n is string => Boolean(n))
            .join(' / ');
          if (!content && toolName) content = `调用工具：${toolName}`;
        }
        return { role: String(m.role), content, toolName };
      });
  }

  const history: Persisted[] = [
    { role: 'user', content: '帮我读一下 a.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true,"data":"hello"}' },
    { role: 'assistant', content: 'a.txt 的内容是 hello' },
  ];

  it('工具调用行不再被丢弃，且带出可读的工具名', () => {
    const out = toRendererMessages(history);
    expect(out).toHaveLength(4);
    const toolCallRow = out[1]!;
    expect(toolCallRow.role).toBe('assistant');
    expect(toolCallRow.toolName).toBe('read');
    // content=null 的 assistant 行合成一句可读摘要，避免中栏空白
    expect(toolCallRow.content).toBe('调用工具：read');
    // 工具返回行必须保留
    expect(out[2]!.role).toBe('tool');
    expect(out[2]!.content).toContain('hello');
  });

  it('旧实现（按 content 非空过滤）会丢 1 条并留下孤立 tool 行 —— 反证', () => {
    const legacy = history
      .filter((m) => typeof m.content === 'string' && m.content.length > 0)
      .map((m) => ({ role: String(m.role), content: String(m.content) }));
    expect(legacy).toHaveLength(3); // 4 条变 3 条
    expect(legacy.some((m) => m.role === 'assistant' && m.content.includes('read'))).toBe(false);
    // 孤立 tool 行：前面没有配对的 assistant tool_calls → 中栏出现无名 JSON
    expect(legacy[1]!.role).toBe('tool');
  });

  it('多工具并行调用时工具名全部带出', () => {
    const out = toRendererMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', function: { name: 'read', arguments: '{}' } },
          { id: 'b', function: { name: 'search', arguments: '{}' } },
        ],
      },
    ]);
    expect(out[0]!.toolName).toBe('read / search');
  });

  it('纯文本消息不受影响', () => {
    const out = toRendererMessages([{ role: 'user', content: '你好' }]);
    expect(out).toEqual([{ role: 'user', content: '你好', toolName: undefined }]);
  });
});
