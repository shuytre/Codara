// 渲染层会话隔离 + 工具卡折叠/时序
//
// 回归背景（用户原话）：
//   「在主任务进行时开启第二个任务，主任务的对话就会突然转到你那个其他的会话，然后快速停止」
//   「切换后右栏显示：暂无工具调用」
//   「工具调用显示为一整块裸 JSON」
//
// 根因都在渲染层：chat.entries / cards.list 是**唯一**的两份全局数组，事件不携带
// sessionId，后到的事件直接写进同一条 live entry。本文件直接测真实的 stores.ts
// （solid store 语义，不 mock），确保分区路由不会再退化。
import { describe, expect, it, beforeEach } from 'vitest';

import {
  MAIN_KEY,
  activeCards,
  activeChat,
  activeKey,
  appendDeltaToLive,
  appendEntry,
  attachCardToLive,
  clearSession,
  convs,
  finalizeLiveEntry,
  headApprovalFor,
  removeConversation,
  resolveApprovalCard,
  setActiveConversation,
  setApprovalCard,
  setConvs,
  setSessionRunning,
  setStreaming,
  upsertCard,
} from '../../renderer/src/state/stores';
import { buildSummaryLine } from '../../renderer/src/components/layout/LeftPane';
import { toolSummaryLine } from '../../electron/src/loop/agentLoop';
import type { ApprovalCard, Card, ToolCallCard } from '@codara/contract';

function toolCard(id: string, sessionId: string, tool = 'search'): ToolCallCard {
  return {
    id,
    type: 'tool-call',
    status: 'running',
    createdAt: Date.now(),
    sessionId,
    tool,
    paramsSummary: '{"pattern":"*.ts"}',
    summaryLine: `${tool} · pattern=*.ts`,
  };
}

function approvalCard(token: string, sessionId: string): ApprovalCard {
  return {
    id: `approval-${token}`,
    type: 'approval',
    status: 'pending',
    createdAt: Date.now(),
    sessionId,
    title: '批准 terminal 操作',
    reason: 'echo hi',
    risk: 'medium',
    payload: { command: 'echo hi' },
    approvalToken: token,
  };
}

beforeEach(() => {
  setConvs({ list: [], activeId: null, running: [], mainId: 'main-1' });
  setConvs('list', []);
  for (const id of ['main-1', 'sess-a', 'sess-b']) {
    clearSession(id);
  }
  setApprovalCard(null);
});

