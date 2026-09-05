# TASK-005: Вход, выход, CSRF и восстановление доступа end-to-end

Статус: подготовлена к реализации; код в рамках подготовки задачи не изменялся.

Источник: этап 2 «Вход, выход, CSRF и восстановление доступа end-to-end» из `docs/plans/implementation-plan.md`.

Проверено по repository на 05.09.2026, commit `a8f58c5`. Оценка текущего состояния основана на чтении кода, миграций, контрактов и тестов; повторный запуск runtime-проверок при подготовке этой задачи не выполнялся.

# Goal

Завершить lifecycle локальной email/password-аутентификации: пользователь входит, получает отзываемую opaque session, безопасно выходит и устанавливает новый пароль по одноразовой ссылке из сервисного письма. После commit logout или password reset прежний доступ прекращается на любом экземпляре API.

Довести сценарий через русский UI, REST `/api/v1`, Identity, PostgreSQL, существующие rate limiter и transactional outbox/worker. Гость, `unverified`, `active` и `deleting` должны получать только допустимые им возможности; клиентское отображение не заменяет серверную проверку.

# Context

- Следующий нереализованный шаг в обязательной последовательности — этап 2. `docs/tasks/TASK-003.md` отмечает завершение этапа 0, `docs/tasks/TASK-004.md` — этапа 1. Фактический код подтверждает наличие shell, registration/verification/resend, `GET /me`, draft profile/primary resume, outbox и legal-evidence delivery. Старые разделы Context/Existing code этих задач описывают состояние до их реализации и не являются инвентаризацией текущего repository.
- В `IdentityController` отсутствуют все пять endpoints этапа 2. В `frontend/src/app/` нет `/login`, `/forgot-password`, `/reset-password` и защищённого layout. Наличие этих operations в OpenAPI и generated types не означает, что handlers реализованы.
- Минимальная `identity.sessions` уже создана этапом 1, как теперь прямо указано в плане. `Session` содержит хэши session/CSRF, expiry, revoke и timestamps; `Account.lastLoginAt` и enum `AuthTokenPurpose.password_reset` также уже существуют. Задача расширяет поведение, а не создаёт эти структуры заново.
- `verifyEmail()` создаёт session и случайный CSRF secret, но сохраняет только хэш последнего и не выдаёт его клиенту. `accountForSession()` проверяет expiry/revoke, однако общего Session/Active/consent guard нет. `getCurrentAccount()` выбирает capabilities только по `account.state === 'active'`, все остальные состояния получают verification capabilities; это недостаточно для `deleting/deleted`.
- В `verifyEmail()` lookup токена не проверяет `purpose`, а обновление аккаунта безусловно выставляет `active`. До появления reset tokens необходимо ограничить эту ветку email-verification назначением и допустимым состоянием, иначе новый flow расширит существующий путь активации.
- Повтор verification уже восстанавливает `Set-Cookie` из зашифрованного `IdempotencyRecord.responseSecret`. Добавление revoke требует проверить, что replay не создаёт новую сессию и не возвращает доступ отозванной сессии.
- `docs/context/project-context.md` и `docs/context/requirements-log.md` отсутствуют. Требования определяются текущим планом, принятыми ADR, продуктовой спецификацией и OpenAPI.
- Для этой задачи зафиксированы следующие уточнения контекста: фактические `/registration`, `/registration/check-email`, `/verify-email` сохраняются, хотя `frontend-design.md` использует старые `/register` и `/confirm-email`; новые auth screens связываются с существующими routes. OpenAPI задаёт выдачу CSRF через `200 CsrfToken` у `GET /auth/csrf`; упоминание «session+CSRF cookies» в таблице `api-contracts.md` не задаёт дополнительный обязательный cookie-контракт. Явные исключения public auth flows из session-bound CSRF берутся из раздела 2 `api-contracts.md`; нельзя требовать уже существующую session для входа или восстановления. При реализации синхронизировать соответствующие описания, а архитектурное отклонение от принятых ADR оформить отдельно до затронутого изменения.

# Relevant requirements

