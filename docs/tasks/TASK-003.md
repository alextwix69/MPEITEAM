TASK-003

Статус: реализована; локальные acceptance gates, container verification и degraded smoke завершены 2026-09-03.

Источник: этап 0 «Запускаемый application shell и проверяемый контракт» из `docs/plans/implementation-plan.md`.

# Goal

Создать первый запускаемый вертикальный slice проекта: русскоязычный Next.js web shell через same-origin reverse proxy получает состояние NestJS API, а отдельный NestJS worker и API подключаются к локальным PostgreSQL, Redis и S3-compatible storage. Fresh clone должен собираться, проверяться CI и запускаться одной документированной командой без реализации бизнес-функций.

Результат задачи — воспроизводимый application foundation, на котором можно независимо начинать TASK по регистрации. Это не задача на создание всего database layer, backend или frontend: пользовательски наблюдаемый результат ограничен запускаемым shell, health/degraded состояниями и проверяемым OpenAPI-контрактом.

# Context

- Следующий не реализованный шаг — этап 0, строки 24—66 `docs/plans/implementation-plan.md`. Более поздние этапы зависят от его Definition of Done.
- Репозиторий сейчас является документационным каркасом. `README.md` прямо называет его каркасом.
- На диске существуют пустые каталоги `backend/`, `frontend/`, `infra/`, `tests/`; Git не отслеживает пустые каталоги.
- В корне отсутствуют `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `pnpm-lock.yaml`, `docker-compose.yml`, `.env.example` и `.github/workflows/`.
- В репозитории нет TypeScript/JavaScript source files, Prisma schema/migrations, Dockerfiles, тестов, CI-конфигурации, классов, интерфейсов или функций приложения.
- Существующий browser contract — `api/openapi.yaml`, OpenAPI 3.1.0, `info.version: 1.0.0`, base URL `/api/v1`. Он уже описывает полный MVP и не означает, что endpoints реализованы.
- Существующие `docs/tasks/TASK-001.md` и `docs/tasks/TASK-002.md` имеют статус «не запланирована» и содержат только TODO. Они не изменяются этой задачей. `TASK-003` выбран как следующий свободный номер файла.
- `.gitignore` уже исключает `.env*`, кроме `.env.example`, зависимости, build output, coverage и logs. Его нужно расширять только при появлении нового реально генерируемого output.

# Relevant requirements

## Implementation plan

- Этап 0 требует pnpm/Turborepo, TypeScript strict, Next.js web, NestJS `api`/`worker`, локальные PostgreSQL/Redis/MinIO, health/readiness, structured logging, correlation, OpenAPI generation/checks, CI и runnable state при отключённом worker.
- После этапа незавершённые business routes не должны присутствовать в пользовательской навигации.

## Product and technical NFR

- `TNFR-005`: процессы должны быть stateless и допускать несколько экземпляров без sticky session; sessions/jobs/media нельзя хранить только в памяти процесса.
- `TNFR-012`: structured logs с request ID, базовые metrics/health hooks и отсутствие запрещённых данных в telemetry.
- `TNFR-013`: воспроизводимый pipeline и обратно совместимые migrations по `expand/migrate/contract`.
- `TNFR-014`, `NFR-013—NFR-015`: shell работает с клавиатуры на 360 px и 1280 px и ориентирован на заявленный browser matrix.
- `NFR-012`: ошибки на русском языке и подсказывают следующее действие.
- `NFR-023`: UI MVP на русском языке.

## Accepted architecture

- ADR-001: Next.js App Router, React, TypeScript strict, TanStack Query, React Hook Form, Zod, Tailwind CSS и shadcn/ui; без BFF, GraphQL и Redux.
- ADR-002: PostgreSQL — единственная business database; Prisma — основной ORM; schemas принадлежат bounded contexts.
- ADR-004: API и worker — отдельные process roles одного release artifact; Redis/BullMQ не является source of truth.
- ADR-008 и ADR-015: REST `/api/v1` и `api/openapi.yaml` — source of truth; изменения additive-only; generated client обязан компилироваться.
- ADR-009 и ADR-010: один NestJS modular monolith, Zod как основной runtime validator, pragmatic flow `controller -> application service -> domain rules / Prisma`, запрет прямых межмодульных repositories/SQL.
- ADR-013: immutable Docker artifacts, stateless processes, managed PostgreSQL/Redis/S3 в production, без Kubernetes.
- ADR-014: correlation chain `requestId -> correlationId -> eventId`, structured JSON logs и OpenTelemetry-ready instrumentation.
- `docs/architecture/system-design.md` перечисляет bounded contexts: `Identity`, `Catalog`, `Profiles`, `Opportunities`, `Recruitment`, `Teams`, `Scheduling`, `Messaging`, `Trust`, `Notifications`, `Files`, `Search`, `Compliance`.

# Existing code

При инвентаризации application code не найден. Поэтому в этой секции намеренно не перечисляются несуществующие controllers, services, React components, Prisma models, interfaces или functions.

Реально найдены только следующие implementation-adjacent artifacts:

- `api/openapi.yaml` — декларативный browser REST contract. Существующие interface facts: OpenAPI `3.1.0`, server `/api/v1`, cookie-session security scheme и 14 domain tags. Health endpoints в `paths` отсутствуют.
- `docs/architecture/api-contracts.md` — error envelope `application/problem+json`, `X-Request-Id`, additive compatibility, cursor/idempotency/concurrency conventions.
- `docs/architecture/system-design.md` — процессы `api` и `worker`, module ownership, same-origin routing и health semantics.
- `docs/architecture/data-model.md` — целевые schemas и migration rules; ни одна описанная таблица ещё не реализована.
- `README.md` — только краткое описание документационного каркаса; команды запуска отсутствуют.
- `.gitignore` — готовые правила для env secrets, Node build output, coverage и logs.
- `.continue/agents/new-config.yaml` — пример конфигурации Continue, не относится к runtime проекта и не должен изменяться.

# Files likely affected

## Существующие файлы, которые должны быть изменены

- `README.md` — добавить prerequisites, единственную команду локального запуска, команды quality gates, troubleshooting и описание health/degraded states.
- `.gitignore` — изменять только если выбранные инструменты создают новый локальный output, ещё не покрытый текущими правилами.
- `api/openapi.yaml` — использовать как вход генерации и lint; не добавлять сюда health endpoints, потому что этап 0 размещает их вне browser business API.

## Существующие пустые каталоги, которые должны быть наполнены

- `backend/` — единый NestJS codebase с двумя entrypoints и Prisma migrations.
- `frontend/` — одно Next.js App Router приложение.
- `infra/` — Dockerfiles, reverse-proxy и локальная инфраструктура.
- `tests/` — cross-package smoke, architecture и Playwright tests.

## Целевые новые файлы

Эти файлы сейчас отсутствуют; список задаёт ожидаемую структуру, а не описывает существующий код:

- root: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `.env.example`, `docker-compose.yml`;
- CI: `.github/workflows/ci.yml`;
- backend: `backend/package.json`, `backend/tsconfig.json`, `backend/src/api/main.ts`, `backend/src/worker/main.ts`, `backend/src/app.module.ts`, `backend/src/platform/`, `backend/src/modules/`, `backend/prisma/schema.prisma`, `backend/prisma/migrations/`;
- frontend: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/next.config.*`, `frontend/src/app/layout.tsx`, `frontend/src/app/page.tsx`, `frontend/src/app/error.tsx`, `frontend/src/app/providers.tsx`, `frontend/src/lib/api/`;
- infra: `infra/docker/`, `infra/nginx/`;
- tests: `tests/smoke/`, `tests/architecture/`, `tests/e2e/`.