describe('渲染层 — 会话分区隔离', () => {
  it('主对话的 key 是真实 sessionId（不是 __main__ 占位）', () => {
    // 否则主对话的流式/工具卡落不到任何分区：用户看到「主对话突然没反应」
    expect(activeKey()).toBe('main-1');
    setActiveConversation('sess-a');
    expect(activeKey()).toBe('sess-a');
    setActiveConversation(null);
    expect(activeKey()).toBe('main-1');
  });

  it('未拿到主对话 id 时退回占位 key 而不是崩', () => {
    setConvs('mainId', null);
    expect(activeKey()).toBe(MAIN_KEY);
  });

  it('两个会话的流式内容互不干扰（回归：后到事件顶掉前一个）', () => {
    appendDeltaToLive('sess-a', 'A的第一段');
    appendDeltaToLive('sess-b', 'B的第一段');
    appendDeltaToLive('sess-a', 'A的第二段');

    setActiveConversation('sess-a');
    const a = activeChat();
    expect(a.entries.filter((e) => e.role === 'assistant').map((e) => e.text).join('')).toBe('A的第一段A的第二段');

    setActiveConversation('sess-b');
    const b = activeChat();
    expect(b.entries.filter((e) => e.role === 'assistant').map((e) => e.text).join('')).toBe('B的第一段');
  });

  it('切走再切回，内容完整（不丢流式尾巴）', () => {
    setActiveConversation('sess-a');
    appendDeltaToLive('sess-a', '前段');
    setActiveConversation('sess-b');
    appendDeltaToLive('sess-b', '别的会话');
    setActiveConversation('sess-a');
    appendDeltaToLive('sess-a', '后段');
    finalizeLiveEntry('sess-a', '前段后段');
    setActiveConversation('sess-b');
    setActiveConversation('sess-a');
    const texts = activeChat().entries.map((e) => e.text);
    expect(texts).toContain('前段后段');
  });

  it('clearSession 只清目标会话（回归：clearStream 把别的会话现场抹掉）', () => {
    setActiveConversation('sess-a');
    appendDeltaToLive('sess-a', 'A');
    appendDeltaToLive('sess-b', 'B');
    upsertCard('sess-a', toolCard('tc-a', 'sess-a'));
    clearSession('sess-b');
    setActiveConversation('sess-b');
    expect(activeChat().entries).toHaveLength(0);
    expect(activeCards()).toHaveLength(0);
    setActiveConversation('sess-a');
    expect(activeChat().entries.length).toBeGreaterThan(0);
    expect(activeCards()).toHaveLength(1);
  });

  it('右栏工具流水按当前会话过滤（回归：切会话后恒为「暂无工具调用」）', () => {
    upsertCard('sess-a', toolCard('tc-a', 'sess-a', 'search'));
    upsertCard('sess-a', toolCard('tc-a2', 'sess-a', 'read'));
    upsertCard('sess-b', toolCard('tc-b', 'sess-b', 'write'));

    setActiveConversation('sess-a');
    expect(activeCards().filter((c) => c.type === 'tool-call')).toHaveLength(2);
    setActiveConversation('sess-b');
    expect(activeCards().filter((c) => c.type === 'tool-call')).toHaveLength(1);
  });

  it('附件自带 sessionId 缺失时按事件 key 补齐', () => {
    setActiveConversation('sess-b');
    const bare = { ...toolCard('tc-x', 'ignored') } as Card;
    delete (bare as { sessionId?: string }).sessionId;
    attachCardToLive('sess-b', bare);
    expect(activeCards()[0]!.sessionId).toBe('sess-b');
  });

  it('卡片状态更新就地替换，不新增 entry（running → done）', () => {
    const c = toolCard('tc-1', 'sess-a');
    setActiveConversation('sess-a');
    attachCardToLive('sess-a', c);
    const before = activeCards();
    const n1 = activeChat().entries.length;
    attachCardToLive('sess-a', { ...c, status: 'done', ok: true, result: 'ok' });
    expect(activeCards().length).toBe(before.length);
    expect(activeChat().entries).toHaveLength(n1);
    expect(activeCards()[0]!.status).toBe('done');
  });

  it('删除会话时其分区一并丢弃（不残留内存/旧卡片）', () => {
    setActiveConversation('sess-a');
    appendEntry('sess-a', { id: 'u1', role: 'user', text: 'hi', createdAt: 1 });
    upsertCard('sess-a', toolCard('tc-a', 'sess-a'));
    setConvs('list', [{ sessionId: 'sess-a', title: 'A', createdAt: Date.now() }]);
    setActiveConversation('sess-a');
    removeConversation('sess-a');
    setActiveConversation('sess-a'); // 重新指向（分区已被丢弃）
    expect(activeChat().entries).toHaveLength(0);
    expect(activeCards()).toHaveLength(0);
  });

  it('运行态按会话独立标记（左栏圆点）', () => {
    setSessionRunning('sess-a', true);
    expect(convs.running).toContain('sess-a');
    expect(convs.running).not.toContain('sess-b');
    setSessionRunning('sess-a', false);
    expect(convs.running).not.toContain('sess-a');
  });

  it('流式状态按会话独立（后台会话在跑不污染前台）', () => {
    setStreaming('sess-b', true);
    setActiveConversation('sess-a');
    expect(activeChat().streaming).toBe(false);
    setActiveConversation('sess-b');
    expect(activeChat().streaming).toBe(true);
  });
});

