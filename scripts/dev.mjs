// 本地开发启动：构建全部产物后启动 Codara（sidecar 由主进程拉起）
// 用法：node scripts/dev.mjs [--skip-build]
import { execSync, spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, cwd = root) => {
  console.log(`[dev] ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

if (!process.argv.includes('--skip-build')) {
  run('pnpm build:shared');
  run('pnpm build:sidecar');
  run('pnpm build:main');
  run('pnpm build:renderer');
}

// electron 可执行定位：优先本地 node_modules（pnpm 安装时已 built）
const electronBin = path.join(root, 'node_modules', '.bin', 'electron');
try {
  // electron/ 目录含 package.json（main: dist/main.js），以该目录为 app root
  run(`"${process.platform === 'win32' ? electronBin + '.cmd' : electronBin}" electron`);
} catch (e) {
  console.error('[dev] electron 启动失败（Linux 沙箱无显示器属正常；Windows 上请确认已 pnpm install）');
  process.exit(e.status ?? 1);
}
