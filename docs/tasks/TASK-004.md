# TASK-004: Регистрация, согласия и подтверждение email end-to-end

Статус: реализована; unit/integration/Playwright, OpenAPI, build, container journey и degraded smoke завершены 2026-09-04.

Источник: этап 1 «Регистрация, согласия и подтверждение email end-to-end» из `docs/plans/implementation-plan.md`.

# Goal

Реализовать первый бизнесовый вертикальный slice после application shell: пользователь 18+ регистрирует аккаунт с одной формальной ролью, role-shaped данными профиля и четырьмя отдельными актуальными согласиями, получает сервисное письмо, подтверждает email одноразовым token и становится `active` только после фиксации минимального доказательства согласий в изолированной legal database.

Slice должен проходить через русский Next.js UI, REST `/api/v1`, модули `Identity` и `Profiles`, PostgreSQL-транзакцию, transactional outbox, worker, `EmailSender` port и legal-evidence consumer. Повторы запросов и доставки не создают аккаунты, профили, основные резюме, письма или доказательства повторно. Недоступность Redis, email provider или legal database не должна приводить к ложной активации либо потере подтверждённого состояния.

# Context

- Этап 0 реализован в `TASK-003`: в repository есть pnpm/Turborepo workspace, NestJS API и worker, Next.js shell, PostgreSQL/Redis/MinIO, health endpoints, OpenAPI generation/compatibility gates и CI.
- Следующий по обязательному порядку не реализованный шаг — этап 1. Business endpoints пока отсутствуют: `backend/src/modules/identity/index.ts` и `backend/src/modules/profiles/index.ts` содержат только `export {};`, а `AppModule.register()` подключает только `HealthModule`.
- `api/openapi.yaml` уже является source of truth и описывает операции `registerAccount`, `verifyEmail`, `resendEmailVerification` и `getCurrentAccount`; `frontend/src/lib/api/generated.ts` уже содержит сгенерированные типы этих операций и DTO.
- Текущая Prisma schema содержит только `generator` и один основной PostgreSQL datasource. Миграция `backend/prisma/migrations/20260901000100_platform_foundation/migration.sql` создаёт schemas и `pg_trgm`, но не создаёт business tables.
- Текущий worker (`WorkerService`) выполняет только dependency probes и Redis heartbeat. BullMQ, outbox dispatcher, delivery reconciliation, DLQ и email/legal consumers отсутствуют.
- В `backend/package.json` нет Argon2id- и BullMQ-зависимостей. `ioredis`, Prisma, Zod и UUIDv7 уже доступны.
- `frontend/src/app/page.tsx` и `HealthPanel` показывают только состояние application shell. Регистрационных routes, форм, навигации и auth bootstrap нет; `Providers` уже предоставляет общий `QueryClientProvider`, а `apiClient` использует base URL `/api/v1`.
- Утверждённые значения версий четырёх юридических документов и production email provider в repository не найдены. Реализация не должна подменять их случайными строками: локальный/test adapter допустим, а перечень актуальных document versions должен иметь явный конфигурируемый источник.
- Между документами есть две зависимости, которые нельзя разрешить неявно:
  - `POST /auth/email-verifications` по OpenAPI возвращает `SessionView` и создаёт/обновляет `__Host-session`, но `identity.sessions` перечислена в DB changes этапа 2;
  - `RegistrationRequest.profile` содержит фактические данные профиля, но root `profiles.profiles` не имеет полей для этих данных, а `profiles.profile_versions` отнесена планом к этапу 4.
  Для соблюдения текущего OpenAPI и исключения потери данных эта задача предполагает ранний минимальный expand `identity.sessions` и `profiles.profile_versions`. До начала реализации это уточнение необходимо отразить в `docs/plans/implementation-plan.md` либо оформить ADR, если команда выберет другое публичное поведение.

# Relevant requirements

