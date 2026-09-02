const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';

const [page, readiness] = await Promise.all([
  fetch(baseUrl),
  fetch(`${baseUrl}/health/ready`, {
    headers: { 'X-Request-Id': '018f47a8-7b8c-7c14-a9cc-0242ac120002' },
  }),
]);

if (!page.ok || !(await page.text()).includes('Команда.МЭИ')) {
  throw new Error('Web shell не отвечает или не содержит название сервиса.');
}

if (!readiness.ok) {
  throw new Error(`Readiness вернул HTTP ${readiness.status}.`);
}

const body = await readiness.json();
if (!['ready', 'degraded'].includes(body.status)) {
  throw new Error(`Неожиданный readiness status: ${String(body.status)}.`);
}

if (readiness.headers.get('x-request-id') !== '018f47a8-7b8c-7c14-a9cc-0242ac120002') {
  throw new Error('X-Request-Id не был передан через reverse proxy.');
}

process.stdout.write(`Stack доступен: ${body.status}.\n`);
