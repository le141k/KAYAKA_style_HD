import { test as setup, expect } from '@playwright/test';

const AUTH_FILE = 'e2e/.auth/staff.json';

// Logs in ONCE and persists the authenticated storage state (HttpOnly cookies +
// th_authed marker) so authenticated specs reuse it without each tripping the
// 5/60s login throttle.
setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('admin@23telecom.example');
  await page.locator('#password').fill('demo1234');
  await page.getByRole('button', { name: /войти/i }).click();
  await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });
  await page.context().storageState({ path: AUTH_FILE });
});
