// 第 7 轮 UI 缺陷回归 + 第 8 轮「工具调用分层」回归
//
// 第 7 轮（用户截图）：
//   1. 右栏工具流水恒为「暂无工具调用」
//   2. 工具调用之后的结尾文本「回到最前面」
//   3. 审批通过后审批卡仍占位
//   4. 工具结果回显命令 + 中文乱码
//   5. 输入框左右边界与正文不齐
//
// 第 8 轮（用户需求）：
//   需求 1 最终回复必须在工具结果之后（assistant(tool_calls) → tool → assistant(final)）
//   需求 2 工具调用过程折叠，最终回答渲染在折叠容器下方
//   需求 3 工具调用展示格式 `[MCP 标识] 工具名 摘要`
//
// 覆盖范围：stores.ts 的分组/收尾语义 + ConversationStream 的聚合与徽标算法
//（组件整体渲染需 DOM 环境，这里只测其导出的纯函数与 store 层行为，避免引入 jsdom 依赖）。
import { describe, expect, it, beforeEach } from 'vitest';

import {
  activeCards,
  activeChat,
  activeKey,
  appendDeltaToLive,
  appendEntry,
  appendProcessStep,
  attachCardToLive,
  clearSession,
  finalizeLiveEntry,
  setActiveConversation,
  setConvs,
  setStreaming,
  upsertCard,
} from '../../renderer/src/state/stores';
import { toolBadge } from '../../renderer/src/components/chat/ConversationStream';
import { summarizeResult } from '../../electron/src/loop/agentLoop';
import type { Card, ToolCallCard } from '@codara/contract';

function toolCard(id: string, sessionId: string, tool = 'read'): ToolCallCard {
  return {
    id,
    type: 'tool-call',
    status: 'running',
    createdAt: Date.now(),
    sessionId,
    tool,
    paramsSummary: '{"path":"a.json"}',
    summaryLine: `${tool} · path=a.json`,
  };
}

beforeEach(() => {
  setConvs({ list: [], activeId: null, running: [], mainId: 'main-1' });
  setConvs('list', []);
  for (const id of ['main-1', 'sess-a', 'sess-b']) clearSession(id);
});

// ---------------------------------------------------------------------------
// 第 7 轮回归
// ---------------------------------------------------------------------------
describe('第7轮 — 右栏工具流水为空（upsertCard 首张卡静默丢弃）', () => {
  it('新会话第一张卡就能进分区（produce 路径不存在时曾静默丢弃）', () => {
    // 回归根因：setCards('bySession', key, produce(...)) 在 bySession[key]
    // 尚不存在时被 Solid 静默忽略 —— 不抛错、不写入。
    // 断言：全新会话 upsert 第一张卡必须立刻可读。
    setActiveConversation('sess-a');
    expect(activeCards()).toHaveLength(0);
    upsertCard('sess-a', toolCard('tc-first', 'sess-a'));
    expect(activeCards()).toHaveLength(1);
  });

  it('同 id 二次 upsert 是就地替换而非追加', () => {
    upsertCard('sess-a', toolCard('tc-1', 'sess-a'));
    upsertCard('sess-a', { ...toolCard('tc-1', 'sess-a'), status: 'done', ok: true });
    setActiveConversation('sess-a');
    expect(activeCards()).toHaveLength(1);
    expect(activeCards()[0]!.status).toBe('done');
  });
});

describe('第7轮 — 工具之后结尾文本回到最前面', () => {
  it('插卡后 live 文本条目被收尾，后续 delta 另起条目落在卡之后', () => {
    setActiveConversation('sess-a');
    // 模型先说话 → 调工具 → 再说话
    appendDeltaToLive('sess-a', '先读取配置。');
    attachCardToLive('sess-a', toolCard('tc-1', 'sess-a'));
    appendDeltaToLive('sess-a', '配置已更新完毕。');

    const seq = activeChat().entries.map((e) => (e.cards?.length ? 'card' : `text:${e.text}`));
    // 关键：结尾文本必须排在卡之后（回归时它会并回第一条 text，渲染在最上方）
    expect(seq).toEqual(['text:先读取配置。', 'card', 'text:配置已更新完毕。']);
  });
});

