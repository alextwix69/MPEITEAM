import { expect, test } from '@playwright/test';

test('renders the Russian accessible shell and readiness state', async ({ page }) => {
  await page.route('**/health/ready', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        status: 'ready',
        checkedAt: new Date().toISOString(),
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
          objectStorage: { status: 'up' },
          worker: { status: 'up' },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { name: 'Команда.МЭИ' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(/Сервис (готов|работает с ограничениями)/u);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('shows a recoverable error and retries from keyboard when API is unavailable', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/health/ready', async (route) => {
    calls += 1;
    await route.abort('failed');
  });

  await page.goto('/');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не удалось проверить состояние сервиса' }),
  ).toBeVisible();
  const retry = page.getByRole('button', { name: 'Повторить' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls).toBeGreaterThan(1);
});
