import { test, expect } from "@playwright/test";

test.describe("Knowledge base search", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/kb");
  });

  test("renders KB page with categories and search", async ({ page }) => {
    // Use heading role to disambiguate from the nav link that also says "База знаний"
    await expect(page.getByRole("heading", { name: "База знаний" })).toBeVisible();
    await expect(page.getByTestId("kb-search-input")).toBeVisible();
  });

  test("shows categories", async ({ page }) => {
    // Use the category buttons (aria-pressed) to avoid strict mode violation from article link spans
    await expect(
      page.getByRole("button", { name: /Техническая поддержка|Подключение и настройка/ }).first()
    ).toBeVisible({ timeout: 8000 });
  });

  test("search filters articles", async ({ page }) => {
    const searchInput = page.getByTestId("kb-search-input");
    await searchInput.fill("PPPoE");
    await page.waitForTimeout(500); // debounce

    await expect(
      page.getByText(/PPPoE/i).first()
    ).toBeVisible({ timeout: 8000 });
  });

  test("clicking article navigates to article page", async ({ page }) => {
    await page
      .getByTestId("kb-article-link")
      .first()
      .waitFor({ state: "visible", timeout: 8000 });

    await page.getByTestId("kb-article-link").first().click();

    await expect(page).toHaveURL(/\/kb\/.+/, { timeout: 5000 });
  });

  test("no results message for unknown query", async ({ page }) => {
    const searchInput = page.getByTestId("kb-search-input");
    await searchInput.fill("xyzzy-not-found-12345");
    await page.waitForTimeout(500);

    await expect(
      page.getByText(/не найден|no articles/i)
    ).toBeVisible({ timeout: 8000 });
  });
});