describe('第7轮 — 工具结果回显与乱码', () => {
  it('summarizeResult 不再回显 tool/params/durationMs 噪声', () => {
    const result = {
      ok: true,
      tool: 'read',
      params: { path: 'a.json' },
      durationMs: 12,
      data: { content: 'hello' },
    } as unknown as Parameters<typeof summarizeResult>[0];
    const s = summarizeResult(result);
    expect(s).not.toContain('durationMs');
    expect(s).not.toContain('"params"');
    expect(s).not.toContain('"tool"');
    expect(s).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// 第 8 轮：需求 1 / 需求 2 —— 最终回复在工具结果之后 + 过程折叠分组
// ---------------------------------------------------------------------------
describe('第8轮 — 过程分组与最终回复分层（需求 1 + 需求 2）', () => {
  it('step 与工具卡归属同一 processGroup，最终回复不属于任何分组', () => {
    setActiveConversation('sess-a');
    appendProcessStep('sess-a', '读取配置文件');
    attachCardToLive('sess-a', toolCard('tc-1', 'sess-a', 'read'));
    appendProcessStep('sess-a', '执行安装依赖');
    attachCardToLive('sess-a', toolCard('tc-2', 'sess-a', 'terminal'));
    appendDeltaToLive('sess-a', '全部完成，改动如下…');
    finalizeLiveEntry('sess-a', '全部完成，改动如下…');

    const entries = activeChat().entries;
    const grouped = entries.filter((e) => e.processGroup);
    const final = entries.filter((e) => e.kind === 'final');

    // 过程条目全部落进同一个分组
    const gids = new Set(grouped.map((e) => e.processGroup));
    expect(gids.size).toBe(1);
    expect(grouped).toHaveLength(4); // 2 step + 2 card

    // 最终回复唯一，且不带分组（渲染在折叠容器下方）
    expect(final).toHaveLength(1);
    expect(final[0]!.text).toBe('全部完成，改动如下…');
    expect(final[0]!.processGroup).toBeUndefined();
  });

  it('最终回复在 entries 中排在所有过程条目之后（需求 1 的顺序铁律）', () => {
    setActiveConversation('sess-a');
    appendProcessStep('sess-a', '第一步');
    attachCardToLive('sess-a', toolCard('tc-1', 'sess-a'));
    appendDeltaToLive('sess-a', '第三步：结论');
    finalizeLiveEntry('sess-a', '第三步：结论');

    const entries = activeChat().entries;
    const finalIdx = entries.findIndex((e) => e.kind === 'final');
    const lastProcIdx = entries.map((e) => !!e.processGroup).lastIndexOf(true);
    expect(finalIdx).toBeGreaterThan(lastProcIdx);
  });

  it('一轮内的 step 条目 text 保留模型给的摘要（供折叠容器每行展示）', () => {
    setActiveConversation('sess-a');
    appendProcessStep('sess-a', '读取配置文件');
    const step = activeChat().entries.find((e) => e.kind === 'step');
    expect(step).toBeTruthy();
    expect(step!.text).toBe('读取配置文件');
    expect(step!.role).toBe('event');
  });

  it('finalizeLiveEntry(isFinal=false) 把终止/错误说明降级为 system（不当正文）', () => {
    setActiveConversation('sess-a');
    appendDeltaToLive('sess-a', '（已终止）');
    finalizeLiveEntry('sess-a', '（已终止）', undefined, false);
    const e = activeChat().entries.find((x) => x.text === '（已终止）');
    expect(e?.role).toBe('system');
    expect(e?.kind).toBeUndefined();
  });

  it('收尾后清空过程分组：下一轮提问从干净分组开始', () => {
    setActiveConversation('sess-a');
    appendProcessStep('sess-a', '第一轮步骤');
    appendDeltaToLive('sess-a', '第一轮结论');
    finalizeLiveEntry('sess-a', '第一轮结论');

    // 第二轮
    appendProcessStep('sess-a', '第二轮步骤');
    const gids = activeChat().entries.filter((e) => e.processGroup).map((e) => e.processGroup);
    expect(new Set(gids).size).toBe(2); // 两轮分组 id 不同
  });

  it('流式过程中（未 done）不会产生 final 之外的干扰条目', () => {
    setActiveConversation('sess-a');
    appendProcessStep('sess-a', '查一下');
    attachCardToLive('sess-a', toolCard('tc-1', 'sess-a'));
    const kinds = activeChat().entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'final')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 第 8 轮：需求 3 —— [MCP 标识] 工具名 摘要
// ---------------------------------------------------------------------------
describe('第8轮 — 工具 MCP 标识（需求 3）', () => {
  const cases: Array<[string, string]> = [
    ['read', '📖'],
    ['read_file', '📖'],
    ['write', '✏️'],
    ['patch', '🔧'],
    ['search', '🔍'],
    ['terminal', '🖥️'],
    ['git', '🌿'],
    ['fetch_url', '🌐'],
    ['fetch', '🌐'],
    ['web_fetch', '🌐'],
    // `web_search` 同时含 web/search；按最长键优先，落回更具体的 search
    ['web_search', '🔍'],
    ['plan', '📋'],
    ['crew', '👥'],
    ['audit', '📝'],
  ];
  for (const [tool, badge] of cases) {
    it(`${tool} → ${badge}`, () => {
      expect(toolBadge(tool)).toBe(badge);
    });
  }

  it('未知工具回退中性扳手而不是留空（空位会让整行对不齐）', () => {
    expect(toolBadge('definitely_not_a_tool')).toBe('🔧');
    expect(toolBadge('')).toBe('🔧');
  });

  it('大小写不敏感', () => {
    expect(toolBadge('READ')).toBe('📖');
    expect(toolBadge('Terminal')).toBe('🖥️');
  });

  it('匹配结果不依赖对象声明顺序（按最长键优先，稳定可预期）', () => {
    // 回归：早期实现走 Object.entries 的声明顺序，`web_search` 命中的徽标
    // 取决于 TOOL_BADGE 里 search/web 谁先写 —— 换个工具名就可能翻车。
    // 现在显式按最长键优先，结果与书写顺序无关。
    const a = toolBadge('web_search');
    const b = toolBadge('search_web');
    expect(a).toBe('🔍');
    expect(b).toBe('🔍');
    // 纯 web 语义的工具仍拿 🌐
    expect(toolBadge('web_fetch')).toBe('🌐');
    expect(toolBadge('fetch_url')).toBe('🌐');
  });
});

// ---------------------------------------------------------------------------
// 第 8 轮：会话隔离在分组维度不串台
// ---------------------------------------------------------------------------
describe('第8轮 — 过程分组按会话隔离', () => {
  it('两个会话各自的分组 id 不互相污染', () => {
    appendProcessStep('sess-a', 'A 的步骤');
    appendProcessStep('sess-b', 'B 的步骤');

    setActiveConversation('sess-a');
    expect(activeChat().entries.map((e) => e.text)).toEqual(['A 的步骤']);
    setActiveConversation('sess-b');
    expect(activeChat().entries.map((e) => e.text)).toEqual(['B 的步骤']);
  });

  it('后台会话流式不污染前台会话的过程分组', () => {
    setActiveConversation('sess-a');
    appendProcessStep('sess-a', 'A 步骤');
    appendProcessStep('sess-b', 'B 步骤');
    attachCardToLive('sess-b', toolCard('tc-b', 'sess-b'));
    expect(activeKey()).toBe('sess-a');
    expect(activeChat().entries).toHaveLength(1);
    expect(activeCards()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 第 8 轮：审批卡不占位（第 7 轮问题 3 的 store 层断言）
// ---------------------------------------------------------------------------
describe('第8轮 — 已完结审批卡不占位（第 7 轮问题 3）', () => {
  it('approved 的审批卡从 cards 分区保留，但渲染层过滤逻辑可识别', () => {
    setActiveConversation('sess-a');
    const approval: Card = {
      id: 'approval-tk-1',
      type: 'approval',
      status: 'approved',
      createdAt: Date.now(),
      sessionId: 'sess-a',
      title: '批准 terminal',
      reason: 'echo hi',
      risk: 'medium',
      approvalToken: 'tk-1',
    };
    upsertCard('sess-a', approval);
    // store 层保留状态事实（右栏/审计需要），过滤交给渲染层的 blocks memo
    const done = activeCards().filter((c) => c.type === 'approval' && c.status !== 'pending');
    expect(done).toHaveLength(1);
  });

  it('pending 审批卡必须保留（用户唯一批准入口）', () => {
    setActiveConversation('sess-a');
    upsertCard('sess-a', {
      id: 'approval-tk-2',
      type: 'approval',
      status: 'pending',
      createdAt: Date.now(),
      sessionId: 'sess-a',
      title: '批准 write',
      reason: 'x',
      risk: 'high',
      approvalToken: 'tk-2',
    } as Card);
    const pending = activeCards().filter((c) => c.type === 'approval' && c.status === 'pending');
    expect(pending).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 第 8 轮：streaming 标记与分组共存
// ---------------------------------------------------------------------------
describe('第8轮 — 流式状态与过程分组共存', () => {
  it('streaming 与 processGroup 可同时存在（过程中显示「正在思考…」）', () => {
    setActiveConversation('sess-a');
    setStreaming('sess-a', true);
    appendProcessStep('sess-a', '处理中');
    expect(activeChat().streaming).toBe(true);
    expect(activeChat().entries.some((e) => e.processGroup)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 兜底：appendEntry（用户提问）不带分组，不被折叠
// ---------------------------------------------------------------------------
describe('第8轮 — 用户提问不被折叠容器吞掉', () => {
  it('user 条目没有 processGroup / kind', () => {
    appendEntry('sess-a', { id: 'u1', role: 'user', text: '帮我修项目', createdAt: Date.now() });
    setActiveConversation('sess-a');
    const u = activeChat().entries.find((e) => e.role === 'user');
    expect(u?.processGroup).toBeUndefined();
    expect(u?.kind).toBeUndefined();
  });
});
