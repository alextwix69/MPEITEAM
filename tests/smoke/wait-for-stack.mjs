const url = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const deadline = Date.now() + 180_000;

while (Date.now() < deadline) {
  try {
    const response = await fetch(`${url}/health/live`);
    if (response.ok) {
      process.stdout.write('Stack отвечает.\n');
      process.exit(0);
    }
  } catch {
    // Containers can reset connections while services are starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error(`Stack не стал доступен за 180 секунд: ${url}.`);
