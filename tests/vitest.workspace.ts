// vitest workspace：contract / main / renderer / integration 四个项目
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'contract',
      include: ['../shared/tests/**/*.test.ts'],
      environment: 'node',
    },
    root: __dirname,
    resolve: {
      alias: {
        '@codara/contract': new URL('../shared/src/index.ts', import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: 'main',
      include: ['main/**/*.test.ts'],
      environment: 'node',
    },
    root: __dirname,
  },
  {
    test: {
      name: 'integration',
      include: ['integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30000,
    },
    root: __dirname,
  },
  {
    test: {
      name: 'renderer',
      include: ['renderer/**/*.test.ts'],
      environment: 'node',
    },
    root: __dirname,
  },
]);