- `docs/product/product-spec.md`: `FR-006` — вход и выход; `FR-007`, `NFR-002`, `ERR-003` — восстановление только после email proof; `FR-011` — отсутствие гостевого доступа к пользовательскому контенту.
- `FR-152`, `EC-001`, `NFR-001`: `unverified` может войти, подтвердить email, запросить повторное письмо и восстановить доступ, но не создавать/изменять пользовательские сущности.
- `FR-160`: `deleting` не получает обычных пользовательских команд; доступ ограничен восстановлением аккаунта и выходом. Реализация самого восстановления удаляемого аккаунта остаётся этапу 18.
- `NFR-003`: роль профиля не даёт системных прав; клиент не определяет authorization. `TNFR-009` из `docs/product/requirements.md`: TLS, адаптивное хэширование паролей, server-side проверки и ограничения частоты auth-запросов.
- `docs/adr/ADR-003-authentication.md`: Argon2id с версионируемыми параметрами; случайная opaque session в `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`; PostgreSQL хранит хэш, expiry и revoke; немедленный отзыв HTTP-доступа.
- `docs/adr/ADR-012-security-boundaries.md`: API — пользовательская граница доступа; отдельные service identities; email, passwords, tokens, cookies и profile data не попадают в telemetry.
- `docs/adr/ADR-011-consistency-and-idempotency.md`, `docs/architecture/api-contracts.md`, раздел 3.2: command и idempotency result атомарны; canonical payload, scope account/HMAC subject, TTL не менее 24 часов; повторы не дублируют эффект. Auth secrets для точного replay допускаются только в authenticated encryption envelope в пределах TTL.
- `docs/architecture/data-model.md`, разделы 3.1–3.4: `last_login_at`, versioned Argon2 parameters, one-time purpose-bound tokens; terminal tokens хранятся максимум 24 часа, terminal sessions — максимум 30 суток.
- Общие правила плана: additive-only `/api/v1`, отдельные response DTO, expand/migrate/contract, module boundaries, unit/integration/API/Playwright, русский UI на 360 px и 1280 px с клавиатуры, correlation chain и наблюдаемость нового journey.

# Existing code

