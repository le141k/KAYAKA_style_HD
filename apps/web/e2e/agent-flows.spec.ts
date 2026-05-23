import { test, expect, type APIRequestContext } from '@playwright/test';

// Authenticated staff workflows. Runs in the "chromium-auth" project (storageState
// from auth.setup → admin). page.request inherits the HttpOnly cookie, so API calls
// to :4000 are authenticated and used for stable end-to-end assertions.

const API = 'http://localhost:4000/api';

async function firstId(req: APIRequestContext, path: string): Promise<number> {
  const res = await req.get(`${API}${path}`);
  const body = await res.json();
  const arr = Array.isArray(body) ? body : (body.data ?? []);
  return arr[0].id as number;
}

test.describe('Agent workflow', () => {
  test('reply + internal note through the UI', async ({ page }) => {
    await page.goto('/staff/tickets/1');
    await page.waitForLoadState('networkidle');

    const before = await (await page.request.get(`${API}/tickets/1`)).json();

    // Public reply via the UI.
    const stamp = Date.now();
    await page.locator('#reply-textarea').fill(`E2E reply ${stamp}`);
    await page.getByTestId('reply-submit').click();
    await expect(page.getByText(`E2E reply ${stamp}`)).toBeVisible({ timeout: 10_000 });

    // Internal note via the UI (note tab).
    await page.getByRole('tab', { name: /заметка/i }).click();
    await page.locator('#note-textarea').fill(`E2E note ${stamp}`);
    await page.getByTestId('reply-submit').click();
    await page.waitForTimeout(1000);

    const after = await (await page.request.get(`${API}/tickets/1`)).json();
    expect(after.totalReplies).toBeGreaterThan(before.totalReplies);
  });

  test('status, priority, assign and macro end-to-end (authed API through the stack)', async ({ page }) => {
    const req = page.request;
    const statusId = await firstId(req, '/ticket-statuses');
    const priorityId = await firstId(req, '/ticket-priorities');
    const assignableId = await firstId(req, '/staff/assignable');

    // status
    expect((await req.patch(`${API}/tickets/2/status`, { data: { statusId } })).status()).toBe(200);
    // priority
    expect((await req.patch(`${API}/tickets/2/priority`, { data: { priorityId } })).status()).toBe(200);
    // assign (uses the agent-accessible directory)
    expect(
      (await req.patch(`${API}/tickets/2/assign`, { data: { ownerStaffId: assignableId } })).status(),
    ).toBe(200);

    // macro: create then apply (UI offers no seeded macro, so we create one)
    const macroRes = await req.post(`${API}/admin/macros`, {
      data: { title: `E2E macro ${Date.now()}`, replyText: '', isShared: true, actions: [] },
    });
    expect(macroRes.status()).toBe(201);
    const macroId = (await macroRes.json()).id as number;
    expect((await req.post(`${API}/tickets/2/apply-macro`, { data: { macroId } })).status()).toBe(200);

    const ticket = await (await req.get(`${API}/tickets/2`)).json();
    expect(ticket.statusId).toBe(statusId);
    expect(ticket.priorityId).toBe(priorityId);
    expect(ticket.ownerStaffId).toBe(assignableId);
  });
});

test.describe('Bulk actions', () => {
  test('select rows in the list and bulk-change status', async ({ page }) => {
    await page.goto('/staff/tickets');
    await page.waitForLoadState('networkidle');

    // Check the first two row checkboxes (index 0 is the select-all header box).
    const boxes = page.locator('input[type="checkbox"]');
    await boxes.nth(1).check();
    await boxes.nth(2).check();
    await expect(page.getByText(/Выбрано:/).first()).toBeVisible();

    // Pick a bulk status; the bar's first Select is the status changer.
    await page.getByLabel('Массовая смена статуса').click();
    await page.getByRole('option', { name: 'Закрытые' }).click();
    // Toast confirms how many were updated.
    await expect(page.getByText(/обновлено/i).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Public submit with priority', () => {
  test('a client choosing "Критический" produces an Urgent ticket', async ({ page }) => {
    const subject = `E2E urgent ${Date.now()}`;
    await page.goto('/submit');
    await page.waitForLoadState('networkidle');

    await page.getByLabel(/ваше имя/i).fill('E2E Client');
    await page.getByLabel(/email/i).fill('e2e.client@example.com');
    await page.getByLabel(/тема обращения/i).fill(subject);
    await page.getByLabel(/описание/i).fill('Срочная проблема для проверки приоритета.');

    // Priority select → "Критический" (urgent).
    await page.getByLabel('Выберите приоритет').click();
    await page.getByRole('option', { name: /критический/i }).click();

    await page.getByLabel(/тема обращения/i).press('Enter');
    await expect(page.getByRole('heading', { name: /обращение зарегистрировано/i })).toBeVisible({
      timeout: 10_000,
    });

    // Verify the created ticket actually got Urgent (was inverted before the fix).
    const priorities = await (await page.request.get(`${API}/ticket-priorities`)).json();
    const urgentId = priorities.find((p: { title: string }) => p.title.toLowerCase() === 'urgent').id;
    const list = await (
      await page.request.get(`${API}/tickets?search=${encodeURIComponent(subject)}&limit=1`)
    ).json();
    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data[0].priorityId).toBe(urgentId);
  });
});