Если scaffold выбранной версии framework создаёт другое стандартное имя файла, использовать его и отразить фактическую структуру в `README.md`; не создавать дублирующие конфигурации только ради этого списка.

# API changes

- Не менять семантику и schemas существующих 79 business paths из `api/openapi.yaml`; их реализация вне scope.
- Добавить новые служебные endpoints вне `/api/v1` и не включать их в browser contract:
  - `GET /health/live` — `200`, если event loop API отвечает; не проверяет PostgreSQL/Redis/S3 и не вызывает restart storm при их временном сбое;
  - `GET /health/ready` — dependency snapshot. PostgreSQL недоступен: `503`. Redis, S3 или worker heartbeat недоступны/просрочены: вернуть `200` с явным `degraded` component status согласно частичной деградации, не выдавая secrets/hosts.
- Reverse proxy должен направлять `/` в Next.js, `/api/*` в NestJS API и `/health/*` в API на same origin. `/socket.io` можно зарезервировать в конфигурации, но realtime gateway в этой задаче не реализуется.
- API всегда принимает валидный UUID из `X-Request-Id` либо генерирует UUIDv7 и возвращает итоговый `X-Request-Id`; невалидное входное значение не должно попадать в logs как trusted identifier.
- Подключить OpenAPI lint/parse, проверку уникальности всех существующих `operationId`, генерацию TypeScript client и compile check. Generated files должны иметь один документированный source/command и не редактироваться вручную.
- Общий будущий business error envelope должен соответствовать `docs/architecture/api-contracts.md`: stable `code`, русское `message`, `requestId`, безопасные optional `details`/`fieldErrors`. На этапе 0 его проверить тестовым non-business error path или unit test, не добавляя фиктивный `/api/v1` endpoint.

