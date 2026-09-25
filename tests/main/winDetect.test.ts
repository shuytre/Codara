// M6: winDetect 表驱动单测（Linux 沙箱；真实探测项归档 win7-regression.md C 节）
import { describe, expect, it } from 'vitest';

import {
  missingKbs,
  needsWmf,
  parseKbList,
  parseOsInfo,
  requiredKbs,
  detectKbs,
  REQUIRED_KBS,
} from '../../installer/lib/winDetect';

describe('parseOsInfo', () => {
  it.each([
    [{ major: 6, minor: 1, build: 7600 }, { isWin7: true, isSp1: false, isRtm: true }], // Win7 RTM：拒绝
    [{ major: 6, minor: 1, build: 7601 }, { isWin7: true, isSp1: true, isRtm: false }], // Win7 SP1：目标平台
    [{ major: 6, minor: 1, build: 7602 }, { isWin7: true, isSp1: true, isRtm: false }], // SP1 之后
    [{ major: 6, minor: 3, build: 9600 }, { isWin7: false, isSp1: false, isRtm: false }], // Win8.1
    [{ major: 10, minor: 0, build: 19045 }, { isWin7: false, isSp1: false, isRtm: false }], // Win10
  ] as const)('%j → %j', (input, expected) => {
    const info = parseOsInfo(input);
    expect(info.isWin7).toBe(expected.isWin7);
    expect(info.isSp1).toBe(expected.isSp1);
    expect(info.isRtm).toBe(expected.isRtm);
  });
});

describe('requiredKbs', () => {
  it('SP1(7601) 需要 SSU + SHA-2 两枚补丁，顺序固定', () => {
    expect(requiredKbs(7601)).toEqual(['KB4490628', 'KB4474419']);
  });
  it('RTM(7600) 返回空（先装 SP1，不直接列 KB）', () => {
    expect(requiredKbs(7600)).toEqual([]);
  });
});

describe('needsWmf', () => {
  it('SP1 需要 WMF5.1；RTM 不适用（需先 SP1）', () => {
    expect(needsWmf(7601)).toBe(true);
    expect(needsWmf(7600)).toBe(false);
  });
});

describe('parseKbList', () => {
  it('兼容 wmic qfe 输出', () => {
    const out = ['HotFixID', 'KB4474419', 'KB4490628', 'KB5012345', ''].join('\r\n');
    expect(parseKbList(out)).toEqual(['KB4474419', 'KB4490628', 'KB5012345']);
  });
  it('小写与 kb 前缀归一、去重', () => {
    expect(parseKbList('kb4474419 KB4474419 KB987654')).toEqual(['KB4474419', 'KB987654']);
  });
  it('忽略非 KB 形态', () => {
    expect(parseKbList('Windows7 KB1 KBABC123')).toEqual([]);
  });
});

describe('missingKbs', () => {
  it('缺失返回按 required 顺序', () => {
    expect(missingKbs(REQUIRED_KBS as unknown as string[], ['KB4474419'])).toEqual(['KB4490628']);
  });
  it('全部已装返回空', () => {
    expect(missingKbs(REQUIRED_KBS as unknown as string[], ['kb4490628', 'KB4474419'])).toEqual([]);
  });
});

describe('detectKbs（exec 参数注入）', () => {
  it('全部已装：missing 为空，detectFailed=false', async () => {
    const r = await detectKbs(7601, async () => 'HotFixID\r\nKB4490628\r\nKB4474419\r\n');
    expect(r).toEqual({ missing: [], installed: ['KB4474419', 'KB4490628'], detectFailed: false });
  });
  it('缺 SHA-2：missing 只含 KB4474419', async () => {
    const r = await detectKbs(7601, async () => 'KB4490628 KB123456');
    expect(r.missing).toEqual(['KB4474419']);
    expect(r.detectFailed).toBe(false);
  });
  it('命令失败：detectFailed=true，missing=全部 required（非阻塞口径）', async () => {
    const r = await detectKbs(7601, async () => {
      throw new Error('wmic not found');
    });
    expect(r.detectFailed).toBe(true);
    expect(r.missing).toEqual(['KB4490628', 'KB4474419']);
  });
  it('RTM：required 为空，missing 为空', async () => {
    const r = await detectKbs(7600, async () => '');
    expect(r.missing).toEqual([]);
  });
});
