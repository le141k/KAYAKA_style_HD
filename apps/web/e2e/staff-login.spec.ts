import { test, expect } from "@playwright/test";

test.describe("Staff login flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders login page with brand panel and form", async ({ page }) => {
    // Brand panel (desktop)
    await expect(page.getByText(/управляйте обращениями/i)).toBeVisible();

    // Form fields — use id-based locators to avoid ambiguity with aria-label on toggle button
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: /войти/i })).toBeVisible();
  });

  test("shows validation error for invalid email", async ({ page }) => {
    await page.getByLabel(/email/i).fill("not-an-email");
    await page.locator("#password").fill("password123");
    await page.getByRole("button", { name: /войти/i }).click();
    await expect(page.getByText(/корректный email/i)).toBeVisible();
  });

  test("shows error for short password", async ({ page }) => {
    await page.getByLabel(/email/i).fill("agent@23telecom.ru");
    await page.locator("#password").fill("12345");
    await page.getByRole("button", { name: /войти/i }).click();
    await expect(page.getByText(/минимум 6 символов/i)).toBeVisible();
  });

  test("password toggle shows/hides password", async ({ page }) => {
    const passwordInput = page.locator("#password");
    await passwordInput.fill("secret123");

    await expect(passwordInput).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: "Показать пароль" }).click();
    await expect(passwordInput).toHaveAttribute("type", "text");

    await page.getByRole("button", { name: "Скрыть пароль" }).click();
    await expect(passwordInput).toHaveAttribute("type", "password");
  });

  test("forgotten password link is visible", async ({ page }) => {
    await expect(page.getByRole("link", { name: /забыли пароль/i })).toBeVisible();
  });
});
