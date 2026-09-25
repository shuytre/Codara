// esbuild 打包主进程：CJS、target node16（Electron 22 内置 Node 16.17）
// node-pty 是原生模块，external 不打包
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  outfile: 'dist/main.js',
  sourcemap: true,
  external: ['electron', 'node-pty'],
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  outfile: 'dist/preload.js',
  external: ['electron'],
  logLevel: 'info',
});