- `FR-001`: возраст 18+, email/password и четыре отдельные непредустановленные отметки: `age_18`, `user_terms`, `personal_data`, `public_profile_distribution`.
- `FR-002`, `BR-001`, `EC-002`: `student` и `teacher` регистрируются только с нормализованным адресом в домене `mpei.ru`.
- `FR-003`, `BR-001`: `employer` может использовать любой корректный email.
- `FR-004`, `ERR-002`: отправить письмо подтверждения; истёкшая ссылка не активирует аккаунт, но пользователь может запросить новую.
- `FR-005`, `FR-152`, `NFR-001`: полный доступ появляется только после подтверждения email; `unverified` не получает active capabilities.
- `FR-008`, `BR-002`: у аккаунта ровно одна неизменяемая formal role `student | teacher | employer`; это не `system_role` и не permission.
- `FR-009`, `FR-010`, `EC-003`: второй аккаунт возможен с другим email; фактическая роль и принадлежность пользователя не проверяются.
- `FR-011`: будущий пользовательский контент доступен только вошедшим пользователям; гостевой доступ не появляется в этом slice.
- `FR-012`: при регистрации ровно один раз создаётся primary resume в slot `0`.
- `FR-153`, `FR-154`: обязательное согласие на распространение перечисляет публичные поля; email, password и переписка не входят в public profile.
- `FR-155`: только сервисные письма; рекламное согласие и маркетинговая рассылка запрещены.
- `EC-003a`, `EC-003b`, `ERR-003a`: без подтверждения возраста или любого обязательного согласия регистрация не завершается; принимаются только актуальные версии документов и доказуемые отдельные волеизъявления.
- `ERR-001`: ошибки регистрации понятны по-русски и не раскрывают лишнюю информацию.
- `NFR-006`, `TNFR-006`, ADR-004 и ADR-011: атомарный business commit, idempotency и transactional outbox; Redis и внешние providers не входят в предметную транзакцию.
- `NFR-011`, `NFR-022`, `TNFR-009`—`TNFR-011`, ADR-003 и ADR-012: Argon2id, hashed tokens/sessions, server-side guards, rate limits, отсутствие PII/secrets в telemetry и отдельная legal database с минимальными доказательствами.
- Общие правила implementation plan: additive-only OpenAPI, correlation chain `requestId -> correlationId -> eventId`, redaction, dashboard/alert и runbook для journey, expand/migrate/contract, unit/integration/API/Playwright и accessibility checks на 360 px и 1280 px.

# Existing code

- `backend/src/app.module.ts`: класс `AppModule` и `AppModule.register(probe)`; сейчас импортируется только `HealthModule.register(probe)`.
- `backend/src/api/app.ts`: интерфейс `ApiApplicationOptions` и функция `createApiApplication(environment, options)`; здесь уже подключены `requestContextMiddleware`, `ProblemDetailsFilter`, global prefix `api/v1` и shutdown hooks.
- `backend/src/api/main.ts`: `bootstrap()` валидирует API environment, создаёт `RuntimeDependencies`, проверяет зависимости и запускает приложение.
- `backend/src/platform/http/problem-details.ts`: интерфейс `ProblemDetails`, функции `createProblemDetails()` и `safeExceptionMetadata()`, фильтр `ProblemDetailsFilter`. Текущий filter сводит все обычные 4xx к `INVALID_REQUEST`; для этой задачи ему потребуется передавать документированные validation/business/idempotency/rate-limit коды и безопасные `fieldErrors`/`details`.
- `backend/src/platform/http/request-context.ts`: `RequestContextValue`, `getRequestContext()`, `resolveRequestId()` и `requestContextMiddleware()` уже обеспечивают request/correlation ID.
- `backend/src/platform/observability/json-logger.ts`: `JsonLogger` и `sanitizeLogMessage()` с redaction для password, token, authorization, cookie, secret и URL. Email, raw consent evidence, session/token hashes и profile body также не должны попадать в новые log attributes.
- `backend/src/platform/config/env.schema.ts`: `ApiEnvironment`, `WorkerEnvironment`, `RuntimeEnvironment`, `parseApiEnvironment()` и `parseWorkerEnvironment()`; конфигурации legal DB, HMAC, auth token/session TTL, current document versions, rate limit и email adapter пока нет.
- `backend/src/platform/health/runtime-dependencies.ts`: `RuntimeDependencies` владеет отдельными Prisma/Redis/S3 clients только для runtime checks и heartbeat. Его private Prisma client нельзя превращать в общий business repository.
- `backend/src/worker/worker.module.ts`: `WorkerModule.register(environment, runtime, logger)` регистрирует только `WorkerService` и platform tokens.
- `backend/src/worker/worker.service.ts`: `WorkerService` реализует `OnApplicationBootstrap`/`OnApplicationShutdown` и только обновляет heartbeat. Outbox processing следует добавить отдельными providers, сохранив bounded shutdown.
- `backend/src/modules/identity/index.ts`, `backend/src/modules/profiles/index.ts`, `backend/src/modules/compliance/index.ts`: существующие публичные entrypoints трёх затронутых bounded contexts; сейчас пусты.
- `tests/architecture/module-boundaries.ts`: `findBoundaryViolations()` запрещает provider SDK в `application`/`domain`, импорт внутренних слоёв другого модуля и циклы. Межмодульная регистрация должна использовать public exports из `index.ts`.
- `frontend/src/app/layout.tsx`: `RootLayout` уже задаёт `lang="ru"`, skip link и `main`.
- `frontend/src/app/providers.tsx`: `Providers` создаёт общий `QueryClient`.
- `frontend/src/lib/api/client.ts`: существующий `apiClient = createClient<paths>({ baseUrl: '/api/v1' })`.
- `frontend/src/lib/api/generated.ts`: реально существующие generated типы `ConsentAcceptance`, `RegistrationRequest`, `RegistrationResult`, `TokenRequest`, `EmailRequest`, `SessionView`, `CurrentAccount`, `ProfileInput`; файл не редактируется вручную.
- `api/openapi.yaml`: существующие operations `registerAccount`, `verifyEmail`, `resendEmailVerification`, `getCurrentAccount`; security scheme `CookieSession`; header `Idempotency-Key`; общий `ErrorEnvelope`.
- `backend/tests/integration/migration.test.ts` и `scripts/migrate-test-database.ts`: текущая проверка foundation migration на отдельной `komanda_test`; legal test database и business migration checks отсутствуют.
- `docker-compose.yml` и `infra/postgres/init-test-database.sql`: один PostgreSQL service и базы `komanda`/`komanda_test`; отдельные legal credentials/database и отдельный legal migration step отсутствуют.