describe('渲染层 — 审批按会话隔离', () => {
  it('审批横幅只取当前会话的卡', () => {
    setApprovalCard(approvalCard('tk-a', 'sess-a'));
    setApprovalCard(approvalCard('tk-b', 'sess-b'));
    expect(headApprovalFor('sess-a')?.approvalToken).toBe('tk-a');
    expect(headApprovalFor('sess-b')?.approvalToken).toBe('tk-b');
  });

  it('批准后台会话的卡：跨分区同步状态，不残留横幅（回归：切走就关不掉）', () => {
    setApprovalCard(approvalCard('tk-a', 'sess-a'));
    setActiveConversation('sess-a');
    attachCardToLive('sess-a', approvalCard('tk-a', 'sess-a'));
    setActiveConversation('sess-b');
    // 在 B 会话界面批准 A 的卡
    resolveApprovalCard('tk-a', true);
    expect(headApprovalFor('sess-a')).toBeNull();
    setActiveConversation('sess-a');
    expect(activeCards().find((c) => c.type === 'approval')!.status).toBe('approved');
    const entry = activeChat().entries.find((e) => e.cards?.some((c) => c.type === 'approval'));
    expect(entry!.cards![0]!.status).toBe('approved');
  });
});

describe('渲染层 — 工具卡时序与折叠', () => {
  it('工具卡是独立 entry，顺序即真实事件顺序（回归：卡片被固定放到文本之后）', () => {
    // 真实顺序：先工具卡，后助手文本
    setActiveConversation('sess-a');
    attachCardToLive('sess-a', toolCard('tc-1', 'sess-a'));
    appendDeltaToLive('sess-a', '我先查了文件');
    const kinds = activeChat().entries.map((e) => (e.cards?.length ? 'card' : 'text'));
    expect(kinds).toEqual(['card', 'text']);
  });

  it('文本 → 工具卡 的顺序同样保留', () => {
    setActiveConversation('sess-a');
    appendDeltaToLive('sess-a', '准备写文件');
    attachCardToLive('sess-a', toolCard('tc-1', 'sess-a', 'write'));
    const kinds = activeChat().entries.map((e) => (e.cards?.length ? 'card' : 'text'));
    expect(kinds).toEqual(['text', 'card']);
  });

  it('一张工具摘要行不铺开 JSON（折叠默认态）', () => {
    const c = toolCard('tc-1', 'sess-a');
    // CardRenderer 只在 open() 时才渲染 paramsSummary；这里断言契约：摘要行存在且简短
    expect(c.summaryLine).toBe('search · pattern=*.ts');
    expect((c.summaryLine ?? '').length).toBeLessThan(80);
  });
});

describe('一行摘要算法（渲染层与主进程必须一致）', () => {
  const cases: Array<[string, unknown, string]> = [
    ['search', { pattern: '*.ts', mode: 'files' }, 'search · pattern=*.ts · mode=files'],
    ['terminal', { command: 'echo hi' }, 'terminal · command=echo hi'],
    ['write', { path: 'a.html', create: true, edits: [{ newText: 'x' }] }, 'write · path=a.html · create=true · edits=[1]'],
    ['read', {}, 'read'],
    ['read', { path: 'x'.repeat(80) }, `read · path=${'x'.repeat(40)}…`],
  ];
  for (const [tool, params, expected] of cases) {
    it(`${tool} → ${expected}`, () => {
      expect(toolSummaryLine(tool, params)).toBe(expected);
      expect(buildSummaryLine(tool, JSON.stringify(params))).toBe(expected);
    });
  }

  it('参数被自愈时摘要前置提示（排查「工具为什么改了参数」的线索）', () => {
    expect(toolSummaryLine('write', { path: 'a' }, '补齐 edits')).toContain('（已自愈：补齐 edits）');
  });
});