| Реальный файл | Найденные структуры и поведение |
|---|---|
| `backend/src/modules/identity/application/identity.service.ts` | `IdentityService.register()`, `verifyEmail()`, `resendEmailVerification()`, `getCurrentAccount()`, `currentConsentVersions()`, экспорт `normalizeEmail()`. Private `accountForSession()`, `lookupIdempotency()`, `reserveIdempotency()`, `evaluateIdempotency()`, `completeIdempotency()`, `createOutboxEvent()`. `ARGON2_PARAMETERS`: Argon2id, memoryCost 19456, timeCost 2, parallelism 1, hashLength 32; metadata version 1 сохраняется при регистрации. Login/reset/revoke методов нет. |
| `backend/src/modules/identity/http/identity.controller.ts` | `IdentityController` с registration/verification/resend/me handlers; `parseExternal()`, `sessionFromCookie()`, `setReplayHeader()`. Verification устанавливает cookie и `Cache-Control: no-store`. Нет CSRF/Origin guard. |
| `backend/src/modules/identity/identity.schemas.ts` | Zod `registrationRequestSchema`, `tokenRequestSchema`, `emailRequestSchema`, `idempotencyKeySchema`; `emailRequestSchema.email` сейчас optional для resend. Нельзя переиспользовать его без уточнения для reset, где OpenAPI требует email. |
| `backend/src/modules/identity/identity.types.ts` | `SessionView`, `CurrentAccount`, `CommandResult<T>` с optional `sessionSecret`; `consentDocumentTypes`. |
| `backend/src/modules/identity/identity.module.ts`, `backend/src/modules/identity/index.ts` | `IdentityModule.register(environment)` подключает `IdentityController`, `IdentityService`, `RateLimitService`; public exports включают `IdentityService`, `EmailSender`, `VerificationEmail`, `EMAIL_SENDER`, `SmtpEmailSender`. |
| `backend/src/modules/identity/infrastructure/rate-limit.service.ts` | `RateLimitService.consume(operation, subject)` использует Redis и HMAC ключи, возвращает `RATE_LIMITED`/429 либо `RATE_LIMIT_UNAVAILABLE`/503 с retry metadata. |
| `backend/src/platform/security/crypto.ts` | `randomSecret()`, `sha256()`, `hmacSha256()`, `encryptSecret()`/`decryptSecret()` на AES-256-GCM и `canonicalJson()`. |
| `backend/src/platform/database/database.service.ts`, `backend/src/api/app.ts` | `DatabaseService`; `createApiApplication(environment, options)` создаёт Nest app, задаёт `trust proxy` из `TRUST_PROXY_HOPS`, request context, problem filter и prefix. |
| `backend/src/platform/http/application-error.ts`, `backend/src/platform/http/problem-details.ts`, `backend/src/platform/http/request-context.ts` | `ApplicationError`, `ProblemDetailsFilter`, `requestContextMiddleware()`, `getRequestContext()` — существующие ошибки и correlation infrastructure. |
| `backend/prisma/schema.prisma` | `Account`, `Credential`, `AuthToken`, `Session`, `ConsentStatus`, `IdempotencyRecord`, `OutboxEvent`, `OutboxDelivery`; реальные поля описаны в Database changes ниже. |
| `backend/prisma/migrations/20260904000100_registration_identity/migration.sql` | Созданные identity/platform/profile tables; UNIQUE хэшей токенов и сессий, partial indexes активных sessions и незавершённых tokens. |
| `backend/src/modules/identity/application/email-sender.port.ts`, `backend/src/modules/identity/infrastructure/smtp-email-sender.ts` | `EmailSender.sendVerificationEmail(VerificationEmail)` и `close()`; `SmtpEmailSender` отправляет письмо через Nodemailer со стабильным `messageId` от `eventId`. Reset mail метода нет. |
| `backend/src/worker/outbox-worker.service.ts` | `OutboxWorkerService`, private `#dispatch()`, `#handle()`, `#sendVerificationEmail()`, `#cleanupIfDue()`: PostgreSQL leases/CAS, BullMQ, retry/dead-letter и consumers `identity.verification-email`, `compliance.consent-evidence`. Новый reset consumer пока отсутствует. |
| `backend/src/worker/registration-retention.ts` | `purgeMainRegistrationState(database, now)` очищает terminal auth tokens, истёкшие idempotency records и завершённый outbox; session cleanup отсутствует. |
| `backend/src/worker/worker.module.ts` | `WorkerModule.register()` подключает `OutboxWorkerService` и `SmtpEmailSender` через `EMAIL_SENDER`. |
| `backend/src/platform/config/env.schema.ts` | `parseApiEnvironment()`/`parseWorkerEnvironment()`, `ApiEnvironment`/`WorkerEnvironment`; уже есть `AUTH_TOKEN_TTL_SECONDS`, `AUTH_SESSION_TTL_SECONDS`, `AUTH_TOKEN_ENCRYPTION_KEY`, `IDEMPOTENCY_HMAC_KEY`, consent versions, limiter settings, `SESSION_COOKIE_SECURE`; `PUBLIC_APP_URL` пока только у worker. API Origin allowlist отсутствует. |
| `frontend/src/lib/api/client.ts`, `frontend/src/lib/api/generated.ts` | `apiClient` с `/api/v1`; generated `paths`, `operations`, `components`, включая `LoginRequest`, `PasswordResetConfirm`, `CsrfToken`, `SessionView`, `CurrentAccount`. |
| `frontend/src/app/providers.tsx`, `frontend/src/app/layout.tsx`, `frontend/src/app/page.tsx` | `Providers` предоставляет TanStack Query; `RootLayout` задаёт русский shell; `Home` показывает health и регистрацию. Общего session bootstrap нет. |
| `frontend/src/components/verify-email.tsx` | `VerifyEmail` извлекает token, убирает query из browser history, вызывает verification и затем `/me`. Не заполняет общий auth cache и не получает CSRF. |
| `frontend/src/components/registration-form.tsx`, `frontend/src/components/resend-verification-form.tsx`, `frontend/src/lib/idempotency.ts` | Существующие формы регистрации/resend; `PendingIdempotencyAttempt`, `prepareIdempotencyAttempt()` и `verificationIdempotencyKey()` для безопасного повтора. |
| `infra/nginx/default.conf`, `docker-compose.yml` | Same-origin proxy, forwarded headers, `Referrer-Policy: no-referrer`, access log без query; локальный SMTP/Mailpit. HTTPS production и local cookie settings должны учитываться при проверке login/logout. |
| `backend/tests/integration/registration-api.test.ts`, `backend/tests/unit/identity-rules.test.ts`, `frontend/tests/registration.test.ts`, `tests/e2e/registration.spec.ts` | Уже есть проверки регистрации, активации, replay, cookies, limiter, retention, форм и браузерного registration journey. |
| `tests/architecture/module-boundaries.ts`, `tests/architecture/module-boundaries.test.ts` | `findBoundaryViolations()` запрещает межмодульные internal imports, provider SDK в application/domain и циклы. |

# Files likely affected

Существующие файлы, которые требуется расширить или проверить на совместимость:

