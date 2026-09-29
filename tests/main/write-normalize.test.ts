// write 参数归一化单测：各厂商异构 edits 形态 → sidecar 契约
import { describe, expect, it } from 'vitest';

import { normalizeWriteParams } from '../../electron/src/tools/runtime';

describe('normalizeWriteParams', () => {
  it('标准形态原样通过', () => {
    const r = normalizeWriteParams({
      path: 'a.txt',
      create: true,
      edits: [{ newText: 'hello' }],
    });
    expect(r?.path).toBe('a.txt');
    expect(r?.create).toBe(true);
    expect(r?.edits).toEqual([{ newText: 'hello' }]);
  });

  it('Agnes 行区间 + edits 字符串化（未声明 create）：收敛为整文件 newText 且 create=true', () => {
    const agnes = {
      path: 'snake.html',
      edits: JSON.stringify([
        { startLine: 1, contentLines: ['<!DOCTYPE html>', '<html>', '</html>'] },
      ]),
    };
    const r = normalizeWriteParams(agnes);
    expect(r?.path).toBe('snake.html');
    // 未声明 create 且是行区间整文件内容 → 视为新建意图
    expect(r?.create).toBe(true);
    expect(r?.edits).toEqual([{ newText: '<!DOCTYPE html>\n<html>\n</html>' }]);
  });

  // 回归守卫（严重数据丢失修复）：显式 create=false 的行区间**无原文**写法，
  // 旧实现会强行 create=true → patch.rs 走整文件覆盖分支，把已存在文件替换成
  // 仅含目标行的内容并绕过 baselineHash 校验。此处必须拒绝，不得臆造覆盖意图。
  it('【回归】create=false + 行区间无 oldLines：必须返回 null（拒绝静默覆盖）', () => {
    const r = normalizeWriteParams({
      path: 'existing.ts',
      create: false,
      baselineHash: 'abc',
      edits: [{ startLine: 10, contentLines: ['// 只改这一行'] }],
    });
    expect(r).toBeNull();
  });

  it('【回归】create=false + 行区间带 oldLines：走精确替换，保持 create=false', () => {
    const r = normalizeWriteParams({
      path: 'existing.ts',
      create: false,
      baselineHash: 'abc',
      edits: [{ startLine: 10, oldLines: ['let x=1'], contentLines: ['let x=2'] }],
    });
    expect(r?.create).toBe(false);
    expect(r?.edits).toEqual([{ oldText: 'let x=1', newText: 'let x=2' }]);
    expect(r?.baselineHash).toBe('abc');
  });

  it('【回归】显式 create=true + 行区间无原文：仍可整体覆盖（新建/重写语义）', () => {
    const r = normalizeWriteParams({
      path: 'rewrite.ts',
      create: true,
      edits: [{ contentLines: ['a', 'b'] }],
    });
    expect(r?.create).toBe(true);
    expect(r?.edits).toEqual([{ newText: 'a\nb' }]);
  });

  it('oldText/newText 精确替换保留 create=false', () => {
    const r = normalizeWriteParams({
      path: 'a.ts',
      create: false,
      baselineHash: 'abc',
      edits: [{ oldText: 'let x=1', newText: 'let x=2' }],
    });
    expect(r?.create).toBe(false);
    expect(r?.baselineHash).toBe('abc');
    expect(r?.edits).toEqual([{ oldText: 'let x=1', newText: 'let x=2' }]);
  });

  it('锚点插入形态归一化', () => {
    const r = normalizeWriteParams({
      path: 'a.ts',
      edits: [{ insertAfter: '// head', newText: 'const a = 1;' }],
    });
    expect(r?.edits).toEqual([{ insertAfter: '// head', newText: 'const a = 1;' }]);
  });

  it('fields 别名（search/replace）可识别', () => {
    const r = normalizeWriteParams({
      path: 'a.ts',
      edits: [{ search: 'foo', replace: 'bar' }],
    });
    expect(r?.edits).toEqual([{ oldText: 'foo', newText: 'bar' }]);
  });

  it('缺 path 或 edits 返回 null', () => {
    expect(normalizeWriteParams({ edits: [{ newText: 'x' }] })).toBeNull();
    expect(normalizeWriteParams({ path: 'a.txt' })).toBeNull();
    expect(normalizeWriteParams({ path: 'a.txt', edits: [] })).toBeNull();
    expect(normalizeWriteParams(null)).toBeNull();
  });

  it('edits 为非 JSON 字符串时视为整文件内容', () => {
    const r = normalizeWriteParams({ path: 'a.txt', edits: 'plain content' });
    expect(r?.edits).toEqual([{ newText: 'plain content' }]);
  });
});
