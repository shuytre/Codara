// 构建 Rust sidecar 并拷贝二进制到 electron/resources/bin/<triple>/
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sidecarDir = path.join(root, 'sidecar');

// rust-toolchain.toml 已 pin 1.77.2，rustup 自动选择
const cmd = process.platform === 'win32' ? 'cargo build --release' : 'cargo build --release';
console.log(`[build-sidecar] ${cmd} in ${sidecarDir}`);
execSync(cmd, { cwd: sidecarDir, stdio: 'inherit' });

const triple = (() => {
  switch (process.platform) {
    case 'win32':
      return 'x86_64-pc-windows-msvc';
    case 'darwin':
      return 'x86_64-apple-darwin';
    default:
      return 'x86_64-unknown-linux-gnu';
  }
})();
const binName = process.platform === 'win32' ? 'codara-sidecar.exe' : 'codara-sidecar';
const src = path.join(sidecarDir, 'target', 'release', binName);
const outDir = path.join(root, 'resources', 'bin', triple);
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, binName));
console.log(`[build-sidecar] copied to ${outDir}`);
