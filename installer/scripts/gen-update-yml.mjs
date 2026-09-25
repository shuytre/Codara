// 生成 electron-updater 配置：锁版 + 主源/国内镜像（规格 7.8：electron-updater 锁版 + 镜像源配置）
// 用法：node gen-update-yml.mjs <version> <outDir>
import * as fs from 'fs';
import * as path from 'path';

const version = process.argv[2] || '0.1.0';
const outDir = process.argv[3] || path.resolve(process.cwd(), '..', 'installer', 'dist');
const lockVersion = 'electron-updater@6.3.9'; // 锁版：避免上游 breaking change 波及 Win7

// 主源 + 镜像：electron-updater 原生支持多 channel yaml（主源 failover 由 app 侧代理实现）
const latestYml = [
  'version: ' + version,
  'files:',
  `  - url: https://dl.codara.example.com/stable/${version}/`,
  '    sha512: PLACEHOLDER_SHA512_AFTER_BUILD',
  '  - url: https://mirror.cn.codara.example.com/stable/' + `${version}/`,
  '    sha512: PLACEHOLDER_SHA512_AFTER_BUILD',
  'path: codara-setup.exe',
  'sha512: PLACEHOLDER_SHA512_AFTER_BUILD',
  'releaseName: Codara ' + version,
  'releaseNotes: https://codara.example.com/notes/' + version,
].join('\n');

// dev-app-update.yml：开发机联调升级通道（app 检测 dev 模式读取）
const devYml = [
  `# dev-app-update.yml (electron-updater ${lockVersion}, locked)`,
  'provider: generic',
  'url: https://dl.codara.example.com/stable/' + version,
  'channel: stable',
  '# 国内镜像（备用源，手动切换）：https://mirror.cn.codara.example.com/stable/' + version,
].join('\n');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.yml'), latestYml + '\n', 'utf-8');
fs.writeFileSync(path.join(outDir, 'dev-app-update.yml'), devYml + '\n', 'utf-8');
console.log(`update yml written to ${outDir} (updater locked at ${lockVersion})`);
