/*
 * Unit tests of app-side logic that runs in Node (expo/native modules are mocked per test with vi.mock).
 * Run from app/: ../core/node_modules/.bin/vitest run --config vitest.config.ts
 * Plain object (no `vitest/config` import): vitest is installed in core/, not in app/.
 */
import path from 'path';

export default {
  resolve: {
    alias: {
      '@citytour/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@/': `${path.resolve(__dirname, 'src')}/`
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
};
