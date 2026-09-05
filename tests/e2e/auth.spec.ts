import { expect, test, type APIRequestContext } from '@playwright/test';

test.use({ trace: 'off' });
const password = 'test-auth-original-password';
const mailpit = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';

async function mailLink(request: APIRequestContext, email: string, path: string) {
  let url = '';
  await expect
    .poll(
      async () => {
        const listing = await request.get(`${mailpit}/api/v1/messages?limit=100`);
        const messages = (await listing.json()) as {
          messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
        };
        for (const message of messages.messages.filter((item) =>
          item.To.some((recipient) => recipient.Address === email),
        )) {
          const detail = (await (
            await request.get(`${mailpit}/api/v1/message/${message.ID}`)
          ).json()) as { Text: string };
          const candidate = detail.Text.match(/https?:\/\/\S+/u)?.[0] ?? '';
          if (candidate.includes(path)) {
            url = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 25_000 },
    )
    .toBe(true);
  return url;
}

async function registerAccount(request: APIRequestContext, email: string) {
  const result = await request.post('/api/v1/auth/registrations', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {
      email,
      password,
      formalRole: 'student',
      profile: {
        fullName: 'Анна Тестовая',
        specialization: 'Энергетика',
        timezone: 'Europe/Moscow',
        institute: 'ИЭТ',
        course: 2,
      },
      consents: ['age_18', 'user_terms', 'personal_data', 'public_profile_distribution'].map(
        (documentType) => ({ documentType, documentVersion: 'local-v1', accepted: true }),
      ),
    },
  });
  expect(result.status()).toBe(201);
}

test('real login/logout/reset revokes another browser session and protects server routes', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const email = `auth-${testInfo.project.name}-${Date.now()}@mpei.ru`;
  await registerAccount(request, email);
  const verificationUrl = await mailLink(request, email, '/verify-email');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto(verificationUrl);
    await expect(page.getByRole('status')).not.toContainText('Проверяем ссылку', {
      timeout: 10_000,
    });
    if ((await page.getByRole('status').textContent())?.includes('Аккаунт активирован')) break;
    await page.waitForTimeout(500);
  }
  await page.goto('/account');
  await expect(page.getByText('Вы вошли в аккаунт.')).toBeVisible();
  const tab = await page.context().newPage();
  await tab.goto('/account');
  await expect(tab.getByText('Вы вошли в аккаунт.')).toBeVisible();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(tab.getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
  await tab.reload();
  await expect(tab).toHaveURL(/\/login\?returnTo=/u);
  await tab.close();
  await page.goto('/login?returnTo=/account');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/u);
  const oldCookies = await page.context().cookies();

  const other = await browser.newContext({
    baseURL: testInfo.project.use.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080',
  });
  try {
    const resetPage = await other.newPage();
    await resetPage.goto('/forgot-password');
    await resetPage.getByLabel('Электронная почта').fill(email);
    await resetPage.getByRole('button', { name: 'Отправить письмо' }).click();
    await expect(resetPage.getByRole('status')).toContainText('Если восстановление доступно');
    const resetUrl = await mailLink(request, email, '/reset-password');
    await resetPage.goto(resetUrl);
    await expect(resetPage).toHaveURL(/\/reset-password$/u);
    await resetPage
      .getByLabel('Новый пароль', { exact: true })
      .fill('test-auth-replacement-password');
    await resetPage.getByRole('button', { name: 'Сохранить пароль' }).click();
    await expect(resetPage).toHaveURL(/\/login\?reset=success$/u);
    await expect(resetPage.getByRole('status')).toContainText('Пароль изменён');
    const rejected = await request.get('/api/v1/me', {
      headers: { Cookie: oldCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
    });
    expect(rejected.status()).toBe(401);
    await page.reload();
    await expect(page).toHaveURL(/\/login\?returnTo=/u);
    await resetPage.getByLabel('Электронная почта').fill(email);
    await resetPage.getByLabel('Пароль', { exact: true }).fill(password);
    await resetPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(resetPage.getByRole('alert')).toContainText('Неверная почта или пароль');
    await resetPage.getByLabel('Пароль', { exact: true }).fill('test-auth-replacement-password');
    await resetPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(resetPage).toHaveURL(/\/$/u);
    await expect(resetPage.getByText('Вы вошли в аккаунт.')).toBeVisible();
  } finally {
    await other.close();
  }
});

test('unverified login remains limited and reset errors are actionable', async ({
  page,
  request,
}, testInfo) => {
  const email = `unverified-${testInfo.project.name}-${Date.now()}@mpei.ru`;
  await registerAccount(request, email);
  await page.goto('/login?returnTo=//attacker.invalid');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(
    page.getByText('Подтвердите электронную почту. Доступ пока ограничен.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Отправить письмо подтверждения' })).toBeVisible();
  await page.goto(`/reset-password?token=${'x'.repeat(43)}`);
  await page.getByLabel('Новый пароль', { exact: true }).fill('test-auth-new-password');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна');
});

for (const width of [360, 1280]) {
  test(`auth forms support keyboard and ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login');
    await page.getByLabel('Электронная почта').focus();
    await page.keyboard.type('unknown@mpei.ru');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Пароль', { exact: true })).toBeFocused();
    await page.keyboard.type('invalid-password');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Неверная почта или пароль');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/auth-login-${width}.png` });
    for (const path of ['/forgot-password', '/reset-password']) {
      await page.goto(path);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect(
        page.getByRole('button', {
          name: path === '/forgot-password' ? 'Отправить письмо' : 'Сохранить пароль',
        }),
      ).toBeVisible();
    }
  });
}
