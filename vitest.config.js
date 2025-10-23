import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.js'],
    coverage: { reporter: ['text', 'lcov'] }
  }
});