- Identity: `backend/src/modules/identity/application/identity.service.ts`, `http/identity.controller.ts`, `identity.schemas.ts`, `identity.types.ts`, `identity.module.ts`, `index.ts`, `infrastructure/rate-limit.service.ts`, `application/email-sender.port.ts`, `infrastructure/smtp-email-sender.ts`.
- Platform/API: `backend/src/platform/config/env.schema.ts`, `backend/src/platform/security/crypto.ts`, `backend/src/platform/observability/json-logger.ts`, `backend/src/platform/http/problem-details.ts`, `backend/src/api/app.ts`; `backend/src/app.module.ts` при изменении подключения guards/providers.
- Worker: `backend/src/worker/outbox-worker.service.ts`, `backend/src/worker/registration-retention.ts`, `backend/src/worker/worker.module.ts`.
- DB/config: `backend/prisma/schema.prisma`, `.env.example`, `docker-compose.yml`, `infra/postgres/init-test-database.sql`, `infra/nginx/default.conf`. Изменять grants/proxy только при необходимости новых session cleanup/Origin/SSR настроек.
- Frontend: `frontend/src/lib/api/client.ts`, `frontend/src/app/providers.tsx`, `frontend/src/app/layout.tsx`, `frontend/src/app/page.tsx`, `frontend/src/components/verify-email.tsx`, `frontend/src/components/resend-verification-form.tsx`, `frontend/src/lib/idempotency.ts`.
- Contract: `api/openapi.yaml` только для необходимых совместимых уточнений; `frontend/src/lib/api/generated.ts` только через `pnpm openapi:generate`. `api/openapi.release.yaml` не обновлять ради обхода compatibility gate.
- Verification: `backend/tests/integration/registration-api.test.ts`, `backend/tests/integration/migration.test.ts`, `backend/tests/unit/identity-rules.test.ts`, `backend/tests/unit/env.schema.test.ts`, `backend/tests/unit/problem-details.test.ts`, `frontend/tests/registration.test.ts`, `tests/e2e/registration.spec.ts`, `tests/architecture/module-boundaries.test.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- Документы: `README.md`, `docs/architecture/api-contracts.md`, `docs/architecture/frontend-design.md`, `docs/production/runbook.md`, `docs/production/registration-observability.md`; `docs/architecture/data-model.md` только при фактическом расширении хранения.

Предлагаемые новые файлы/области, которых сейчас нет; имена являются планом реализации:

- `backend/src/modules/identity/http/` — session/CSRF guards и route access metadata; `backend/src/modules/identity/application/` — выделенные session/reset services или policy helpers, если нужны для разделения ответственности.
- `frontend/src/app/login/page.tsx`, `frontend/src/app/forgot-password/page.tsx`, `frontend/src/app/reset-password/page.tsx`; auth components и server-side session adapter/защищённый layout в структуре `frontend/src/`.
- `backend/tests/integration/auth-api.test.ts`, `backend/tests/unit/auth-rules.test.ts`, `frontend/tests/auth.test.ts`, `tests/e2e/auth.spec.ts`.
- Новая ordered migration в `backend/prisma/migrations/` после `20260904000100_registration_identity`, только если нужны новые поля/индексы; `docs/production/auth-observability.md` для нового journey.

# API changes

Реализовать существующий контракт без переименования operations и DTO. Пути ниже относительны к `/api/v1`.

| Метод и путь | operationId | Вход и защита | Успех |
|---|---|---|---|
| `GET /auth/csrf` | `getCsrfToken` | Действующая session, включая разрешённые ограниченные состояния | `200 CsrfToken { csrfToken }`, `Cache-Control: no-store` |
| `POST /auth/sessions` | `createSession` | Public; `LoginRequest { email, password }`; optional `Idempotency-Key`; distributed rate limit | `200 SessionView`, установка/rotation `__Host-session`, `Cache-Control: no-store` |
| `DELETE /auth/session` | `deleteCurrentSession` | Текущая session, включая `deleting`; allowlisted Origin и `X-CSRF-Token` | `204` без body, revoke и очистка cookie; повторный logout также `204` |
| `POST /auth/password-resets` | `requestPasswordReset` | Public; `EmailRequest { email }`; обязательный `Idempotency-Key`, rate limit | Generic `202 OperationAccepted { accepted: true }` |
| `POST /auth/password-resets/confirm` | `confirmPasswordReset` | Public; `PasswordResetConfirm { token, password }`; обязательный `Idempotency-Key`, rate limit | `204` без body; пароль заменён, все прежние sessions отозваны |

- Валидация строго соответствует OpenAPI: email ≤320; login password 1..128, новый password 12..128; reset token 32..2048; `CsrfToken.csrfToken` 32..256; unknown request fields отклоняются. Не применять регистрационный минимум 12 к проверке входа и не делать email optional у reset request.
- Ошибки: `INVALID_CREDENTIALS`, `ACCOUNT_DELETED`, `TOKEN_INVALID_OR_EXPIRED`, `PASSWORD_REUSED`; общие `AUTH_REQUIRED`/`SESSION_EXPIRED`, `CSRF_FAILED`, `ACCOUNT_UNVERIFIED`, `ACCOUNT_DELETING`, `CONSENT_REQUIRED`, `RATE_LIMITED`, `RATE_LIMIT_UNAVAILABLE`, idempotency codes. Сохранять envelope, `X-Request-Id`, `Retry-After` и безопасные русские сообщения.
- Неверный пароль и неизвестный email неразличимы по публичному ответу. `ACCOUNT_DELETED` не должен раскрывать account state до доказательства credentials. Запрос reset одинаков для существующего, неизвестного и недоступного для reset аккаунта.
- `GET /me` сохраняет DTO и `no-store`, но вычисляет capabilities по состоянию и согласиям; `deleting` не получает verification/profile capabilities, `deleted` не получает рабочую session. `unverified` и `deleting` допускаются к техническому bootstrap согласно контракту.
- Public registration/login/verification/resend/reset flows не требуют session-bound CSRF; не расширять это исключение на остальные unsafe endpoints. Для logout обязательна проверка Origin, а для живой session также CSRF; повтор после уже выполненного revoke/удалённой cookie не должен превращаться в `401` или повторно менять состояние.
- `If-Match` не добавлять: для этих operations он не предусмотрен; конкурентность обеспечивается внутри PostgreSQL.

# Database changes

- Переиспользовать `Account.emailNormalized`, `state`, `emailVerifiedAt`, `lastLoginAt`; `Credential.passwordHash`, `argon2Parameters`, `passwordChangedAt`; `AuthToken.purpose`, `tokenHash`, `expiresAt`, `consumedAt`; `Session.sessionHash`, `csrfSecretHash`, `expiresAt`, `revokedAt`, `lastSeenAt`, `createdAt`.
- Session creation/rotation и обновление `last_login_at` выполняются согласованно при успешном входе. Не обновлять активность при неверных credentials и не смешивать её с будущим `profiles.activity_days`.
- В одной транзакции reset confirmation проверить назначение/expiry/одноразовость token, допустимое состояние аккаунта и актуальный credential, заменить hash/metadata/passwordChangedAt, погасить reset tokens, отозвать прежние sessions и записать idempotency result. При отказе никакая часть перехода не сохраняется.
- Защитить выдачу sessions и reset общим account/credential locking или эквивалентным CAS: login, проверивший старый hash до reset, не может после reset commit выдать действующую session по старому паролю. Два разных reset tokens одного аккаунта не должны последовательно перезаписать пароль после уже завершённого reset.
- Новый reset token и событие доставки письма фиксируются вместе в существующих `platform.outbox_events`/`outbox_deliveries`. В token/session rows только хэши; для доставки/replay — существующий encrypted envelope, не открытый secret. Не создавать отдельные auth tables без выявленной необходимости.
- Продолжить cleanup terminal tokens через `purgeMainRegistrationState()`, добавить bounded cleanup sessions с retention ≤30 суток после revoke/expiry и сохранением ещё действующих sessions. При необходимости добавить индекс revoked terminal rows новой миграцией; существующие partial indexes не покрывают автоматически все cleanup запросы.
- Старые session rows, созданные verification, должны оставаться пригодными для bootstrap/CSRF до expiry/revoke. Если выбранному CSRF механизму требуется новое поле, применить совместимый expand и backfill/lazy upgrade; raw CSRF secret в PostgreSQL не вводить.
- Не переписывать применённые миграции. Сохранить UNIQUE/partial indexes и изоляцию main/legal DB; данные legal evidence, Profiles и primary resume не изменяются этим flow.

# Backend changes

1. Добавить login с `normalizeEmail()` и Argon2id verification. Для отсутствующего аккаунта использовать сопоставимую по стоимости проверку, чтобы быстрый путь не перечислял email. Ограничивать IP и account/normalized subject до дорогой password-проверки. Сохранять versioned Argon2 metadata при reset.
2. Выделить переиспользуемый session lifecycle для login и verification: криптографически случайный secret, hash lookup, expiry/revoke на каждом защищённом запросе, rotation при повторной аутентификации и согласованные cookie flags. Не доверять присланному идентификатору сессии и не хранить authority в памяти API instance.
3. Реализовать `GET /auth/csrf` и проверку session-bound CSRF с безопасным сравнением, Origin allowlist и deny-by-default route access policy. Выбрать механизм выдачи, работающий с существующими hashed session rows и несколькими вкладками: повторный bootstrap не должен постоянно инвалидировать токены другой вкладки. Настройки Origin валидировать явно, не строить доверенный origin только из произвольных Host/forwarded headers.
4. Ввести Session и Active/state/consent проверки на сервере с отдельными разрешениями ограниченных состояний. Login `unverified` не подтверждает email. Login `deleting` может выдавать только ограниченную session для предусмотренного контрактом bootstrap/выхода/будущего восстановления, без изменения состояния аккаунта. Reset не отменяет удаление и не активирует неподтверждённый аккаунт; `deleting/deleted` не получают изменение credentials этим путём. Проверки Active доступны будущим модулям через public Identity contract.
5. Реализовать logout: revoke текущей session до успешного ответа, корректное удаление cookie с теми же атрибутами и безопасный `204` replay. Действительные sessions других устройств при обычном logout сохраняются; reset отзывает все прежние sessions аккаунта.
6. Реализовать request/confirm reset с mandatory idempotency. Проверять token purpose в обеих ветках, включая существующий `verifyEmail()`, и state transitions при verification. `PASSWORD_REUSED` означает совпадение с текущим password hash; историю паролей не вводить. После успешного reset клиент входит новым паролем отдельно, поскольку контракт confirmation возвращает `204`, а не новую session.
7. Расширить `EmailSender` отдельным reset mail contract и `SmtpEmailSender` сервисным шаблоном со ссылкой на `/reset-password`. Добавить соответствующий consumer в существующий worker; адрес получать внутри Identity через его public contract, без нового обхода модульной границы. Queue job содержит технические IDs, а не email/token/URL. Сохранить leases, bounded retries, DLQ и reconciliation.
8. Учитывать expiry/consumption токена и состояние аккаунта при задержанной доставке. Retry не выпускает новый reset token и не меняет пароль. Сбой SMTP/worker после commit не отменяет принятое состояние, а остаётся диагностируемым backlog/retry. Стабильный SMTP `messageId` не считать доказательством exactly-once доставки внешнего письма.
9. Login с optional key поддерживает точный replay без создания второй session; без key каждый запрос проходит обычную аутентификацию. Replay login/verification после logout/reset может воспроизвести прежний результат по контракту, но никогда не снимает revoke, не продлевает DB expiry и не создаёт замену отозванной session. `/me` остаётся источником фактического доступа.
10. При недоступном distributed limiter новые auth commands fail closed. Уже завершённый idempotency replay не выполняет команду заново; текущий registration replay при Redis outage сохраняется. Не переносить rate limit в process-local память. Проверить очистку malformed cookie без утечки exception details.
11. Добавить безопасные метрики login/logout/reset/CSRF failure и reset delivery, dashboard/alerts и runbook с действиями при limiter/SMTP/worker outage. Сохранять `requestId -> correlationId -> eventId`; email, IP, passwords, CSRF/session/reset secrets, cookies и полные URL не использовать как log/metric attributes. Аудит не должен добавлять content в legal DB.

# Frontend changes

- Реализовать `/login`, `/forgot-password`, `/reset-password` с React Hook Form/Zod и существующим typed `apiClient`: labels, autocomplete, доступный submit/loading/error/success, общий ответ на запрос письма, ошибки expiry/password reuse и retry с тем же key при неизменном payload.
- Добавить session bootstrap через `/me`, затем `/auth/csrf` для действующей session. Хранить CSRF в памяти, не читать HttpOnly session cookie из JS и не сохранять password/token в localStorage/sessionStorage. Учитывать существующий `prepareIdempotencyAttempt()`, чья fingerprint содержит canonical body: держать auth attempts только в памяти и очищать после завершения.
- После login/verification обновлять общий session cache; после logout/reset удалять auth state и персональные query data. Не повторять unsafe command автоматически после `401` или `CSRF_FAILED`. Успех confirmation reset ведёт на `/login`.
- Защищённый layout проверяет session/state на сервере через API до выдачи защищённого содержимого. Серверный adapter передаёт cookie текущего запроса и отключает кэширование; не обращается напрямую к PostgreSQL и не хранит cookie в глобальном клиенте. Клиентский bootstrap отвечает за UX и refetch.
- Гость видит public auth routes; `unverified` — объяснение и существующий resend journey; `active` — минимальное состояние вошедшего аккаунта и выход; `deleting` — ограниченное состояние и выход. Не добавлять неработающую кнопку восстановления аккаунта этапа 18. Для неизвестного `accountState` показывать безопасное ограниченное состояние с возможностью обновить данные.
- Подключить ссылки входа/восстановления/выхода к существующему shell и auth screens. Возврат на исходный маршрут после login допускает только безопасный локальный путь; внешние/protocol-relative URL отклоняются. При отсутствии реализованного назначения использовать текущую главную страницу.
- Reset token извлекать из ссылки без автоматического изменения пароля, убрать из адресной строки после захвата, исключить из telemetry/referrer и очищать при завершении. Использовать существующий подход `VerifyEmail` и `Referrer-Policy` proxy с учётом особенностей reset формы.
- Проверить keyboard focus, ошибки формы, отсутствие горизонтального overflow и сценарии на явных viewport 360 px и 1280 px; одного пресета Pixel 7 из текущего Playwright config недостаточно для подтверждения 360 px.

# Edge cases

- Неверный пароль, неизвестный email, неправильный формат, Unicode/регистр email, malformed cookie, истёкшая/отозванная session; отсутствующий аккаунт под сохранённой session.
- `unverified` входит и восстанавливает пароль, но остаётся неподтверждённым; отсутствие/отзыв обязательного согласия не обходятся capabilities или старой session. `deleting` не получает обычные commands; `deleted` не получает доступ.
- Reset token передан в email verification и наоборот; token consumed/expired на точной временной границе; неверное назначение не меняет ни account state, ни credentials.
- Два параллельных confirmation одного token; два tokens одного аккаунта; login со старым паролем одновременно с reset; logout одновременно с replay verification/login. Один commit не должен оставлять частичное или воскресшее состояние.
- Повтор с тем же key/payload после потерянного ответа; другой payload с тем же key; key после expiry; optional login key; повтор logout после удаления cookie. Результат replay не заменяет проверку живой session.
- Отсутствующий/`null`/чужой Origin, поддельные forwarded headers, CSRF другой session, повторный bootstrap в двух вкладках, rotation после verification/login. Неверный CSRF живой session не должен отзывать её.
- Redis недоступен до команды; SMTP/worker остановлен после commit; delivery повторена после успешной отправки до отметки completed; восстановление worker после expiry reset token; legal DB outage не должен делать reset зависимым от новой legal записи.
- Session истекла при отправке формы, logout в другой вкладке, Back после logout, reload защищённого route, подмена return URL. Кэш другого вошедшего аккаунта не показывается после повторного входа.

# Tests

Тесты ниже требуются при реализации TASK-005, а не считаются уже пройденными.

- Unit: login/reset DTO и границы длины; normalization; Argon2 verification/password reuse; state/consent access matrix; purpose/expiry rules; CSRF binding и malformed cookies; Origin config; очистка клиентского auth cache и безопасный return URL.
- Integration/API на PostgreSQL/Redis: все пять operations с точными status/body/headers; обязательный email для reset; cookie flags и отсутствие raw secrets в storage; ротация, expiry/revoke и `lastLoginAt`; generic ошибки; `getCurrentAccount()` для всех состояний; работа CSRF у session, созданной старой verification веткой.
- Security: Session/Active guard проверять также через test-only controller, поскольку production profile/content routes ещё не реализованы. Доказать отказ гостю/unverified/deleting/без согласий прямым HTTP-запросом, а не только отсутствием кнопки. Никакой test-only endpoint не подключается в production app.
- Concurrency: same-token/different-key reset, разные tokens одного аккаунта, login/reset в обоих порядках commit, reset/logout/verification replay; при rollback не остаётся изменённого пароля или частично отозванных sessions. Проверять состояние через два API instances с общей БД.
- Idempotency: request/reset-confirm и keyed login replay, payload mismatch, потерянный ответ; logout повторно `204`; replay после revoke не восстанавливает доступ. Сохранить существующий registration replay при недоступном limiter.
- Outbox/resilience: новый reset consumer, retry/DLQ/lease replay, недоступные Redis/SMTP/worker, delayed expired token; request остаётся generic и пароль не меняется до confirmation. Проверять отсутствие секретов в queue payload и telemetry, не заявлять exactly-once SMTP delivery по одному `messageId`.
- DB/retention: миграции применяются повторно через существующий integration script, upgrade поверх registration schema сохраняет данные; terminal sessions удаляются в пределах 30 суток, terminal tokens — 24 часов; активные sessions/tokens сохраняются. Проверить grants worker и план cleanup запросов при добавлении индекса.
- Playwright: registration → verification → logout → login; forgot → письмо в Mailpit → reset → прежняя session теряет доступ → вход новым паролем; unverified/ошибочные credentials/expired link; server-side route guard при прямой навигации и reload; keyboard и 360/1280 px. Существующие registration/shell tests продолжают проходить.
- Quality gates из root `package.json`: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm openapi:lint`, `pnpm openapi:check`, `pnpm build`; на поднятом stack — `pnpm smoke`, `pnpm test:e2e` и degraded smoke по существующему README. Architecture tests входят в root unit suite.

