// M5-B: 记忆体系单测（规格 7.6 / 4.5 / 4.8）
// 覆盖：路径解析、章节切分、8KB 上限、两层加载、注入与沙箱豁免、兼容导入幂等。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const FAKE_HOME = vi.hoisted(() => '/tmp/codara-mem-test-home');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import { globalMemoryPath, projectMemoryPath, projectMemoryDir } from '../../electron/src/memory/paths';
import {
  appendSection,
  readCapped,
  renderSections,
  splitSections,
  MEMORY_FILE_LIMIT_BYTES,
} from '../../electron/src/memory/parse';
import { loadMemory } from '../../electron/src/memory/load';
import { withMemory } from '../../electron/src/memory/inject';
import { detectImportable, importMemory } from '../../electron/src/memory/import';

let ws: string;
let homeDirBefore: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codara-mem-'));
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  homeDirBefore = os.homedir();
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  void homeDirBefore;
});

// ---------------- paths ----------------

describe('memory paths', () => {
  it('全局记忆位于 $HOME/.codara/AGENTS.md', () => {
    expect(globalMemoryPath()).toBe(path.join(FAKE_HOME, '.codara', 'AGENTS.md'));
  });

  it('项目记忆位于项目根 AGENTS.md 与 .codara/', () => {
    expect(projectMemoryPath('/ws')).toBe(path.join('/ws', 'AGENTS.md'));
    expect(projectMemoryDir('/ws')).toBe(path.join('/ws', '.codara'));
  });
});

// ---------------- parse ----------------

describe('memory parse', () => {
  it('按 ## 标题切章节，前导内容归入空标题章节', () => {
    const text = '# 头\n\n## 编码规范\n用 TS。\n\n## 命令\nnpm test\n';
    const sections = splitSections(text);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({ title: '', body: '# 头\n\n' });
    expect(sections[1]?.title).toBe('编码规范');
    expect(sections[1]?.body).toContain('用 TS。');
    expect(sections[2]?.title).toBe('命令');
  });

  it('章节可无损还原', () => {
    const text = '## A\n内容A\n\n## B\n内容B\n';
    expect(renderSections(splitSections(text))).toBe('## A\n内容A\n\n## B\n内容B');
  });

  it('readCapped 截断超限文件到 8KB', () => {
    const file = path.join(ws, 'big.md');
    fs.writeFileSync(file, 'x'.repeat(MEMORY_FILE_LIMIT_BYTES + 100));
    const got = readCapped(file)!;
    expect(Buffer.byteLength(got, 'utf-8')).toBe(MEMORY_FILE_LIMIT_BYTES);
  });

  it('readCapped 缺失/目录返回 null', () => {
    expect(readCapped(path.join(ws, 'nope.md'))).toBeNull();
    expect(readCapped(ws)).toBeNull();
  });

  it('appendSection 幂等：同名标题跳过', () => {
    const base = '## 已有\n内容\n';
    const once = appendSection(base, '新增', '正文');
    expect(once).toContain('## 新增');
    const twice = appendSection(once, '新增', '另一份正文');
    expect(twice).toBe(once);
    expect(twice).not.toContain('另一份正文');
  });
});

// ---------------- load ----------------

describe('memory load', () => {
  it('加载全局与项目两层', () => {
    fs.mkdirSync(path.join(FAKE_HOME, '.codara'), { recursive: true });
    fs.writeFileSync(path.join(FAKE_HOME, '.codara', 'AGENTS.md'), '全局规则');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '项目规则');
    const mem = loadMemory(ws);
    expect(mem.global).toBe('全局规则');
    expect(mem.project).toBe('项目规则');
  });

  it('缺文件静默降级为空串', () => {
    const mem = loadMemory(ws);
    expect(mem.global).toBe('');
    expect(mem.project).toBe('');
  });

  it('无 workspaceRoot 时只加载全局层', () => {
    fs.mkdirSync(path.join(FAKE_HOME, '.codara'), { recursive: true });
    fs.writeFileSync(path.join(FAKE_HOME, '.codara', 'AGENTS.md'), 'G');
    const mem = loadMemory();
    expect(mem.global).toBe('G');
    expect(mem.project).toBe('');
  });
});

// ---------------- inject ----------------

describe('memory inject', () => {
  const prompt = '你是专家。';

  it('两层记忆拼接进 systemPrompt，主体不动', () => {
    const out = withMemory(prompt, { global: 'G 规则', project: 'P 规则' });
    expect(out.startsWith(prompt)).toBe(true);
    expect(out).toContain('### 全局记忆');
    expect(out).toContain('G 规则');
    expect(out).toContain('### 项目记忆');
    expect(out).toContain('P 规则');
  });

  it('沙箱会话跳过项目记忆正文（规格 4.8），全局保留', () => {
    const out = withMemory(prompt, { global: 'G 规则', project: 'P 机密' }, { sandbox: true });
    expect(out).toContain('G 规则');
    expect(out).not.toContain('P 机密');
    expect(out).not.toContain('### 项目记忆');
  });

  it('空记忆原样返回，不追加注入块', () => {
    expect(withMemory(prompt, { global: '', project: '' })).toBe(prompt);
    expect(withMemory(prompt, null)).toBe(prompt);
  });
});

// ---------------- import ----------------

describe('memory import', () => {
  it('检测 .codex/AGENTS.md 与 .workbuddy/memory/MEMORY.md', () => {
    expect(detectImportable(ws)).toHaveLength(0);
    fs.mkdirSync(path.join(ws, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.codex', 'AGENTS.md'), 'Codex 记忆');
    expect(detectImportable(ws).map((s) => s.label)).toEqual(['Codex']);
    fs.mkdirSync(path.join(ws, '.workbuddy', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.workbuddy', 'memory', 'MEMORY.md'), 'WB 记忆');
    expect(detectImportable(ws).map((s) => s.label)).toEqual(['Codex', 'WorkBuddy']);
  });

  it('导入合并进项目 AGENTS.md，同名章节幂等跳过', () => {
    fs.mkdirSync(path.join(ws, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.codex', 'AGENTS.md'), 'Codex 记忆');
    const r1 = importMemory(ws);
    expect(r1.imported).toEqual([path.join('.codex', 'AGENTS.md')]);
    expect(r1.skipped).toEqual([]);
    const target = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf-8');
    expect(target).toContain('# 项目记忆');
    expect(target).toContain('## 来自 Codex 的记忆');
    expect(target).toContain('Codex 记忆');
    // 再次导入：章节已存在 → skipped，内容不重复
    const r2 = importMemory(ws);
    expect(r2.imported).toEqual([]);
    expect(r2.skipped).toEqual([path.join('.codex', 'AGENTS.md')]);
    const again = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf-8');
    expect(again.match(/Codex 记忆/g)).toHaveLength(1);
  });

  it('已存在项目记忆时追加而非覆盖', () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# 项目记忆\n\n## 手写章节\n保留\n');
    fs.mkdirSync(path.join(ws, '.workbuddy', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.workbuddy', 'memory', 'MEMORY.md'), 'WB 内容');
    importMemory(ws);
    const target = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf-8');
    expect(target).toContain('## 手写章节');
    expect(target).toContain('## 来自 WorkBuddy 的记忆');
    expect(target).toContain('WB 内容');
  });

  it('无可导入源时不写目标文件', () => {
    const r = importMemory(ws);
    expect(r.imported).toEqual([]);
    expect(fs.existsSync(path.join(ws, 'AGENTS.md'))).toBe(false);
  });
});