# Files likely affected

Существующие файлы:

- `api/openapi.yaml` — менять только если найденная неоднозначность session/profile storage требует согласованного additive уточнения; после изменения обязательно перегенерировать client.
- `frontend/src/lib/api/generated.ts` — только generated output команды `pnpm openapi:generate`.
- `backend/src/app.module.ts`, `backend/src/api/app.ts`, `backend/src/api/main.ts` — подключение business modules, Prisma/session lifecycle и HTTP infrastructure.
- `backend/src/worker/worker.module.ts`, `backend/src/worker/worker.service.ts`, `backend/src/worker/main.ts` — подключение dispatcher/consumers без смешивания с heartbeat logic.
- `backend/src/modules/identity/index.ts`, `backend/src/modules/profiles/index.ts`, `backend/src/modules/compliance/index.ts` — публичные module contracts.
- `backend/src/platform/config/env.schema.ts`, `backend/src/platform/http/problem-details.ts`, `backend/src/platform/http/request-context.ts`, `backend/src/platform/observability/json-logger.ts`.
- `backend/prisma/schema.prisma` и новая ordered migration после `20260901000100_platform_foundation`.
- `backend/package.json`, root `package.json`, `pnpm-lock.yaml`, `.env.example`, `docker-compose.yml`, `infra/postgres/init-test-database.sql` и migration scripts.
- `frontend/src/app/page.tsx`, `frontend/src/app/layout.tsx`, `frontend/src/app/providers.tsx`, `frontend/src/lib/api/client.ts`, `frontend/src/app/globals.css`.
- `.github/workflows/ci.yml`, `docs/production/runbook.md`, при необходимости `docs/production/readiness.md` и `README.md`.
- `tests/architecture/module-boundaries.test.ts`, `backend/tests/integration/migration.test.ts`; новые unit/integration/Playwright tests должны дополнять, а не переписывать health/shell tests.

Вероятные новые области файлов (их точные имена не являются существующим кодом и выбираются при реализации согласно текущему layering):

- `backend/src/modules/identity/{domain,application,infrastructure,http}/` — registration, verification, resend, session lookup, repositories и email consumer adapter;
- `backend/src/modules/profiles/{application,infrastructure}/` — публичная команда атомарного создания draft profile и primary resume с переданным transaction context;
- `backend/src/modules/compliance/{application,infrastructure}/` — legal consent-evidence consumer и отдельный legal database client;
- `backend/src/platform/{database,delivery,idempotency,rate-limit}/` — только общие технические primitives, без domain repositories;
- отдельная Prisma schema и ordered migration history для legal database, не смешанная с `backend/prisma/schema.prisma` основной БД;
- `frontend/src/app/registration/`, route подтверждения email, registration components и Zod/form adapters;
- `backend/tests/unit/identity/`, `backend/tests/integration/identity/`, `tests/e2e/registration.spec.ts` и test doubles для email/legal/BullMQ.

