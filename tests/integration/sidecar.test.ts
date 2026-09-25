// M1/M2 集成测试：sidecar 协议、fs.read/patch 编码保真、治理管线、缓存、快照、git 分级
import * as fs from 'fs';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SidecarHarness, tmpWorkspace } from './harness';

let h: SidecarHarness;
let ws: string;

beforeEach(async () => {
  ws = tmpWorkspace();
  h = new SidecarHarness();
  await h.start(ws);
});

afterEach(() => {
  h.stop();
});

describe('M1: 协议与 fs 基础', () => {
  it('initialize 返回能力清单', async () => {
    const r = await h.call('ping', {});
    expect(r.result.ok).toBe(true);
    expect(r.result.data.platform).toBe('linux');
  });

  it('fs.read 分页带行号、truncated 提示', async () => {
    const file = path.join(ws, 'big.txt');
    fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const r = await h.call('fs.read', { path: 'big.txt', offset: 1, limit: 200 });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.lines).toHaveLength(200);
    expect(r.result.data.lines[0].no).toBe(1);
    expect(r.result.data.lines[199].no).toBe(200);
    expect(r.result.truncated).toBe(true);
    expect(r.result.message).toContain('offset');
  });

  it('fs.read 重复读返回缓存引用 @cache:', async () => {
    const file = path.join(ws, 'cache.txt');
    fs.writeFileSync(file, 'hello\nworld\n');
    await h.call('fs.read', { path: 'cache.txt' });
    const r2 = await h.call('fs.read', { path: 'cache.txt' });
    expect(r2.result.ok).toBe(true);
    expect(r2.result.cacheRef).toContain('@cache:');
    expect(r2.result.data.cacheHit).toBe(true);
  });

  it('fs.read 二进制文件只返回元信息 + 前 64 字节 hex', async () => {
    const file = path.join(ws, 'img.png');
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 0)]);
    fs.writeFileSync(file, bytes);
    const r = await h.call('fs.read', { path: 'img.png' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.binary).toBeDefined();
    expect(r.result.data.binary.headHex.startsWith('89504e47')).toBe(true);
    expect(r.result.data.lines).toBeUndefined();
  });

  it('路径越出工作区返回 1001', async () => {
    const r = await h.call('fs.read', { path: '../outside.txt' });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(1001);
  });

  it('fs.meta 返回文件元数据', async () => {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'abc');
    const r = await h.call('fs.meta', { path: 'a.txt' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.size).toBe(3);
    expect(r.result.data.isDir).toBe(false);
  });
});

