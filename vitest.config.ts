import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'lib/**/*.test.tsx'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname,
    },
  },
});