# API changes

- Реализовать без переименования существующих operation IDs и DTO:
  - `POST /api/v1/auth/registrations` (`registerAccount`) — public, обязательный `Idempotency-Key`, `201 RegistrationResult`;
  - `POST /api/v1/auth/email-verifications` (`verifyEmail`) — public, обязательный `Idempotency-Key`, `200 SessionView` и установка/rotation `__Host-session`;
  - `POST /api/v1/auth/email-verifications/resend` (`resendEmailVerification`) — public generic email flow либо unverified session, обязательный `Idempotency-Key`, всегда неразглашающий `202 OperationAccepted` для public lookup;
  - `GET /api/v1/me` (`getCurrentAccount`) — текущая session, включая `unverified`, `200 CurrentAccount`, `Cache-Control: no-store`.
- Принимать только DTO из OpenAPI. Unknown request fields отклоняются. `RegistrationRequest` требует email ≤320, password 12..128, одну `formalRole`, `ProfileInput` и ровно четыре уникальных consent types с `accepted: true` и текущей `documentVersion`.
- Role-shaped profile validation:
  - `student`: обязательны `fullName`, `specialization`, `timezone`, `institute`, `course` 1..6;
  - `teacher`: обязательны `fullName`, `specialization`, `timezone`, `department`;
  - `employer`: обязательны `fullName`, `specialization`, `timezone`, `company`; `position` остаётся optional;
  - role-irrelevant поля отклоняются или нормализуются только согласно согласованному OpenAPI/data-model правилу, но не сохраняются молча.
- Вернуть документированные business codes: `EMAIL_ALREADY_REGISTERED`, `EMAIL_DOMAIN_NOT_ALLOWED`, `AGE_CONFIRMATION_REQUIRED`, `CONSENT_REQUIRED`, `CONSENT_VERSION_OUTDATED`, `TOKEN_INVALID_OR_EXPIRED`, `CONSENT_EVIDENCE_UNAVAILABLE`, `ALREADY_VERIFIED`, а также platform codes `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS` и rate-limit response с `Retry-After`.
- Error response остаётся `application/problem+json`, содержит итоговый `X-Request-Id`, русский actionable `message`, `retryable` и только безопасные `details`/`fieldErrors`.
- Повтор с тем же idempotency key и canonical payload возвращает исходный status/body с `Idempotency-Replayed: true`; тот же key с другим payload возвращает `409`.
- Регистрация, verification и resend входят в перечисленные в `docs/architecture/api-contracts.md` исключения из CSRF/Origin. Это не отменяет rate limiting, strict body validation и anti-enumeration.
- `CurrentAccount` не возвращает email, password hashes, consents, document versions, internal permission grants или legal identifiers. Для `unverified` capabilities не должны объявлять active-only действия.
- Не добавлять login, logout, CSRF и password-reset endpoints этапа 2.

# Database changes

- В основной DB создать в одной expand migration структуры и ограничения из `docs/architecture/data-model.md`:
  - `identity.accounts`, `identity.credentials`, `identity.auth_tokens`, `identity.consent_statuses`;
  - минимальную `identity.sessions`, необходимую для уже опубликованного ответа verification и `GET /me`;
  - `profiles.profiles`, `profiles.profile_versions` для сохранения `RegistrationRequest.profile`, `profiles.resumes` для primary slot `0`;
  - `platform.idempotency_records`, `platform.outbox_events`, `platform.outbox_deliveries`;
  - module-owned inbox table только там, где consumer действительно выполняет transactional local effect.
