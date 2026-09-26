// NSIS 安装包构建流水：四变体（online/offline × per-user/admin）+ 体积预算检查
// 前置：makensis（NSIS 3.x）在 PATH；payload 由 prepare-payload 阶段准备
// 用法：node build-installer.mjs [--outDir dist]
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nsisDir = path.join(here, '..', 'nsis');
const distDir = path.join(here, '..', 'dist');
fs.mkdirSync(distDir, { recursive: true });

const VARIANTS = [
  { script: 'installer-online.nsi', perUser: false, maxBytes: 10 * 1024 * 1024 },
  { script: 'installer-online.nsi', perUser: true, maxBytes: 10 * 1024 * 1024 },
  { script: 'installer-offline.nsi', perUser: false, maxBytes: 180 * 1024 * 1024 },
  { script: 'installer-offline.nsi', perUser: true, maxBytes: 180 * 1024 * 1024 },
];

const produced = [];
// POSIX 版 makensis 只接受 '-' 开关前缀；Windows 版两者皆可，保持 '/'
const switchPrefix = process.platform === 'win32' ? '/' : '-';
for (const v of VARIANTS) {
  const defines = [`BUILD_FLAVOR=${v.script.includes('online') ? 'online' : 'offline'}`];
  if (v.perUser) defines.push('PER_USER=1');
  const args = [switchPrefix + 'D' + defines[0], ...(v.perUser ? [switchPrefix + 'DPER_USER=1'] : []), v.script];
  console.log(`> makensis ${args.join(' ')}`);
  try {
    execFileSync('makensis', args, { cwd: nsisDir, stdio: 'pipe' });
  } catch (e) {
    // 转发 makensis 的真实编译输出（CI 依赖此输出定位错误）
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    throw e;
  }

  const flavor = v.script.includes('online') ? 'online' : 'offline';
  const mode = v.perUser ? 'per-user' : 'admin';
  const out = path.join(nsisDir, '..', 'dist', `codara-0.1.0-${mode}-${flavor}.exe`);
  // 产物缺失必须硬失败：原实现静默跳过，导致「4 件产物里的安装器实际为空包」也能 CI 绿
  if (!fs.existsSync(out)) {
    throw new Error(`makensis 未产出预期文件：${out}`);
  }
  const size = fs.statSync(out).size;
  if (size > v.maxBytes) {
    throw new Error(`体积超预算：${path.basename(out)} ${size} > ${v.maxBytes}`);
  }
  produced.push({ file: out, size });
}

console.log('build-installer done:');
for (const p of produced) console.log(`  ${path.basename(p.file)}  ${(p.size / 1024 / 1024).toFixed(1)} MB`);