# Database changes

- Добавить PostgreSQL в `docker-compose.yml` и отдельную test database/connection, не переиспользовать development data в integration tests.
- Создать Prisma datasource/generator и первую воспроизводимую migration, которая:
  - включает `pg_trgm`;
  - создаёт schemas для утверждённых bounded contexts и `platform`;
  - не создаёт предметные tables, JSON placeholders или speculative indexes.
- Migration history должна применяться командой workspace и через CI с чистой базы. Prisma `_prisma_migrations` — допустимая tool-owned metadata; отдельную пользовательскую migration-ledger table не создавать.
- API и worker используют раздельные connection pool settings из validated env. Credentials не коммитятся.
- Redis и MinIO входят в local runtime, но не являются business database и не хранят подтверждённое business state.
- Worker записывает в Redis только короткоживущий operational heartbeat с TTL; это не job state и не source of truth. PostgreSQL table для heartbeat не создавать.

# Backend changes

- Создать один NestJS backend package и два process entrypoints `api` и `worker`; не создавать отдельные domain services или deployable repositories.
- Добавить Zod-based environment validation до старта процесса. `.env.example` должен перечислять только имена и безопасные примеры: API/web ports, PostgreSQL URLs для dev/test, Redis URL, S3 endpoint/bucket/access identifiers и log/telemetry settings.
- Ввести технические primitives только для configuration, UUIDv7, clock, request/correlation context, error mapping, structured logging, health checks и graceful shutdown.
- Structured JSON logs должны содержать `requestId`, `correlationId`, process role, module/operation, result и latency; не логировать raw env, credentials, request bodies или connection URLs.
- Создать пустые module boundaries для 13 bounded contexts, перечисленных в system design. Каждый модуль экспортирует только public `index.ts`; никаких repositories, domain entities или CRUD stubs без use case не создавать.
- Настроить automated boundary rule: запрещены import чужого `infrastructure`, Prisma/repository другого модуля, циклы и прямой provider SDK из будущих application/domain layers.
- API startup проверяет обязательную конфигурацию, применённость migrations и подключения, но внешние dependency probes не должны превращать liveness в readiness.
- Worker стартует отдельной командой, подключается к PostgreSQL/Redis/S3, обновляет TTL heartbeat для API readiness, сообщает structured readiness/degraded state и корректно завершает соединения по SIGTERM/SIGINT. BullMQ queues/consumers и outbox ещё не создавать.
- Подготовить OpenTelemetry-compatible bootstrap hooks без выбора production vendor и без отправки telemetry во внешний сервис по умолчанию.

# Frontend changes

- Создать Next.js App Router shell с TypeScript strict, Tailwind CSS и shadcn/ui base; установить TanStack Query, React Hook Form и Zod как принятый stack, не добавляя Redux или BFF.
- Root layout содержит русский `lang`, skip link, семантический `main`, видимый focus и минимальную адаптивную структуру.
- Главная страница показывает название сервиса и полученный через same-origin `/health/ready` статус: «Сервис готов», «Сервис работает с ограничениями» либо понятную ошибку с действием «Повторить».
- Server Components не содержат business rules. Health server state проходит через единый API client/TanStack Query boundary; network state не дублируется в global store.
- Не создавать ссылки, страницы или mock data для auth, profiles, search, opportunities и остальных ещё не реализованных features.
- Generated client из `api/openapi.yaml` должен компилироваться отдельно от health client. Для будущих response enums предусмотреть единый документированный decode/fallback pattern, не придумывая domain-specific UI до появления соответствующего slice.

# Edge cases