- В отдельной legal database создать `legal.consent_evidence` с `UNIQUE(source_event_id)`, индексами `(subject_token, occurred_at DESC, id)` и `(retention_until, id)`. Не создавать cross-database FK и не хранить там account ID, email, profile, password/token/session data либо content.
- Все UUID создаются приложением как UUIDv7; времена — `timestamptz` UTC; mutable roots имеют `row_version`; enums/checks и indexes соответствуют data model.
- `identity.accounts`: unique normalized email, domain constraint для `student|teacher`, default `system_role=user`, initial `state=unverified`, согласованность `state/email_verified_at`.
- `identity.credentials`: ровно одна строка на account; только Argon2id hash и версионированные параметры.
- `identity.auth_tokens`: хранить только hash, purpose `email_verification`, expiry и `consumed_at`; one-time consumption через conditional update; старые verification tokens отзываются при resend; terminal cleanup ≤24 часов.
- `identity.consent_statuses`: PK `(account_id, document_type)`, ровно четыре active записи после успешной регистрации, общий `source_event_id`/связь с доказательным событием без хранения raw UI evidence.
- `profiles.profiles`: unique logical `account_id`, immutable copy `formal_role`, default timezone, initial `publication_state=draft`.
- `profiles.profile_versions`: создать initial draft version с role-shaped input, потому что root не содержит profile payload. Не запускать moderation и не заполнять published/pending pointers в этой задаче.
- `profiles.resumes`: ровно один slot `0` на новый profile, `is_search_visible=true`, initial `publication_state=draft`; additional slots не создавать.
- Business transaction регистрации атомарно создаёт account, credential, consent statuses, profile root, initial profile draft, primary resume, idempotency result и outbox events/deliveries. Ошибка любой записи откатывает всё.
- Legal evidence и email не участвуют в этой транзакции. Их подтверждает delivery state/reconciliation; activation допускается только после успешного legal proof.
- Для public resend при несуществующем account текущая модель `platform.idempotency_records(actor_account_id, route, key)` не задаёт public actor scope. До реализации нужно согласовать и документировать безопасный scope/constraint; nullable actor без partial uniqueness и IP как identity использовать нельзя.
- Локально и в CI добавить отдельные legal development/test database и credentials, отдельную migration history и отдельную команду повторяемого migrate. Test migrations не должны затрагивать development databases.
- Миграция должна быть совместима с предыдущим application image; destructive contract changes отсутствуют.

# Backend changes

- Реализовать `Identity` как NestJS module с коротким потоком `controller -> application service -> domain rules / Prisma`; вход валидировать Zod. Prisma-модели не выдавать как response DTO.
- Реализовать application commands регистрации, verification и resend, а также query для `GET /me`. Публичные exports должны находиться в `backend/src/modules/identity/index.ts`.
- Реализовать в `Profiles` узкий public command создания draft profile + initial draft version + primary resume. `Identity` не импортирует Profiles repository и не выполняет прямой SQL по schema `profiles`; общий transaction context передаётся только через public contract.
- Нормализовать email перед domain/rate/idempotency checks; доменное правило должно проверять именно полный домен `mpei.ru`, а не suffix-подстроку. Пароль хэшировать Argon2id с явной версией параметров; raw password не хранить и не логировать.
- Генерировать криптографически случайные raw verification/session secrets, хранить только hashes. Verification token одноразовый и expiring; concurrent verification активирует аккаунт и создаёт session ровно один раз либо возвращает безопасный идемпотентный результат.
- Реализовать минимальный session issuer/auth reader для verification и `GET /me` согласно ADR-003: cookie `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`; session находится в PostgreSQL и доступна нескольким API replicas. Полные login/logout/CSRF/reset flows оставить этапу 2.
- Реализовать Redis-backed rate limits минимум по IP и HMAC/нормализованному email для register/resend/verify. Не писать raw email в Redis key. При недоступности limiter auth commands должны завершаться безопасно и наблюдаемо, а не обходить limit.
- Добавить reusable idempotency primitive с canonical request hash и атомарной фиксацией command result. Он не должен раскрывать domain repositories и не заменяет UNIQUE constraints.
- Добавить transactional outbox dispatcher: claim `platform.outbox_deliveries` через `FOR UPDATE SKIP LOCKED`, publish BullMQ job с `(eventId, consumer)` как `jobId`, bounded lease/retry, reconciliation и DLQ. Redis остаётся transport/scheduler, PostgreSQL — source of truth.
- Добавить `EmailSender` port и локальный/test adapter. Email consumer загружает адрес внутри owning Identity boundary по account ID; email не помещается в outbox payload. Повтор consumer не должен отправлять второе письмо после уже зафиксированного success.
- Добавить Compliance-owned legal consumer: вычислять keyed HMAC subject token и минимальный `evidence_hash`, idempotently вставлять proof по `source_event_id`, затем завершать delivery. Legal credentials доступны worker, но не browser/frontend; grant API должен быть минимальным.
- Verification проверяет четыре актуальных non-revoked consent statuses и завершённую legal-evidence delivery. Если proof ещё не подтверждён, вернуть `CONSENT_EVIDENCE_UNAVAILABLE`, оставить account `unverified` и не потреблять token, чтобы безопасный retry был возможен.
- Resend отзывает прежние неиспользованные verification tokens и создаёт новый token/email event только для допустимого `unverified` account. Public response не различает отсутствующий, удалённый или неподтверждённый email по status/body/timing настолько, насколько это контролируется приложением.
- Расширить `ProblemDetailsFilter` либо добавить typed application exceptions, сохранив текущую безопасную обработку 5xx.
- Сохранить correlation chain: outbox event получает `eventId`, request `correlationId` и causation metadata; worker logs включают event/consumer/attempt/result/latency без email, tokens, profile body и consent evidence.
- Добавить journey metrics и alerts: registration success/failure/rate-limit, verification age/success/failure, outbox oldest age, email/legal retry и DLQ. Обновить runbook для email outage, legal outage, stuck verification и safe replay.

