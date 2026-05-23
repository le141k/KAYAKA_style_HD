import { test, expect } from '@playwright/test';

// Runs in the authenticated "chromium-auth" project (storageState from auth.setup).
test.describe('Kanban board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/staff/kanban');
    await page.waitForLoadState('networkidle');
  });

  test('renders kanban board with columns', async ({ page }) => {
    // The native-DnD rewrite renders columns as <div aria-label="Колонка {label}">.
    await expect(page.getByLabel('Колонка Открытые')).toBeVisible({ timeout: 8000 });
    await expect(page.getByLabel('Колонка В работе')).toBeVisible();
    await expect(page.getByLabel('Колонка Ожидают')).toBeVisible();
    await expect(page.getByLabel('Колонка Решённые')).toBeVisible();
  });

  test('shows ticket cards with mask', async ({ page }) => {
    const firstCard = page.getByTestId('kanban-card').first();
    await expect(firstCard).toBeVisible({ timeout: 8000 });
    // Cards show the ticket mask (TT-XXXXXX).
    await expect(page.getByText(/TT-\d{6}/i).first()).toBeVisible();
  });

  test('opens ticket detail on card click', async ({ page }) => {
    const firstCard = page.getByTestId('kanban-card').first();
    await firstCard.waitFor({ state: 'visible', timeout: 8000 });
    await firstCard.click();
    await expect(page).toHaveURL(/\/staff\/tickets\/\d+/, { timeout: 5000 });
  });

  test('can drag a card without crashing the board', async ({ page }) => {
    const cards = page.getByTestId('kanban-card');
    await cards.first().waitFor({ state: 'visible', timeout: 8000 });

    const card = cards.first();
    const cardBox = await card.boundingBox();
    if (!cardBox) return;

    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2 + 100, { steps: 10 });
    await page.mouse.up();

    // Board still renders after the drag gesture.
    await expect(page.getByLabel('Колонка Открытые')).toBeVisible();
  });
});
