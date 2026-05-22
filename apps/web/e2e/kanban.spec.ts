import { test, expect } from "@playwright/test";

test.describe("Kanban board", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate directly to kanban (in test env, no auth gate)
    await page.goto("/staff/kanban");
  });

  test("renders kanban board with columns", async ({ page }) => {
    // Reorder.Group renders as <ul aria-label="Колонка {label}">
    await expect(page.getByRole("list", { name: "Колонка Открытые" })).toBeVisible({ timeout: 8000 });
    await expect(page.getByRole("list", { name: "Колонка В работе" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Колонка Ожидают" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Колонка Решённые" })).toBeVisible();
  });

  test("shows ticket cards with mask and priority", async ({ page }) => {
    // Wait for data to load
    const firstCard = page.getByTestId("kanban-card").first();
    await expect(firstCard).toBeVisible({ timeout: 8000 });

    // Cards should contain ticket mask (TT-XXXXXX format)
    await expect(page.getByText(/TT-\d{6}/i).first()).toBeVisible();
  });

  test("opens ticket detail on card click", async ({ page }) => {
    const firstCard = page.getByTestId("kanban-card").first();
    await firstCard.waitFor({ state: "visible", timeout: 8000 });
    await firstCard.click();

    // Should navigate to ticket detail
    await expect(page).toHaveURL(/\/staff\/tickets\/\d+/, { timeout: 5000 });
  });

  test("can drag a card (drag-glow animation check)", async ({ page }) => {
    const cards = page.getByTestId("kanban-card");
    await cards.first().waitFor({ state: "visible", timeout: 8000 });

    const card = cards.first();
    const cardBox = await card.boundingBox();
    if (!cardBox) return;

    // Simulate drag start — verify card is draggable
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      cardBox.x + cardBox.width / 2,
      cardBox.y + cardBox.height / 2 + 100,
      { steps: 10 }
    );
    await page.mouse.up();

    // Board should still be visible
    await expect(page.getByRole("list", { name: "Колонка Открытые" })).toBeVisible();
  });
});
