// M5: index 工具注册单测（工具规格 / 角色矩阵 / 网关只读放行 / sidecar 路由）
import { describe, expect, it, vi } from 'vitest';

import { ToolRuntime } from '../../electron/src/tools/runtime';
import { ApprovalGateway } from '../../electron/src/tools/gateway';
import { ROLE_DEFS } from '../../electron/src/crew/roles';

function makeRuntime(sidecarCalls?: Array<{ method: string; params: unknown }>): ToolRuntime {
  const calls = sidecarCalls ?? [];
  const sidecar = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { ok: true, data: { method } };
    },
  };
  const budget = { tickTurn: () => undefined };
  const gateway = new ApprovalGateway(sidecar as never);
  return new ToolRuntime(sidecar as never, budget as never, gateway);
}

describe('index tool specs', () => {
  it('基础工具面包含 index.symbols 与 index.semantic', () => {
    const rt = makeRuntime();
    const names = rt.toolSpecs(false).map((s) => s.name);
    expect(names).toContain('index.symbols');
    expect(names).toContain('index.semantic');
  });

  it('index.* 工具 schema 要求必填参数', () => {
    const rt = makeRuntime();
    const symbols = rt.toolSpecs(false).find((s) => s.name === 'index.symbols')!;
    const semantic = rt.toolSpecs(false).find((s) => s.name === 'index.semantic')!;
    expect(symbols.parameters.required).toEqual(['name']);
    expect(semantic.parameters.required).toEqual(['query']);
  });
});

describe('index tool role matrix', () => {
  it('有 search 权限的角色均可用 index.*；builder（构建专职）不可', () => {
    for (const [role, def] of Object.entries(ROLE_DEFS)) {
      const hasSearch = def.tools.includes('search');
      if (role === 'builder') {
        expect(def.tools).not.toContain('index.symbols');
        expect(def.tools).not.toContain('index.semantic');
      } else {
        expect(hasSearch).toBe(true);
        expect(def.tools).toContain('index.symbols');
        expect(def.tools).toContain('index.semantic');
      }
    }
  });

  it('builder 调用 index.symbols 被角色矩阵拒绝（4002）', async () => {
    const rt = makeRuntime();
    const r = await rt.execute('index.symbols', { name: 'foo' }, 'plan', 'builder');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(4002);
  });
});

describe('index tool execution', () => {
  it('index.symbols 路由到 sidecar index.symbols 方法', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rt = makeRuntime(calls);
    const r = await rt.execute('index.symbols', { name: 'parseFile', kind: 'function' });
    expect(r.ok).toBe(true);
    expect(calls[0]?.method).toBe('index.symbols');
    expect(calls[0]?.params).toEqual({ name: 'parseFile', kind: 'function' });
    // 第二个调用是管道末尾的审计（audit.note）
    expect(calls[1]?.method).toBe('audit.note');
  });

  it('index.semantic 路由到 sidecar index.semantic 方法', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rt = makeRuntime(calls);
    const r = await rt.execute('index.semantic', { query: 'payment gateway', limit: 5 });
    expect(r.ok).toBe(true);
    expect(calls[0]?.method).toBe('index.semantic');
    expect(calls[0]?.params).toEqual({ query: 'payment gateway', limit: 5 });
  });

  it('index.* 为只读：Ask 模式可用，且网关自动放行无需审批', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rt = makeRuntime(calls);
    const r = await rt.execute('index.semantic', { query: 'x' }, 'ask');
    expect(r.ok).toBe(true);
    expect(calls[0]?.method).toBe('index.semantic'); // 无 approval.request 审计插入
  });
});
