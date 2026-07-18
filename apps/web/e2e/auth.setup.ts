import { test as setup, expect } from '@playwright/test';

const AUTH_FILE = 'e2e/.auth/staff.json';

// Logs in ONCE and persists the authenticated storage state (HttpOnly cookies +
// th_authed marker) so authenticated specs reuse it without each tripping the
// 5/60s login throttle.
setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('admin@23telecom.example');
  await page.locator('#password').fill('demo1234');
  const loginResponsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/auth/login') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /войти/i }).click();
  const loginResponse = await loginResponsePromise;
  const loginBody = (await loginResponse.json()) as Record<string, unknown>;
  expect(loginBody).toHaveProperty('staff');
  expect(loginBody).not.toHaveProperty('accessToken');
  expect(loginBody).not.toHaveProperty('refreshToken');

  await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => /^(?:__Host-)?th_access$/.test(cookie.name))?.httpOnly).toBe(true);
  expect(cookies.find((cookie) => /^(?:(?:__Host|__Secure)-)?th_refresh$/.test(cookie.name))?.httpOnly).toBe(
    true,
  );

  // Browser-context proof: refresh rotates cookies but exposes no JWT to JavaScript.
  const api = (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000').replace(/\/$/, '');
  const refreshBody = await page.evaluate(async (apiBase) => {
    // Fetching the token body works both for same-host dev and a separate API
    // hostname in production; the matching host-only cookie is stored by the browser.
    const csrfResponse = await fetch(`${apiBase}/api/auth/csrf`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!csrfResponse.ok) throw new Error(`CSRF bootstrap failed: ${csrfResponse.status}`);
    const csrf = ((await csrfResponse.json()) as { csrfToken?: string }).csrfToken;
    if (!csrf) throw new Error('Missing CSRF token');
    const response = await fetch(`${apiBase}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrf },
    });
    if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }, api);
  expect(refreshBody).toEqual({ ok: true });
  expect(refreshBody).not.toHaveProperty('accessToken');
  expect(refreshBody).not.toHaveProperty('refreshToken');

  await page.context().storageState({ path: AUTH_FILE });
});