# Acceptance criteria

1. Все пять endpoints этапа 2 реализованы по текущему OpenAPI, а `/me` и registration/verification/resend проходят регрессионные проверки. Generated client соответствует спецификации, compatibility gate не обойдён обновлением release snapshot.
2. Пользователь проходит login/logout/reset через русский UI. В локальном stack письмо восстановления доступно в существующем Mailpit; новый пароль принимается только после одноразового email proof, старый пароль больше не подходит.
3. Session cookie соответствует ADR-003, PostgreSQL не хранит открытые session/reset/CSRF secrets. После logout/reset commit старые sessions не авторизуют новые HTTP-запросы на любом экземпляре API; replay и конкурентный login не восстанавливают этот доступ.
4. CSRF связан с конкретной живой session, Origin проверяется, public auth exceptions ограничены контрактом; чужой CSRF отклоняется. Повторный logout безопасно возвращает `204`, multi-tab bootstrap работает.
5. `unverified`, `deleting`, `deleted` и аккаунт без действующих согласий не получают Active-доступ ни через прямой API, ни через SSR/client cache. Login/reset не меняют state вне предусмотренных переходов; reset token невозможно использовать как email verification.
6. Reset confirmation атомарен при гонках и сбоях; same-key replay не повторяет смену пароля/выпуск токена/session. Generic ответы и rate limits не дают публичного способа перечислить аккаунты.
7. Новые auth commands fail closed при недоступном limiter. Письмо доставляется через существующий transactional outbox с retry/DLQ; внешний сбой не теряет команду и не создаёт ложный password reset success.
8. Cleanup sessions/tokens выполняется с указанным retention; миграции, если понадобились, совместимы с предыдущим image. Legal evidence и профильные данные не используются для нового auth storage.
9. Пройдены перечисленные unit/integration/API/architecture/Playwright gates, runtime smoke и проверки UI на 360/1280 px. Добавлены метрики, dashboard/alerts и runbook нового auth journey; secrets/PII отсутствуют в telemetry.
10. `README.md` описывает доступный auth journey и конфигурацию, расхождения auth routes/CSRF описаний устранены; приложение запускается одной документированной командой. Более поздние возможности не объявлены реализованными.