# Frontend changes

- Добавить видимый русский entrypoint регистрации; остальные не реализованные features по-прежнему не показывать в навигации.
- Реализовать registration wizard на React Hook Form + Zod с использованием generated `RegistrationRequest`/`RegistrationResult`:
  - выбор одной formal role;
  - email/password;
  - role-shaped поля `ProfileInput`;
  - четыре самостоятельных, по умолчанию неотмеченных consent controls с отображением конкретной document version/ссылки на документ;
  - явное сообщение о требовании `@mpei.ru` для student/teacher и о том, что фактическая роль не проверяется.
- После `201` показать экран «Проверьте почту», не обещая фактическую доставку письма только на основании постановки outbox event.
- Реализовать verification route, читающий token из URL только для отправки в API. Token нельзя помещать в client logs, analytics, error text или persistent browser storage; после обработки URL должен быть очищен/заменён.
- Реализовать состояния verification: успех и session bootstrap через `GET /me`, истёкший/невалидный token с действием resend, временная недоступность consent evidence с безопасным retry.
- Реализовать resend UI с generic результатом, cooldown/`Retry-After` и без подтверждения существования email.
- Каждый unsafe retry использует тот же `Idempotency-Key` только с неизменным payload; новое осознанное submit создаёт новый key. Не повторять validation/business 4xx автоматически.
- Сохранять введённые несекретные поля при recoverable network error; password и verification token не сохранять в localStorage/sessionStorage.
- Все тексты — русские, field errors связаны с controls, focus переводится к summary/первой ошибке, wizard полностью работает с клавиатуры и на ширинах 360 px/1280 px.

# Edge cases

- Student/teacher использует `user@mpei.ru.evil`, subdomain либо mixed-case/Unicode email: разрешается только корректно нормализованный полный домен `mpei.ru`; employer не получает это ограничение.
- Два concurrent register с одним normalized email: существует ровно один account/profile/primary resume; повтор с тем же key replay-ит результат, другой command получает документированный duplicate response.
- В consents отсутствует тип, тип повторён, `accepted=false`, version устарела или передан пятый consent: регистрация отклоняется без частичных строк и outbox events.
- Role-specific поле отсутствует либо переданы взаимоисключающие student/teacher/employer поля: запрос не создаёт аккаунт.
- Сбой Argon2id, DB insert, Profiles public command или outbox insert: вся регистрационная транзакция откатывается.
- API ответ потерян после commit: повтор с тем же key возвращает исходный `201` без дублей.
- Redis недоступен до/после business commit: rate-limit не fail-open; уже записанный outbox восстанавливается reconciliation после возврата Redis.
- Email provider недоступен: account остаётся `unverified`, delivery повторяется с backoff/DLQ; resend не создаёт email storm.
- Legal database недоступна или consumer отстаёт: регистрация сохраняется, но verification не активирует account и не потребляет token; после восстановления replay создаёт одно evidence.
- Token истёк, уже использован, подменён или дважды предъявлен конкурентно: нет второй активации/session и нет различающей утечки; пользователь получает возможность resend.
- Resend для неизвестного/active/deleted email: public flow не раскрывает наличие аккаунта. Если `ALREADY_VERIFIED` сохраняется для authenticated path, этот вариант не должен быть доступен public lookup.
- Старое письмо после resend: отозванный token не активирует аккаунт.
- Document version изменилась между регистрацией и verification: применять явно согласованное правило текущих consent guards; нельзя автоматически переписать принятую пользователем version. До реализации это поведение должно быть зафиксировано в requirements/context.
- Legal evidence успешно записано, но worker завершился до отметки delivery: replay по `UNIQUE(source_event_id)` безопасно завершает delivery.
- Cookie не может быть установлена в локальном HTTP окружении из-за `Secure`: local reverse-proxy/test стратегия должна быть документирована и не ослаблять production flags.
- `GET /me` с отсутствующей, истёкшей или отозванной session возвращает generic auth error; unverified session не получает active capabilities.
- Cleanup не удаляет active token, незавершённый outbox/delivery или legal evidence раньше retention deadline.

