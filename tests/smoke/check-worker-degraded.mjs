const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const response = await fetch(`${baseUrl}/health/ready`);
const body = await response.json();

if (!response.ok || body.status !== 'degraded' || body.dependencies?.worker?.status !== 'down') {
  throw new Error(`Ожидалась деградация worker, получено: ${JSON.stringify(body)}.`);
}

process.stdout.write('API остаётся runnable без worker.\n');