# Out of scope

- Реализация следующих этапов: uploads/media, профиль/резюме editor/publication, поиск, команды, объявления, переписка, moderation, privacy requests и account deletion/restore workflow.
- Socket.IO gateway и Redis fan-out отключения sockets: в repository gateway отсутствует, это этап 10. Здесь обеспечивается немедленный HTTP revoke и пригодный для дальнейшего расширения public Identity contract.
- JWT, refresh tokens, OIDC/SSO МЭИ, social login, MFA, смена email, password history, список устройств и отдельный UI управления всеми sessions.
- Пересоздание account/profile/primary resume при входе/reset; новые legal evidence types; изменение формальных ролей или moderator permissions.
- Переписывание всей outbox infrastructure, введение второго auth store/process-local authority, массовый рефакторинг других bounded contexts и production release gate этапа 19.

# Risks

- Текущий `verifyEmail()` не отделяет token purpose и безусловно обновляет account state. Если просто добавить reset flow, можно получить обход подтверждения email или состояния удаления. Исправление этой границы входит в задачу и требует регрессионных тестов.
- Argon2 проверка вне транзакции без повторной проверки актуального credential создаёт гонку login/reset; длительный Argon2 внутри блокировки повышает contention. Решение должно сочетать ограниченную стоимость хэширования и согласованный commit.
- Существующий CSRF hash нельзя обратить в исходный token. Наивная выдача нового token при каждом GET может ломать параллельные вкладки; хранение raw secret или process-local map нарушит принятые ограничения.
- Encrypted idempotency replay сохраняет прежний cookie secret. Без проверки lifecycle легко ошибочно продлить либо воскресить session; безопасность доступа важнее клиентского предположения, что любой `200 SessionView` всё ещё означает живую session.
- Существующий `RateLimitService` и worker уже используются регистрацией. Изменения limits/consumers/cleanup могут сломать ранее завершённый journey; scope изменений и regression coverage должны оставаться явными.
- `EmailSender` пока содержит только verification метод; добавление reset method потребует обновления test doubles. SMTP не гарантирует exactly-once по `messageId`; retry должен быть безопасен даже при повторном письме.
- Reverse proxy/local HTTP, `__Host-session` и новый server-side API adapter могут по-разному вести себя на localhost и production HTTPS. Неверная Origin/trust-proxy конфигурация либо общий SSR cache способны нарушить вход или изоляцию sessions.
- Формы, idempotency fingerprints, reset URL и Playwright traces содержат чувствительные данные. Тестировать на синтетических аккаунтах, исключить секреты из журналов и ограничить хранение диагностических artifacts.
