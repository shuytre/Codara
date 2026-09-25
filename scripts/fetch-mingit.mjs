// 下载 MinGit x64 2.46.2 到 resources/MinGit/（打包时引用；运行时用系统 git 开发）
// 用法：node scripts/fetch-mingit.mjs
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'resources', 'MinGit');
const version = '2.46.2';
const url = `https://github.com/git-for-windows/git/releases/download/v${version}.windows.1/MinGit-2.46.2-64-bit.zip`;

if (fs.existsSync(path.join(outDir, 'cmd', 'git.exe'))) {
  console.log('[fetch-mingit] already present');
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, 'mingit.zip');
console.log(`[fetch-mingit] downloading ${url}`);
execSync(`curl -L -o "${zip}" "${url}"`, { stdio: 'inherit' });
console.log('[fetch-mingit] extracting');
execSync(`unzip -q -o "${zip}" -d "${outDir}"`, { stdio: 'inherit' });
fs.rmSync(zip);
console.log('[fetch-mingit] done');