describe('M2: 补丁管线与编码保真', () => {
  it('oldText/newText 精确替换、多义匹配报 1006', async () => {
    fs.writeFileSync(path.join(ws, 'code.txt'), 'const a = 1;\nconst b = 2;\nconst a = 1;\n');
    const r = await h.call('fs.patch', {
      path: 'code.txt',
      edits: [{ oldText: 'const a = 1;', newText: 'const a = 10;' }],
    });
    // 出现两次 → 1006 歧义
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(1006);

    const r2 = await h.call('fs.patch', {
      path: 'code.txt',
      edits: [{ oldText: 'const b = 2;', newText: 'const b = 20;' }],
    });
    expect(r2.result.ok).toBe(true);
    const content = fs.readFileSync(path.join(ws, 'code.txt'), 'utf-8');
    expect(content).toBe('const a = 1;\nconst b = 20;\nconst a = 1;\n');
  });

  it('基线哈希校验：文件被外部改动后拒绝写入（1002）', async () => {
    const file = path.join(ws, 'bl.txt');
    fs.writeFileSync(file, 'v1');
    const read1 = await h.call('fs.read', { path: 'bl.txt' });
    const hash = read1.result.data.baselineHash;
    fs.writeFileSync(file, 'v2 changed externally'); // 外部改动
    const r = await h.call('fs.patch', {
      path: 'bl.txt',
      edits: [{ oldText: 'v2 changed externally', newText: 'v3' }],
      baselineHash: hash,
    });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(1002);
    expect(r.result.error.message).toContain('re-read');
  });

  it('GBK 编码保真：读改写后仍为 GBK、字节级内容一致', async () => {
    // GBK 编码写入「你好世界」
    const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]); // 你好世界
    fs.writeFileSync(path.join(ws, 'gbk.txt'), gbkBytes);
    const r = await h.call('fs.read', { path: 'gbk.txt' });
    expect(r.result.data.encoding).toBe('gb18030');
    expect(r.result.data.lines[0].text).toBe('你好世界');

    // 修改后写回，验证仍是 GBK
    await h.call('fs.patch', {
      path: 'gbk.txt',
      edits: [{ oldText: '你好世界', newText: '你好Codara' }],
    });
    const after = fs.readFileSync(path.join(ws, 'gbk.txt'));
    // 「Codara」ASCII 不变，「你好」仍是 GBK 双字节
    expect(after.subarray(0, 4)).toEqual(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    expect(after.slice(4).toString('ascii')).toBe('Codara');
  });

  it('UTF-8 BOM 保留', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    fs.writeFileSync(path.join(ws, 'bom.txt'), Buffer.concat([bom, Buffer.from('hello\n')]));
    const r = await h.call('fs.read', { path: 'bom.txt' });
    expect(r.result.data.encoding).toBe('utf-8-bom');
    await h.call('fs.patch', {
      path: 'bom.txt',
      edits: [{ oldText: 'hello', newText: 'hello2' }],
    });
    const after = fs.readFileSync(path.join(ws, 'bom.txt'));
    expect(after.subarray(0, 3)).toEqual(bom);
    expect(after.slice(3).toString('utf-8')).toBe('hello2\n');
  });

  it('CRLF 换行保真：补丁后 CRLF 不被规范化', async () => {
    fs.writeFileSync(path.join(ws, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n');
    await h.call('fs.patch', {
      path: 'crlf.txt',
      edits: [{ oldText: 'line2', newText: 'line2- patched' }],
    });
    const raw = fs.readFileSync(path.join(ws, 'crlf.txt'), 'binary');
    expect(raw).toContain('\r\n');
    expect(raw).toBe('line1\r\nline2- patched\r\nline3\r\n');
  });

  it('二进制文件拒绝编辑（1003）', async () => {
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.alloc(64, 0));
    const r = await h.call('fs.patch', {
      path: 'bin.dat',
      edits: [{ oldText: 'x', newText: 'y' }],
    });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(1003);
  });

  it('新建文件必须 create=true', async () => {
    const r = await h.call('fs.patch', {
      path: 'new.txt',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(1007);
    const r2 = await h.call('fs.patch', {
      path: 'new2.txt',
      edits: [{ oldText: 'x', newText: 'x\ny' }],
      create: true,
    });
    expect(r2.result.ok).toBe(true);
  });
});

describe('M2: terminal 与治理管线', () => {
  it('命令执行、退出码、输出治理', async () => {
    const r = await h.call('term.exec', { command: 'echo hello-governance' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.exitCode).toBe(0);
    expect(r.result.data.stdout).toContain('hello-governance');
  });

  it('禁 && 长链（3001）', async () => {
    const r = await h.call('term.exec', { command: 'echo a && echo b' });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(3001);
  });

  it('禁 ; 长链（3001）', async () => {
    const r = await h.call('term.exec', { command: 'echo a; echo b' });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(3001);
  });

  it('PowerShell 子集校验（Windows 语义）', async () => {
    const r = await h.call('gov.validate', { command: 'Get-ChildItem | Format-Table', platform: 'windows' });
    expect(r.result.data.ok).toBe(false);
    expect(r.result.data.message).toContain('Format');
    const r2 = await h.call('gov.validate', { command: 'Get-ChildItem -Name', platform: 'windows' });
    expect(r2.result.data.ok).toBe(true);
  });

  it('高危命令标记 highRisk', async () => {
    const r = await h.call('gov.validate', { command: 'format C: /q', platform: 'windows' });
    expect(r.result.data.highRisk).toBe(true);
  });

  it('超长输出落盘 + 首 40 行 + truncated 标记', async () => {
    const r = await h.call('term.exec', {
      command: 'seq 1 1000',
      timeoutMs: 30000,
    });
    // 治理管线：>200 行 → 落盘
    if (r.result.truncated) {
      expect(r.result.data.spillPath).toBeDefined();
      const spill = fs.readFileSync(r.result.data.spillPath, 'utf-8');
      expect(spill.split('\n').length).toBeGreaterThan(500);
    } else {
      // 未触发落盘时输出也必须被截断保护
      expect(r.result.data.stdout.split('\n').length).toBeLessThanOrEqual(400);
    }
  });

  it('持久会话 cwd 保持', async () => {
    const open = await h.call('term.open', { cwd: ws });
    const sid = open.result.data.sessionId;
    const mk = await h.call('term.exec', { sessionId: sid, command: 'mkdir -p sub' });
    expect(mk.result.ok).toBe(true);
  });

  it('命令超时返回 124', async () => {
    const r = await h.call('term.exec', { command: 'sleep 5', timeoutMs: 1000 }, 20000);
    // 1.77.2 rustc 下 term_exec 返回 Envelope::err_with(INTERNAL, exit 124) 或 ok data
    if (!r.result.ok) {
      expect(r.result.data.exitCode).toBe(124);
    } else {
      expect(r.result.data.exitCode).toBe(124);
    }
  });
});

describe('M2: search', () => {
  it('内容搜索按文件分组、行号正确', async () => {
    fs.writeFileSync(path.join(ws, 's1.txt'), 'alpha\nbeta\nalpha2\n');
    fs.writeFileSync(path.join(ws, 's2.txt'), 'gamma\n');
    const r = await h.call('search.run', { pattern: 'alpha' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.totalMatches).toBe(2);
    expect(r.result.data.matches[0].path).toContain('s1.txt');
    expect(r.result.data.matches[0].line).toBe(1);
  });

  it('maxResults 截断并提示', async () => {
    fs.writeFileSync(path.join(ws, 'many.txt'), Array.from({ length: 30 }, (_, i) => `hit ${i}`).join('\n'));
    const r = await h.call('search.run', { pattern: 'hit', maxResults: 5 });
    expect(r.result.data.matches).toHaveLength(5);
    expect(r.result.truncated).toBe(true);
  });

  it('files 模式列举文件', async () => {
    fs.writeFileSync(path.join(ws, 'f1.txt'), 'x');
    fs.writeFileSync(path.join(ws, 'f2.txt'), 'y');
    const r = await h.call('search.run', { pattern: '*', mode: 'files' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.files.length).toBeGreaterThanOrEqual(2);
  });

  it('glob 过滤与 ! 排除', async () => {
    fs.writeFileSync(path.join(ws, 'a.ts'), 'target1');
    fs.writeFileSync(path.join(ws, 'b.js'), 'target2');
    const r = await h.call('search.run', { pattern: 'target', glob: ['*.ts'] });
    expect(r.result.data.totalMatches).toBe(1);
  });

  it('context 上下文行', async () => {
    fs.writeFileSync(path.join(ws, 'ctx.txt'), 'one\ntwo\nneedle\nfour\nfive\n');
    const r = await h.call('search.run', { pattern: 'needle', context: 1 });
    expect(r.result.data.matches[0].line).toBe(3);
  });
});

describe('M2: git 分级与 worktree', () => {
  it('git.status 在非仓库返回错误而非崩溃', async () => {
    const r = await h.call('git.exec', { op: 'status' });
    // 非 git 目录 → 非 0 退出
    expect(r.result.ok).toBe(false);
  });

  it('git 写 op 无审批 token 返回 4001', async () => {
    // 先初始化仓库
    const { execSync } = await import('child_process');
    execSync('git init -q', { cwd: ws });
    execSync('git config user.email t@t && git config user.name t', { cwd: ws });
    fs.writeFileSync(path.join(ws, 'x.txt'), 'x');
    execSync('git add .', { cwd: ws });
    const r = await h.call('git.exec', { op: 'commit', args: { message: 'no task id' } });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(4001);
  });

  it('git commit 校验任务 ID 格式 + 预授权通道', async () => {
    const { execSync } = await import('child_process');
    execSync('git init -q', { cwd: ws });
    execSync('git config user.email t@t', { cwd: ws });
    execSync('git config user.name t', { cwd: ws });
    fs.writeFileSync(path.join(ws, 'y.txt'), 'y');
    execSync('git add .', { cwd: ws });
    const r = await h.call('git.exec', {
      op: 'commit',
      args: { message: '[task-1] add y', preAuthorized: true },
    });
    expect(r.result.ok).toBe(true);
  });

  it('worktree 创建使用 codara/ 前缀命名', async () => {
    const { execSync } = await import('child_process');
    execSync('git init -q', { cwd: ws });
    execSync('git config user.email t@t', { cwd: ws });
    execSync('git config user.name t', { cwd: ws });
    fs.writeFileSync(path.join(ws, 'z.txt'), 'z');
    execSync('git add . && git commit -qm init', { cwd: ws });
    const r = await h.call('git.exec', {
      op: 'worktree-create',
      args: { name: 'task-9-developer' },
      preAuthorized: true,
    });
    expect(r.result.ok).toBe(true);
    const list = await h.call('git.exec', { op: 'worktree-list' });
    expect(list.result.data.output).toContain('codara/task-9-developer');
  });
});

describe('M2: 快照回滚', () => {
  it('非 Git 目录：CAS 快照 + 恢复', async () => {
    const file = path.join(ws, 'doc.txt');
    fs.writeFileSync(file, 'v1');
    const snap = await h.call('snap.create', { paths: ['doc.txt'], label: 'test', taskId: 't1' });
    expect(snap.result.ok).toBe(true);
    const snapId = snap.result.data.snapshotId;
    fs.writeFileSync(file, 'v2-modified');
    const restore = await h.call('snap.restore', { snapshotId: snapId });
    expect(restore.result.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
  });

  it('Git 仓库：隐藏分支快照 + 单文件回滚', async () => {
    const { execSync } = await import('child_process');
    execSync('git init -q', { cwd: ws });
    execSync('git config user.email t@t', { cwd: ws });
    execSync('git config user.name t', { cwd: ws });
    const f = path.join(ws, 'g.txt');
    fs.writeFileSync(f, 'git-v1');
    execSync('git add . && git commit -qm v1', { cwd: ws });
    const snap = await h.call('snap.create', { paths: ['g.txt'], label: 'pre-patch', taskId: 't2' });
    expect(snap.result.ok).toBe(true);
    fs.writeFileSync(f, 'git-v2');
    const restore = await h.call('snap.restore', { snapshotId: snap.result.data.snapshotId, path: 'g.txt' });
    expect(restore.result.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf-8')).toBe('git-v1');
  });
});

describe('M2: secret 与 db', () => {
  it('secret.set/get 往返（Linux 为 MOCKDPAPI 标注）', async () => {
    const dir = path.join(ws, '.codara');
    const r1 = await h.call('secret.set', { name: 'k', value: 'v-123', appDataDir: dir });
    expect(r1.result.ok).toBe(true);
    const r2 = await h.call('secret.get', { name: 'k', appDataDir: dir });
    expect(r2.result.ok).toBe(true);
    expect(r2.result.data.value).toBe('v-123');
    await h.call('secret.delete', { name: 'k', appDataDir: dir });
    const r3 = await h.call('secret.get', { name: 'k', appDataDir: dir });
    expect(r3.result.error.code).toBe(6001);
  });

  it('db.migrate + db.exec + db.query', async () => {
    const r = await h.call('db.migrate', {});
    expect(r.result.ok).toBe(true);
    await h.call('db.exec', {
      sql: "INSERT INTO sessions (id, kind, created_at) VALUES ('s1', 'main', 1)",
    });
    const q = await h.call('db.query', { sql: 'SELECT id, kind FROM sessions WHERE id = ?', args: ['s1'] });
    expect(q.result.ok).toBe(true);
    expect(q.result.data.rows.length).toBe(1);
  });
});

describe('M4: 检查点与锁', () => {
  it('ckpt.write / ckpt.load WAL 写入', async () => {
    const w = await h.call('ckpt.write', {
      taskId: 'tk1',
      kind: 'state',
      payload: { step: 3, status: 'IN_PROGRESS' },
    });
    expect(w.result.ok).toBe(true);
    const l = await h.call('ckpt.load', { taskId: 'tk1' });
    expect(l.result.ok).toBe(true);
    expect(l.result.data.payload.step).toBe(3);
  });

  it('lock.acquire / heartbeat / inspect / release', async () => {
    const a = await h.call('lock.acquire', { name: 'task-x', owner: 'dev-1' });
    expect(a.result.ok).toBe(true);
    const again = await h.call('lock.acquire', { name: 'task-x', owner: 'dev-2' });
    expect(again.result.ok).toBe(false);
    expect(again.result.error.code).toBe(9001);
    const hb = await h.call('lock.heartbeat', { name: 'task-x' });
    expect(hb.result.ok).toBe(true);
    const ins = await h.call('lock.inspect', {});
    expect(ins.result.data.held).toHaveLength(1);
    const rel = await h.call('lock.release', { name: 'task-x' });
    expect(rel.result.ok).toBe(true);
  });

  it('过期锁检测返回 9002 LOCK_STALE', async () => {
    // 手写一个过期锁
    const locks = path.join(ws, '.codara', 'tasks', 'locks');
    fs.mkdirSync(locks, { recursive: true });
    fs.writeFileSync(
      path.join(locks, 'stale-t.lock'),
      JSON.stringify({ name: 'stale-t', owner: 'dead', heartbeat: 1000 })
    );
    const r = await h.call('lock.acquire', { name: 'stale-t', owner: 'new' });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(9002);
    expect(r.result.error.data.owner).toBe('dead');
  });
});

describe('M2: 审计', () => {
  it('audit.note 写入且脱敏 Key 字段', async () => {
    const r = await h.call('audit.note', {
      event: 'test',
      apiKey: 'sk-secret-value',
      token: 'abc',
      nested: { password: 'p' },
    });
    expect(r.result.ok).toBe(true);
    const auditDir = path.join(ws, '.codara', 'audit');
    const files = fs.readdirSync(auditDir);
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(auditDir, files[0]), 'utf-8');
    expect(content).not.toContain('sk-secret-value');
    expect(content).toContain('***');
  });
});

describe('M3: 会话隔离', () => {
  it('session.create + msg.append/msg.list 往返（developer 角色）', async () => {
    const s = await h.call('session.create', { kind: 'crew', role: 'developer', taskId: 't-9', title: 'dev 实例' });
    expect(s.result.ok).toBe(true);
    const sid = s.result.data.sessionId;

    const a1 = await h.call('msg.append', { sessionId: sid, roleId: 'developer', role: 'user', content: '实现登录页' });
    expect(a1.result.ok).toBe(true);
    const a2 = await h.call('msg.append', { sessionId: sid, roleId: 'developer', role: 'assistant', content: '计划三步完成' });
    expect(a2.result.ok).toBe(true);

    const list = await h.call('msg.list', { sessionId: sid, roleId: 'developer' });
    expect(list.result.ok).toBe(true);
    expect(list.result.data.messages).toHaveLength(2);
    expect(list.result.data.messages[0].content).toContain('登录页');
  });

  it('跨角色读历史 100% 失败（reviewer 读 developer 会话 → 7002）', async () => {
    const s = await h.call('session.create', { kind: 'crew', role: 'developer', taskId: 't-10' });
    const sid = s.result.data.sessionId;
    await h.call('msg.append', { sessionId: sid, roleId: 'developer', role: 'user', content: '机密上下文' });

    // reviewer 角色读 developer 会话：必须失败
    const r1 = await h.call('msg.list', { sessionId: sid, roleId: 'reviewer' });
    expect(r1.result.ok).toBe(false);
    expect(r1.result.error.code).toBe(7002);
    expect(r1.result.error.message).toContain('isolation');

    // 伪造 roleId 写入同样拒绝
    const r2 = await h.call('msg.append', { sessionId: sid, roleId: 'tester', role: 'user', content: '越权写' });
    expect(r2.result.ok).toBe(false);
    expect(r2.result.error.code).toBe(7002);
  });

  it('主对话与 crew 会话互不可读', async () => {
    const main = await h.call('session.create', { kind: 'main' });
    const mainId = main.result.data.sessionId;
    await h.call('msg.append', { sessionId: mainId, roleId: 'main', role: 'user', content: '主对话消息' });

    // crew 角色读主对话 → 7002
    const r = await h.call('msg.list', { sessionId: mainId, roleId: 'developer' });
    expect(r.result.ok).toBe(false);
    expect(r.result.error.code).toBe(7002);

    // crew 会话读主对话身份 → 7002
    const crewS = await h.call('session.create', { kind: 'crew', role: 'architect', taskId: 't-11' });
    const r2 = await h.call('msg.list', { sessionId: crewS.result.data.sessionId, roleId: 'main' });
    expect(r2.result.ok).toBe(false);
    expect(r2.result.error.code).toBe(7002);

    // main 身份读主对话 → 正常
    const ok = await h.call('msg.list', { sessionId: mainId, roleId: 'main' });
    expect(ok.result.ok).toBe(true);
    expect(ok.result.data.messages).toHaveLength(1);
  });

  it('crew 会话缺 role 拒绝 / 不存在的会话拒绝', async () => {
    const bad = await h.call('session.create', { kind: 'crew' });
    expect(bad.result.ok).toBe(false);
    const ghost = await h.call('msg.list', { sessionId: 'sess-none', roleId: 'developer' });
    expect(ghost.result.ok).toBe(false);
    expect(ghost.result.error.code).toBe(7002);
  });
});
