// 审批队列语义：模型并行发起多个 ask 级工具时必须排队，不能互相覆盖。
// 回归背景：早期 pendingApproval 为单槽位，第二个审批到达时覆盖第一个，
// 导致横幅消失、工具永久挂起（卡片停在「执行中」）。
import { describe, expect, it } from 'vitest';

import type { ApprovalCard } from '@codara/contract';

function makeCard(token: string): ApprovalCard {
  return {
    id: `approval-${token}`,
    type: 'approval',
    status: 'pending',
    createdAt: Date.now(),
    title: `批准 write 操作`,
    reason: '写入文件：a.html',
    risk: 'medium',
    payload: { path: 'a.html' },
    approvalToken: token,
  };
}

/** 复刻渲染层队列语义（纯函数版，避免引入 solid store 依赖） */
function enqueue(queue: ApprovalCard[], card: ApprovalCard): ApprovalCard[] {
  if (queue.some((c) => c.approvalToken === card.approvalToken)) return queue;
  return [...queue, card];
}

function dequeue(queue: ApprovalCard[], token: string): ApprovalCard[] {
  return queue.filter((c) => c.approvalToken !== token);
}

describe('审批队列', () => {
  it('队首即当前阻塞横幅', () => {
    let q: ApprovalCard[] = [];
    q = enqueue(q, makeCard('t1'));
    q = enqueue(q, makeCard('t2'));
    expect(q[0]!.approvalToken).toBe('t1');
  });

  it('第二个审批入队不覆盖第一个（回归：单槽位覆盖 bug）', () => {
    let q: ApprovalCard[] = [];
    q = enqueue(q, makeCard('t1'));
    q = enqueue(q, makeCard('t2'));
    expect(q).toHaveLength(2);
    expect(q.map((c) => c.approvalToken)).toEqual(['t1', 't2']);
  });

  it('同 token 重复入队幂等（防堆叠）', () => {
    let q: ApprovalCard[] = [];
    const c = makeCard('t1');
    q = enqueue(q, c);
    q = enqueue(q, c);
    q = enqueue(q, { ...c });
    expect(q).toHaveLength(1);
  });

  it('裁决队首后自动暴露下一项', () => {
    let q: ApprovalCard[] = [];
    q = enqueue(q, makeCard('t1'));
    q = enqueue(q, makeCard('t2'));
    q = dequeue(q, 't1');
    expect(q).toHaveLength(1);
    expect(q[0]!.approvalToken).toBe('t2');
  });

  it('裁决非队首 token 不影响其余项', () => {
    let q: ApprovalCard[] = [];
    q = enqueue(q, makeCard('t1'));
    q = enqueue(q, makeCard('t2'));
    q = dequeue(q, 'ghost');
    expect(q).toHaveLength(2);
  });

  it('队列清空后无待审批', () => {
    let q: ApprovalCard[] = [];
    q = enqueue(q, makeCard('t1'));
    q = dequeue(q, 't1');
    expect(q).toHaveLength(0);
  });
});