# Tests

## Unit

- Email normalization и полный domain check для student/teacher/employer, включая case/Unicode/suffix cases.
- Zod DTO и role-shaped profile rules; ровно четыре уникальных consent types, `accepted=true`, current document versions.
- Password limits, Argon2id hash/verify и redaction; raw value отсутствует в snapshots/logs.
- Verification token/session generation, hashing, expiry и one-time state transition.
- Public/current-account capability calculation для `unverified` и `active`.
- Canonical payload hash, idempotency replay/mismatch/in-progress.
- HMAC subject token и evidence hash: deterministic для одного subject/key, не обратимы и не содержат PII.
- Outbox lease/backoff/DLQ/reconciliation и consumer inbox/idempotency rules.

## Integration/API

- Main и legal migrations дважды применяются на чистых test databases; проверяются все constraints, indexes и отсутствие cross-database FK.
- Registration happy path для student, teacher и employer; DB assertion на account, credential, четыре consent statuses, profile draft/version, один primary resume, idempotency и outbox deliveries.
- Transaction rollback на каждом fault injection point, включая public Profiles command и outbox insert.
- Concurrent duplicate email и concurrent identical/different idempotency payload.
- Exact HTTP statuses, generated schemas, content types, `X-Request-Id`, `Idempotency-Replayed`, `Retry-After` и safe Problem Details codes.
- Email duplicate prevention, provider timeout/retry/DLQ и recovery from Redis loss.
- Legal outage, insert-success/ack-failure replay, invalid HMAC config и reconciliation.
- Verification happy path: conditional token consumption, account activation, `email_verified_at`, session row/cookie и `GET /me`.
- Expired/revoked/already-consumed/concurrent token; consent proof missing; no token consumption on retryable legal state.
- Resend for unverified/existing/unknown/active accounts, old-token revocation, anti-enumeration response equivalence и rate limits.
- Logs/metrics do not contain email, password, raw token, session secret, cookie, profile payload or legal subject token.
- Несколько API/worker instances используют общие PostgreSQL/Redis state без sticky session и без duplicate effects.

## Frontend/Playwright

- Полная регистрация и verification для каждой из трёх roles.
- Invalid domain, missing role field, weak password, missing/false/outdated consent, server validation summary.
- Check-email и resend states, expired link, legal-evidence pending/retry, provider/network failure без потери несекретных form fields.
- Session bootstrap после verification и отсутствие active-only UI для unverified account.
- Keyboard-only flow, visible focus, labels/error associations и responsive screenshots/behavior на 360 px и 1280 px.
- Regression: shell health/degraded journey и OpenAPI generated-client/compatibility gates остаются зелёными.

# Acceptance criteria

