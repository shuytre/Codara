// 卡片注册与渲染：九类结构化卡片（规格 2.2）
import { Show, Switch, Match } from 'solid-js';

import type { Card } from '@codara/contract';
import { bridge } from '../../ipc/client';

export function CardRenderer(props: { card: Card }) {
  return (
    <Switch>
      <Match when={props.card.type === 'plan'}>
        <PlanCardView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'tool-call'}>
        <ToolCallCardView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'diff'}>
        <DiffCardView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'approval'}>
        <ApprovalCardView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'terminal'}>
        <TerminalCardView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'task-dispatch'}>
        <TaskDispatchView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'acceptance'}>
        <AcceptanceView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'artifact'}>
        <ArtifactView card={props.card as never} />
      </Match>
      <Match when={props.card.type === 'rollback'}>
        <RollbackView card={props.card as never} />
      </Match>
    </Switch>
  );
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    pending: '待定',
    approved: '已批准',
    rejected: '已拒绝',
    running: '执行中',
    done: '完成',
    failed: '失败',
    suspended: '已挂起',
  };
  return map[status] || status;
}

function PlanCardView(props: { card: import('@codara/contract').PlanCard }) {
  return (
    <div class="card card-plan">
      <div class="card-head">
        <span class="card-tag">计划</span>
        <span class="badge">{statusBadge(props.card.status)}</span>
      </div>
      <ol class="plan-steps">
        {props.card.steps.map((s) => (
          <li>
            <span>{s.title}</span>
            <Show when={s.verify}>
              <span class="verify">验证：{s.verify}</span>
            </Show>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ToolCallCardView(props: { card: import('@codara/contract').ToolCallCard }) {
  return (
    <div class={`card card-tool ${props.card.ok ? '' : 'card-failed'}`}>
      <div class="card-head">
        <span class="card-tag mono">{props.card.tool}</span>
        <span class="badge">{props.card.ok === undefined ? statusBadge(props.card.status) : props.card.ok ? '完成' : '失败'}</span>
        <Show when={props.card.cacheRef}>
          <span class="cache-ref">{props.card.cacheRef}</span>
        </Show>
      </div>
      <pre class="card-body mono small">{props.card.paramsSummary}</pre>
      <Show when={props.card.result}>
        <details>
          <summary>结果</summary>
          <pre class="card-body mono small">{props.card.result}</pre>
        </details>
      </Show>
    </div>
  );
}

function DiffCardView(props: { card: import('@codara/contract').DiffCard }) {
  return (
    <div class="card card-diff">
      <div class="card-head">
        <span class="card-tag">Diff</span>
        <span class="path mono">{props.card.path}</span>
        <span class="badge">
          +{props.card.additions} −{props.card.deletions}
        </span>
      </div>
      <pre class="card-body mono small">{props.card.hunks}</pre>
    </div>
  );
}

function ApprovalCardView(props: { card: import('@codara/contract').ApprovalCard }) {
  const b = bridge();
  const respond = async (approved: boolean) => {
    await b.approvalRespond({ approvalToken: props.card.approvalToken, approved });
  };
  return (
    <div class={`card card-approval risk-${props.card.risk}`}>
      <div class="card-head">
        <span class="card-tag">审批申请</span>
        <span class="risk">风险：{props.card.risk}</span>
      </div>
      <div class="card-body">
        <strong>{props.card.title}</strong>
        <div>{props.card.reason}</div>
      </div>
      <div class="card-actions">
        <button class="primary" onClick={() => respond(true)}>
          批准
        </button>
        <button class="danger" onClick={() => respond(false)}>
          拒绝
        </button>
      </div>
    </div>
  );
}

function TerminalCardView(props: { card: import('@codara/contract').TerminalCard }) {
  return (
    <div class="card card-terminal">
      <div class="card-head">
        <span class="card-tag">终端</span>
        <span class={`exit ${props.card.exitCode === 0 ? 'ok' : 'bad'}`}>exit {props.card.exitCode}</span>
      </div>
      <pre class="card-body mono small">{props.card.command}</pre>
      <pre class="card-body mono small">{props.card.stdout}</pre>
      <Show when={props.card.spillPath}>
        <div class="spill">输出已落盘：{props.card.spillPath}</div>
      </Show>
    </div>
  );
}

function TaskDispatchView(props: { card: import('@codara/contract').TaskDispatchCard }) {
  return (
    <div class="card">
      <div class="card-head">
        <span class="card-tag">任务派发</span>
        <span class="badge">{props.card.role}</span>
      </div>
      <div class="card-body">{props.card.goal}</div>
      <Show when={props.card.worktree}>
        <div class="card-body mono small">worktree: {props.card.worktree}</div>
      </Show>
    </div>
  );
}

function AcceptanceView(props: { card: import('@codara/contract').AcceptanceCard }) {
  return (
    <div class="card">
      <div class="card-head">
        <span class="card-tag">验收报告</span>
        <span class={`badge ${props.card.passed ? 'ok' : 'bad'}`}>{props.card.passed ? '通过' : '未通过'}</span>
      </div>
      <div class="card-body">{props.card.summary}</div>
      <ul>
        {props.card.evidence.map((e) => (
          <li class="mono small">{e}</li>
        ))}
      </ul>
    </div>
  );
}

function ArtifactView(props: { card: import('@codara/contract').ArtifactCard }) {
  return (
    <div class="card">
      <div class="card-head">
        <span class="card-tag">交接物</span>
        <span class="badge">{props.card.authorRole}</span>
        <span class="badge">v{props.card.version}</span>
      </div>
      <pre class="card-body small">{props.card.body}</pre>
    </div>
  );
}

function RollbackView(props: { card: import('@codara/contract').RollbackCard }) {
  return (
    <div class="card">
      <div class="card-head">
        <span class="card-tag">回滚</span>
        <span class="badge">{statusBadge(props.card.status)}</span>
      </div>
      <div class="card-body mono small">目标：{props.card.target}</div>
      <div class="card-body small">恢复文件：{props.card.restoredFiles.join(', ')}</div>
    </div>
  );
}
