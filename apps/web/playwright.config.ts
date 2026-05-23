import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env['BASE_URL'] ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Logs in once → shared storage state (avoids the 5/60s login throttle).
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    // Unauthenticated specs (login page, public portal, KB). Authenticated specs
    // (kanban, agent-flows) are excluded — they run in the project below.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /(kanban|agent-flows)\.spec\.ts/,
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testIgnore: /(kanban|agent-flows)\.spec\.ts/,
    },
    // Authenticated desktop — staff workflows (storageState from auth.setup).
    {
      name: 'chromium-auth',
      testMatch: /(kanban|agent-flows)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/staff.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