- `POST /auth/registrations`, `POST /auth/email-verifications`, `POST /auth/email-verifications/resend` и `GET /me` реализованы в точном соответствии с согласованным OpenAPI; generated client не имеет ручных правок.
- Для student/teacher разрешён только домен `mpei.ru`; employer принимает любой валидный email; фактическая роль не проверяется и не даёт system permissions.
- Нельзя зарегистрироваться без каждого из четырёх отдельных `accepted=true` на актуальной document version; controls не предустановлены.
- Один successful registration commit создаёт ровно один `unverified` account, credential, четыре consent statuses, draft profile с сохранённым input и ровно один primary resume slot `0`, а также idempotency/outbox state.
- Password хранится только как Argon2id hash с версионированными параметрами; raw verification/session secrets и email не попадают в logs/telemetry/outbox payload.
- Повтор запроса или consumer job не создаёт business и side-effect duplicates; same key/different payload отклоняется.
- Email outage не откатывает созданный account; Redis outage не теряет side effects; recovery/reconciliation доказаны integration tests.
- Account становится `active` только при валидном одноразовом email token, четырёх действующих consent statuses и подтверждённой legal evidence delivery. При legal outage account остаётся `unverified`, token пригоден для retry.
- Legal database содержит только минимальное append-only evidence с HMAC subject token, без email/profile/content/account ID, и имеет отдельные credentials/migrations/tests.
- После verification устанавливается защищённая opaque session cookie, а `GET /me` возвращает `CurrentAccount` без email и внутренних security/legal данных.
- Public resend не позволяет определить существование аккаунта и не создаёт email storm; expired/old tokens не активируют account.
- Registration UI завершает happy path для трёх ролей, показывает русские actionable errors и доступен с клавиатуры на 360 px и 1280 px.
- Architecture-boundary tests подтверждают, что `Identity` использует только public contract `Profiles`, provider SDK отсутствуют в application/domain слоях, а Compliance владеет доступом к legal DB.
- Main и legal migrations воспроизводимы, обратно совместимы с foundation image и применяются CI на изолированных test databases.
- Добавлены registration/verification/outbox/email/legal metrics, alerts и runbook; все прежние unit/integration/E2E/smoke/OpenAPI/build gates остаются зелёными.
- До merge устранены и отражены в плановом/архитектурном контексте перечисленные ранние зависимости `identity.sessions`, `profiles.profile_versions` и public idempotency scope.

# Out of scope

- Login, logout, `GET /auth/csrf`, password reset, revoke-all sessions и полноценный session lifecycle этапа 2.
- Редактирование/публикация профиля и резюме, теги, media, moderation и public profile screen этапов 3—5.
- Additional resumes slots `1..5`.
- Notification center, marketing email, рекламное согласие и generic notification/email model этапа 4.
- SSO МЭИ, проверка статуса студента/преподавателя/работодателя, объединение аккаунтов и запрет вторых аккаунтов.
- Production provider procurement, утверждение юридических текстов и выбор observability vendor; задача должна оставить явные production blockers и contract-faithful local/test adapters.
- Изменение других bounded contexts, прямые cross-module repositories/SQL, отдельные deployable services, Kafka/RabbitMQ и хранение business state только в Redis/BullMQ.

# Risks

- В плане этапов `identity.sessions` назначена этапу 2, но текущий verification contract уже требует session cookie и `SessionView`. Если ранний expand не согласовать, реализация либо нарушит OpenAPI, либо создаст временную небезопасную session модель.
- `RegistrationRequest.profile` невозможно корректно сохранить только в `profiles.profiles`; без ранней `profiles.profile_versions` данные будут потеряны либо появятся временные колонки, противоречащие data model.
- `platform.idempotency_records` описан через `actor_account_id`, но public resend для неизвестного email не имеет actor. Нужен формально утверждённый public command scope и PostgreSQL uniqueness semantics до написания общего primitive.
- Не зафиксировано, что делать при смене current document version между registration и verification. Автоматическое повышение версии согласия юридически некорректно, а без правила возможны навсегда зависшие `unverified` accounts.
- Раздельная main/legal DB не даёт общей транзакции. Ошибка протокола acknowledgment может либо активировать аккаунт без proof, либо бесконечно блокировать его; `source_event_id` dedup и проверяемая delivery state обязательны.
- Email — внешний необратимый side effect. Inbox marker, записанный до фактической отправки, может потерять письмо, а записанный после — допустить duplicate при crash; adapter/provider должен иметь собственный idempotency key либо явно документированную at-least-once пользовательскую семантику.
- Anti-enumeration конфликтует с `EMAIL_ALREADY_REGISTERED` и `ALREADY_VERIFIED`: нужно чётко разделить осознанный registration validation и generic public resend, не меняя опубликованный контракт молча.
- `Secure` cookie не работает по обычному HTTP вне допустимого browser exception. Неправильный local workaround легко утечёт в production configuration.
- Argon2id cost, synchronous hashing concurrency и DB transactions могут нарушить latency/CPU budget; параметры должны быть нагрузочно проверены и версионированы.
- Слишком широкие legal credentials или PII в outbox/log attributes нарушат ADR-012 и TNFR-010 даже при корректном happy path.
- Неправильный lease/retry/DLQ protocol создаст duplicate emails, вечный outbox backlog или starvation heartbeat worker; нужны age-based alerts и bounded graceful shutdown.
