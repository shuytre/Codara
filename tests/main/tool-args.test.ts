// tool_call.arguments 解析回归测试：坏形态自修复 + 失败必须抛错（禁止静默吞参）
// 背景：原实现 JSON.parse 失败后静默用 {}，模型只收到「缺参数」并原样重发
// 同样的坏 JSON，工具调用陷入无终点失败循环。
import { describe, expect, it } from 'vitest';

import { parseToolArgs } from '../../electron/src/loop/agentLoop';

describe('parseToolArgs', () => {
  it('合法 JSON 原样解析', () => {
    expect(parseToolArgs('{"path":"a.txt","edits":[]}')).toEqual({ path: 'a.txt', edits: [] });
  });

  it('空参数返回空对象', () => {
    expect(parseToolArgs('')).toEqual({});
    expect(parseToolArgs('   ')).toEqual({});
  });

  it('markdown 代码围栏包裹 → 剥围栏解析', () => {
    const raw = '```json\n{"path":"a.txt","create":true}\n```';
    expect(parseToolArgs(raw)).toEqual({ path: 'a.txt', create: true });
  });

  it('JSON 前混入说明文字 → 剥到首个花括号', () => {
    const raw = '好的，我来写入文件：{"path":"a.txt","edits":[{"newText":"hi"}]}';
    expect(parseToolArgs(raw)).toEqual({ path: 'a.txt', edits: [{ newText: 'hi' }] });
  });

  it('尾逗号 → 修复后解析', () => {
    expect(parseToolArgs('{"path":"a.txt","edits":[],}')).toEqual({ path: 'a.txt', edits: [] });
    expect(parseToolArgs('{"items":[1,2,]}')).toEqual({ items: [1, 2] });
  });

  it('围栏 + 尾逗号复合坏形态', () => {
    const raw = '```json\n{"path":"b.txt","edits":[{"newText":"x"},],}\n```';
    expect(parseToolArgs(raw)).toEqual({ path: 'b.txt', edits: [{ newText: 'x' }] });
  });

  it('括号未闭合（截断）→ 补齐后缀后解析（第四轮新增）', () => {
    expect(parseToolArgs('{"path": "a.txt"')).toEqual({ path: 'a.txt' });
    expect(parseToolArgs('{"edits":[{"newText":"x"}]')).toEqual({ edits: [{ newText: 'x' }] });
  });

  it('单引号键值 → 激进修复后解析（第四轮新增）', () => {
    expect(parseToolArgs("{'path':'a.txt','create':true}")).toEqual({ path: 'a.txt', create: true });
  });

  it('完全不可解析时抛错（错误信息含原文摘要），不再静默返回 {}', () => {
    expect(() => parseToolArgs('这不是 JSON')).toThrow(/不是合法 JSON/);
    const thrown = (() => {
      try {
        parseToolArgs('{"broken": true,,}');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(thrown).toContain('{"broken": true,,}');
  });

  it('字符串内容中的全角字符不被改写（防激进替换破坏数据）', () => {
    const raw = '{"newText":"你好，世界 —— 全角逗号是内容"}';
    expect(parseToolArgs(raw)).toEqual({ newText: '你好，世界 —— 全角逗号是内容' });
  });
});
