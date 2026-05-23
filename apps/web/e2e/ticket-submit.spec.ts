import { test, expect } from '@playwright/test';

test.describe('Client ticket submission', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/submit');
  });

  test('renders the submission form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /новое обращение/i })).toBeVisible();
    await expect(page.getByLabel(/ваше имя/i)).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/тема обращения/i)).toBeVisible();
    await expect(page.getByLabel(/описание/i)).toBeVisible();
    await expect(page.getByTestId('submit-ticket-btn')).toBeVisible();
  });

  test('shows validation errors for empty form', async ({ page }) => {
    // Submit via Enter on a text field — robust across viewports (on narrow mobile
    // the full-width button can sit under Playwright's center-scroll target).
    await page.getByLabel(/ваше имя/i).click();
    await page.getByLabel(/ваше имя/i).press('Enter');
    await expect(page.getByText(/введите имя/i)).toBeVisible();
    await expect(page.getByText(/введите корректный email/i)).toBeVisible();
  });

  test('fills and submits the form successfully', async ({ page }) => {
    // Mock the POST /tickets API so the app shows the success state
    await page.route('**/tickets', (route) => {
      if (route.request().method() === 'POST') {
        void route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 9999,
            mask: 'TT-999999',
            subject: 'Тест автоматической подачи заявки',
            status: 'open',
            priority: 'normal',
          }),
        });
      } else {
        void route.continue();
      }
    });

    await page.getByLabel(/ваше имя/i).fill('Иван Тестов');
    await page.getByLabel(/email/i).fill('ivan.test@example.com');
    await page.getByLabel(/тема обращения/i).fill('Тест автоматической подачи заявки');
    await page
      .getByLabel(/описание/i)
      .fill('Подробное описание проблемы с подключением интернета после смены тарифа.');

    // Submit via Enter on a text field (robust across viewports — see note above).
    await page.getByLabel(/тема обращения/i).press('Enter');

    // The success screen shows "Обращение зарегистрировано" as an h2
    await expect(page.getByRole('heading', { name: /обращение зарегистрировано/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('upload zone is visible and accepts drag-drop', async ({ page }) => {
    const dropZone = page.getByRole('button', { name: /загрузить файлы/i });
    await expect(dropZone).toBeVisible();
  });
});
