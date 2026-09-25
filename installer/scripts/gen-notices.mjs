// 生成 NOTICES.txt：扫描 node_modules + sidecar Cargo.lock 的许可证清单（规格 7.10 许可证随安装目录分发）
// 用法：node gen-notices.mjs <repoRoot> <outFile>
import * as fs from 'fs';
import * as path from 'path';

const repo = process.argv[2] || path.resolve(process.cwd(), '..');
const out = process.argv[3] || path.join(repo, 'installer', 'dist', 'NOTICES.txt');

// 手工登记项（非 npm/cargo 资产，规格固定）
const MANUAL = [
  ['MinGit 2.46.2 x64', 'GPL-2.0-only', 'https://git-scm.com/ (PortableGit build by git-for-windows)'],
  ['ripgrep (sidecar 内嵌)', 'MIT OR Unlicense', 'https://github.com/BurntSushi/ripgrep'],
  ['内置字体（UI 渲染）', 'SIL OFL 1.1', '随 payload/fonts 分发'],
];

function collectNpm() {
  const list = [];
  const nm = path.join(repo, 'node_modules');
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('@')) {
        walk(full, depth + 1);
        continue;
      }
      const pkgFile = path.join(full, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
        list.push({ name: `${pkg.name ?? e.name}@${pkg.version ?? '?'}`, license: pkg.license ?? 'UNKNOWN' });
      } catch {
        /* 无 package.json 跳过 */
      }
      walk(full, depth + 1);
    }
  };
  walk(nm, 0);
  return list;
}

function collectCargo() {
  const list = [];
  const lockFile = path.join(repo, 'sidecar', 'Cargo.lock');
  try {
    const lock = fs.readFileSync(lockFile, 'utf-8');
    for (const m of lock.matchAll(/\[\[package\]\]\s*name = "([^"]+)"\s*version = "([^"]+)"/g)) {
      list.push({ name: `${m[1]} ${m[2]}`, license: 'see crate (MIT/Apache-2.0 dominant)' });
    }
  } catch {
    /* 无 Cargo.lock 跳过 */
  }
  return list;
}

const npm = collectNpm();
const cargo = collectCargo();

const lines = [
  'Codara — Third-Party Software Notices',
  '=====================================',
  `Generated: ${new Date().toISOString()}`,
  '',
  '本产品包含以下第三方软件，感谢原作者。',
  '',
  '--- 固定资产 ---',
  ...MANUAL.map(([n, l, note]) => `${n}\n  License: ${l}\n  ${note}`),
  '',
  `--- npm 依赖（${npm.length}）---`,
  ...npm.map((p) => `${p.name}  [${p.license}]`),
  '',
  `--- Rust crates（${cargo.length}）---`,
  ...cargo.map((p) => `${p.name}  [${p.license}]`),
  '',
];

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'), 'utf-8');
console.log(`NOTICES written: ${out} (npm=${npm.length}, cargo=${cargo.length})`);
