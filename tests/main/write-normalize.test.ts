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

  it('Agnes 行区间 + edits 字符串化：收敛为整文件 newText 且 create=true', () => {
    const agnes = {
      path: 'snake.html',
      edits: JSON.stringify([
        { startLine: 1, contentLines: ['<!DOCTYPE html>', '<html>', '</html>'] },
      ]),
    };
    const r = normalizeWriteParams(agnes);
    expect(r?.path).toBe('snake.html');
    expect(r?.create).toBe(true);
    expect(r?.edits).toEqual([{ newText: '<!DOCTYPE html>\n<html>\n</html>' }]);
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
