import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/sample-suite',
  timeout: 10000,
  retries: 0,
  reporter: [
    ['list'],
    [
      './src/reporter/system1Reporter.ts',
      {
        mode: 'cascade',
        confidenceThreshold: 0.78,
        marginThreshold: 0.28,
        outputDir: 'dist-report',
      },
    ],
  ],
  use: {
    headless: true,
  },
});
