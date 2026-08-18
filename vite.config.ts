import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 静的ファイルとして file:// から開けるように相対パスで出す
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
