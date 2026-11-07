import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Los tests de auth comparten la base de prueba y la vacían entre casos: un archivo a la vez.
    fileParallelism: false,
  },
});