- Worker остановлен: web и API продолжают запускаться; UI/health явно показывает degraded background processing и не показывает ложную полную готовность.
- PostgreSQL недоступен: liveness остаётся `200`, readiness становится `503`; process не входит в бесконечный restart loop.
- Redis или MinIO недоступны: component status явно degraded; нет silent success и утечки connection details.
- API недоступен или health timeout: web shell показывает русскую recoverable error state, а не пустой экран.
- Невалидный/отсутствующий `X-Request-Id`: сервер генерирует безопасный UUIDv7; header согласован с log context.
- Не хватает обязательной env variable: соответствующий process завершается до bind/listen с sanitised сообщением и non-zero exit code.
- Повторный local start не требует ручного удаления volumes; migration повторяема.
- OpenAPI содержит duplicate `operationId`, невалидную ссылку или generated client не компилируется: CI падает.
- Unknown response enum в будущей generated model не приводит к unhandled render error; fallback pattern проверен независимо от business screen.
- Reverse proxy не должен раскрывать PostgreSQL, Redis, MinIO admin/API ports наружу за пределами local development network.
- Graceful shutdown во время health request закрывает HTTP server и data clients в bounded time.

# Tests

## Unit

- Zod env validation: обязательные, неверные и неизвестные значения; ошибки не содержат secrets.
- Request/correlation ID: принятие валидного UUID, UUIDv7 generation, propagation в response/log context.
- Error envelope: stable code, русское message, requestId, redaction.
- Frontend health-state mapping, retry action и unknown-enum fallback helper/pattern.

## Integration

- `GET /health/live` не зависит от PostgreSQL/Redis/S3.
- `GET /health/ready` различает ready, degraded Redis/S3/worker heartbeat и unavailable PostgreSQL без раскрытия конфигурации.
- Prisma migration применяется с пустой БД, повторный deploy не меняет schema, `pg_trgm` доступен, business tables отсутствуют.
- API и worker используют независимые pool settings и корректно закрывают clients.

## Contract and architecture

- `api/openapi.yaml` проходит OpenAPI 3.1 lint/parse; все `operationId` уникальны.
- Generated TypeScript client компилируется в strict mode; diff generated artifacts детерминирован.
- Dependency rule ломает test fixture с импортом `modules/<other>/infrastructure` и разрешает импорт из public `index.ts`.
- Ни один module shell не содержит ORM models, repositories или business stub.

## Smoke and E2E

- Одна документированная команда поднимает PostgreSQL, Redis, MinIO, reverse proxy, API, worker и web; web через same origin показывает готовый статус.
- Playwright проверяет 360 px и 1280 px, русский текст, skip link/focus, keyboard retry и понятную ошибку при отключённом API.
- Отдельный smoke отключает worker и подтверждает runnable/degraded состояние web/API.
- Production builds web/API/worker запускаются из собранных artifacts, а не через dev server.

## CI

- Fresh runner выполняет install с frozen lockfile, format/lint, typecheck, unit/integration/architecture/API/Playwright smoke, OpenAPI generation/compile, builds и dependency/secrets scan.
- CI не требует committed secrets и не обращается к production services.

# Acceptance criteria

- [x] `docs/plans/implementation-plan.md` этап 0 выполнен без реализации scope этапа 1.
- [x] Fresh clone с установленными prerequisites запускается одной командой, указанной в `README.md`; ручное создание database/bucket/schema не требуется.
- [x] `frontend`, NestJS `api` и NestJS `worker` собираются и запускаются как три отдельные process roles из одного workspace/release.
- [x] Локальные PostgreSQL, Redis и MinIO поднимаются Compose; development и test PostgreSQL логически разделены.
- [x] `GET /health/live` и `GET /health/ready` имеют тестируемую liveness/readiness semantics; PostgreSQL failure не вызывает restart storm.
- [x] При остановленном worker web/API остаются runnable и показывают корректное degraded состояние.
- [x] Web shell использует same-origin reverse proxy, русский UI, 360/1280 layout, keyboard focus и не показывает незавершённые features.
- [x] `api/openapi.yaml` не получил breaking/business changes, lint проходит, все `operationId` уникальны, generated strict TypeScript client компилируется.
- [x] Первая migration воспроизводимо включает `pg_trgm` и schemas, не создавая business tables/speculative indexes.
- [x] Structured logs и HTTP response связываются итоговым `X-Request-Id`; secrets, connection URLs и PII отсутствуют в test-captured logs.
- [x] Architecture tests защищают module public boundaries и запрещают direct cross-module infrastructure/repository imports.
- [x] `pnpm` quality commands и CI pipeline проходят на чистом runner; lockfile зафиксирован.
- [x] `.env.example` полон и не содержит настоящих credentials; production code не зависит от `.continue/agents/new-config.yaml`.
- [x] `git diff --check` не сообщает whitespace errors, а README содержит запуск, тестирование и troubleshooting.

