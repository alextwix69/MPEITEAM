import { expect, test } from '@playwright/test';

test('recovers the mounted session provider after a bootstrap failure', async ({ page }) => {
  let available = false;
  let csrfRequests = 0;
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: available ? 200 : 503,
      json: available
        ? {
            id: '0198a8e7-5132-7c8b-a566-0242ac120002',
            formalRole: 'student',
            systemRole: 'user',
            state: 'active',
            emailVerified: true,
            capabilities: ['profile.read'],
            createdAt: '2026-09-05T10:00:00Z',
          }
        : { error: { code: 'SERVICE_UNAVAILABLE', message: 'Временно недоступно.' } },
    }),
  );
  await page.route('**/api/v1/auth/csrf', (route) => {
    csrfRequests += 1;
    return route.fulfill({ json: { csrfToken: 'x'.repeat(43) } });
  });
  await page.route('**/health/ready', (route) =>
    route.fulfill({
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
    }),
  );

  await page.goto('/');
  await expect(page.getByText('Не удалось проверить сессию.', { exact: true })).toBeVisible();
  available = true;
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expect.poll(() => csrfRequests).toBe(1);
  // No navigation/reload: the existing observer must receive the successful retry.
  await expect(page.getByText('Вы вошли в аккаунт.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  await expect(page.getByText('Не удалось проверить сессию.', { exact: true })).toBeHidden();
});
