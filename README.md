# Команда.МЭИ

Application foundation сервиса проектных команд МЭИ. Текущий runnable slice содержит русскоязычный web shell, API/worker process roles, health/degraded состояния и локальные PostgreSQL, Redis и S3-compatible storage. Бизнес-функции и endpoints из `api/openapi.yaml` пока не реализованы.

## Требования

- Node.js 24.x;
- pnpm 11.19 через Corepack (`corepack enable`);
- Docker Desktop с Docker Compose 5.x;
- свободный порт `8080`; локальные data-порты `55432`, `6379`, `9000` и `9001` привязываются только к `127.0.0.1`.

## Локальный запуск

Из корня fresh clone выполните одну команду:

```powershell
pnpm local:up
```

Команда устанавливает зависимости по frozen lockfile, собирает production artifacts и запускает PostgreSQL, Redis, MinIO, migration, NestJS API, NestJS worker, Next.js web и Nginx. После появления healthy-состояния откройте <http://localhost:8080>.

Остановка без удаления development data:

```powershell
pnpm stack:down
```

Полное удаление локальных volumes при намеренном сбросе данных:

```powershell
docker compose down --volumes
```

## Runtime и health

- `GET http://localhost:8080/health/live` возвращает `200`, пока event loop API отвечает. Внешние зависимости не проверяются.
- `GET http://localhost:8080/health/ready` возвращает snapshot без hosts и credentials.
- Недоступный PostgreSQL даёт `503` и `status: unavailable`, но не ломает liveness.
- Недоступный Redis, MinIO или просроченный worker heartbeat даёт `200` и `status: degraded`.
- `/api/*` и `/health/*` идут в API через тот же origin, что и web. `/socket.io/*` только зарезервирован; realtime gateway не реализован.

Проверка деградации без worker:

```powershell
docker compose stop worker
Start-Sleep -Seconds 17
pnpm smoke:degraded
docker compose start worker
```

Web и API должны остаться доступными, а главная страница — показать «Сервис работает с ограничениями».

## Разработка и проверки

Основные quality gates:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm openapi:lint
pnpm openapi:check
pnpm build
```

Integration tests используют отдельную базу `komanda_test` и не изменяют development database:

```powershell
pnpm infra:up
pnpm test:integration
pnpm infra:down
```

Smoke и браузерные проверки выполняются на поднятом полном stack:

```powershell
pnpm smoke
pnpm exec playwright install chromium
pnpm test:e2e
```

`api/openapi.yaml` — source of truth для будущего business REST API `/api/v1`. Generated type-only client находится в `frontend/src/lib/api/generated.ts`, не редактируется вручную и обновляется командой:

```powershell
pnpm openapi:generate
```

Health endpoints намеренно не входят в business OpenAPI contract и используют отдельный Zod-validated client.

## Структура

- `backend/src/api/main.ts` — NestJS API process entrypoint;
- `backend/src/worker/main.ts` — отдельный NestJS worker process entrypoint;
- `backend/src/modules/` — public shells 13 bounded contexts;
- `backend/prisma/` — Prisma schema и migration history;
- `frontend/src/app/` — Next.js App Router shell;
- `infra/` — production Dockerfiles, Nginx и local database initialization;
- `tests/` — architecture, smoke и Playwright tests.

## Конфигурация и безопасность

Полный перечень runtime variables и безопасные локальные примеры находятся в `.env.example`. Runtime валидирует обязательные значения до bind/listen. API и worker имеют отдельные database URLs и pool limits. Не коммитьте `.env`, credentials или production URLs.

Structured JSON logs содержат process role, operation/result/latency и request/correlation ID. Request bodies, credentials и connection URLs не должны попадать в telemetry. OpenTelemetry hooks по умолчанию используют no-op provider и ничего не отправляют наружу.

## Troubleshooting

- Если `pnpm install` сообщает об ignored build scripts, убедитесь, что используется pnpm 11.19 и актуальный `pnpm-workspace.yaml`; разрешены только зафиксированные toolchain dependencies.
- Если Docker BuildKit сообщает `x-docker-expose-session-sharedkey contains value with non-printable ASCII characters`, откройте репозиторий из пути без кириллицы. Временный вариант для PowerShell: `subst Z: '<полный путь к репозиторию>'`, затем выполнить команды из `Z:\` и удалить mapping командой `subst Z: /D` после остановки stack.
- Если migration не стартует, проверьте `docker compose ps postgres` и отсутствие другого процесса на `127.0.0.1:55432`. Порт можно переопределить через `POSTGRES_HOST_PORT` вместе с `TEST_DATABASE_URL`.
- Если UI не получает health, проверьте `docker compose ps api web proxy` и `docker compose logs api proxy`; обращаться к container-порту API из браузера не нужно.
- Если readiness остаётся degraded после запуска worker, подождите один heartbeat interval (до 5 секунд) и нажмите «Повторить».
- Повторный запуск не требует удаления volumes: migration использует `IF NOT EXISTS`, а Prisma deploy применяет только отсутствующую историю.
