import { expect, test } from '@playwright/test';

test('registers a student with four explicit consents', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/v1/auth/registrations', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      json: {
        accountId: '0198a8e7-5132-7c8b-a566-0242ac120002',
        accountState: 'unverified',
        verificationEmailQueued: true,
      },
    });
  });

  await page.goto('/registration');
  await page.getByLabel('Электронная почта').fill('student@mpei.ru');
  await page.getByLabel('Пароль').fill('very-long-password');
  await page.getByLabel('ФИО').fill('Иван Иванов');
  await page.getByLabel('Специализация').fill('Энергетика');
  await page.getByLabel('Институт').fill('ИЭТ');
  await page.getByLabel('Курс').selectOption('2');

  const checkboxes = page.getByRole('checkbox');
  await expect(checkboxes).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(checkboxes.nth(index)).not.toBeChecked();
    await checkboxes.nth(index).check();
  }
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/registration\/check-email$/u);
  expect(submitted).toMatchObject({
    email: 'student@mpei.ru',
    formalRole: 'student',
    profile: { institute: 'ИЭТ', course: 2 },
  });
  expect((submitted?.consents as unknown[]).length).toBe(4);
});

test('verifies email, removes token from URL and bootstraps the session', async ({ page }) => {
  await page.route('**/api/v1/auth/email-verifications', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: 'x'.repeat(32) });
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'Set-Cookie': '__Host-session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax' },
      json: {
        accountId: '0198a8e7-5132-7c8b-a566-0242ac120002',
        accountState: 'active',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        id: '0198a8e7-5132-7c8b-a566-0242ac120002',
        formalRole: 'student',
        systemRole: 'user',
        state: 'active',
        emailVerified: true,
        capabilities: ['profile.read'],
        createdAt: new Date().toISOString(),
      },
    });
  });

  await page.goto(`/verify-email?token=${'x'.repeat(32)}`);
  await expect(page).toHaveURL(/\/verify-email$/u);
  await expect(page.getByRole('status')).toContainText('Аккаунт активирован');
});

test('completes registration through the real API, worker, Mailpit and session bootstrap', async ({
  page,
  request,
}, testInfo) => {
  const email = `e2e-${testInfo.project.name}-${Date.now()}@mpei.ru`;
  const mailpitUrl = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';

  await page.goto('/registration');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill('very-long-password');
  await page.getByLabel('ФИО').fill('Иван Иванов');
  await page.getByLabel('Специализация').fill('Энергетика');
  await page.getByLabel('Институт').fill('ИЭТ');
  await page.getByLabel('Курс').selectOption('2');
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/registration\/check-email$/u);

  let verificationUrl = '';
  await expect
    .poll(
      async () => {
        const response = await request.get(`${mailpitUrl}/api/v1/messages?limit=50`);
        const body = (await response.json()) as {
          messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
        };
        const summary = body.messages.find((message) =>
          message.To.some((recipient) => recipient.Address === email),
        );
        if (!summary) return false;
        const message = await request.get(`${mailpitUrl}/api/v1/message/${summary.ID}`);
        const detail = (await message.json()) as { Text: string };
        verificationUrl = detail.Text.match(/https?:\/\/\S+/u)?.[0]?.trim() ?? '';
        return verificationUrl.length > 0;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto(verificationUrl);
    await expect(page).toHaveURL(/\/verify-email$/u);
    const message = page.getByRole('status');
    await expect(message).not.toContainText('Проверяем ссылку', { timeout: 10_000 });
    if ((await message.textContent())?.includes('Аккаунт активирован')) break;
    await page.waitForTimeout(500);
  }
  await expect(page.getByRole('status')).toContainText('Аккаунт активирован');
  const currentAccount = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me');
    return { status: response.status, body: await response.json() };
  });
  expect(currentAccount).toMatchObject({
    status: 200,
    body: { state: 'active', emailVerified: true },
  });
});

test('discloses the exact public-profile fields before consent', async ({ page }) => {
  await page.goto('/legal/public_profile_distribution');
  await expect(page.locator('article')).toContainText('основное резюме');
  await expect(page.locator('article')).toContainText(
    'Электронная почта, пароль и переписка не входят в публичный профиль',
  );
});