# Out of scope

- Регистрация, credentials, sessions, consent и любые Identity business tables/endpoints.
- Реализация любого из 79 business paths `api/openapi.yaml`.
- Transactional outbox, inbox, BullMQ queues/consumers, email, notifications и provider adapters.
- Socket.IO gateway, rooms и realtime events; допускается только route reservation reverse proxy.
- Media upload/processing, moderation, search, messaging и другие domain flows.
- Business Prisma models, seed data и демонстрационные пользователи.
- Production provider provisioning, two-failure-domain rollout, cold DR, backup/restore rehearsal и production dashboards; здесь нужны только локальный runtime и instrumentation hooks.
- Kubernetes, Kafka/RabbitMQ, Elasticsearch/OpenSearch, Keycloak/SSO, GraphQL, BFF и Redux.
- Изменение `TASK-001.md`, `TASK-002.md`, ADR или product/architecture requirements без обнаруженного конфликта.

# Risks

- Полный `api/openapi.yaml` генерирует большой client до реализации endpoints; важно не принять compile success за runtime readiness и не показывать эти functions в UI.
- Одновременный scaffold всех module shells может породить фиктивные abstractions. Ограничить их public boundaries и пустой composition metadata.
- Health probe легко сделать слишком строгим: liveness, readiness и degraded component status должны оставаться разными сигналами.
- Prisma multi-schema/extension setup зависит от выбранной версии Prisma/PostgreSQL; migration нужно проверить на чистой и уже мигрированной БД.
- Next.js/NestJS/Turborepo версии могут иметь несовместимые Node/pnpm требования. Версии и runtime должны быть зафиксированы в root manifest/README/CI.
- Generated-code strategy может создавать nondeterministic diffs. Генератор и команда должны быть pinned, output — либо committed и проверяем, либо всегда generated before build; выбрать один вариант и документировать.
- Локальный reverse proxy и Compose могут случайно опубликовать data-service ports. Defaults должны быть безопасны, а production networking не имитироваться небезопасными public binds.
- Преждевременная observability integration может отправить локальные данные наружу. По умолчанию использовать no-op/local exporters и sanitised structured logs.

# Implementation checkpoint

## Уже сделано

- Полностью реализован этап 0: pnpm/Turborepo workspace, NestJS API/worker, Next.js shell, Prisma foundation migration, Redis heartbeat, MinIO, Nginx same-origin proxy, structured logging/correlation и health semantics.
- Docker images `api`, `worker`, `migrate` и `web` собраны production Dockerfiles. BuildKit cache сохраняет pnpm store, а frozen lockfile повторно не обращается к registry для supply-chain metadata.
- Backend images содержат OpenSSL, Prisma Client генерируется для фактического runtime ABI без fallback warning.
- Migration container запускает установленный Prisma CLI напрямую, не выполняет runtime install и повторно завершается с кодом 0 при отсутствии pending migrations.
- Полный `docker compose up -d --wait --no-build` завершён успешно; PostgreSQL, Redis, MinIO, API, web, proxy и worker получили ожидаемые состояния.
- Пройдены formatter/format check, ESLint, strict typecheck, 22 unit/architecture tests, 9 integration tests, OpenAPI lint/parse с 101 уникальным `operationId`, generated-client check, production builds, stack smoke и 4 Playwright tests.
- После остановки worker и истечения TTL degraded smoke подтвердил, что API/web остаются runnable; после возврата worker stack снова вернул `ready`.
- `git diff --check` завершён без whitespace errors. Docker BuildKit workaround для Unicode-пути добавлен в README.

## Осталось

- Для TASK-003 обязательных работ не осталось.
- Hosted GitHub Actions не запускался из локального окружения; его jobs воспроизводят успешно выполненные локальные команды и должны быть подтверждены после публикации ветки.

## Точная точка продолжения

Не начинать следующий slice автоматически. По отдельному запросу создать или реализовать инженерную задачу для этапа 1 «Регистрация, согласия и подтверждение email end-to-end» из `docs/plans/implementation-plan.md`.
