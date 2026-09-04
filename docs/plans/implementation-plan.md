# План реализации MVP «Команда.МЭИ»

Статус: план реализации по согласованному продуктовому и архитектурному baseline.
Дата: 01.09.2026.

## 1. Основание и правила исполнения

План составлен по следующим утверждённым источникам: `docs/product/product-spec.md`, `docs/product/requirements.md`, `docs/product/tag-catalog.md`, `docs/product/appendix-prohibited-content.md`, `docs/architecture/system-design.md`, `docs/architecture/data-model.md`, `docs/architecture/api-contracts.md`, `api/openapi.yaml`, ADR-001—ADR-015 и production-документам. `TASK-001` и `TASK-002` имеют статус «не запланирована» и не являются источниками scope. Архитектурная спецификация `C:/Users/alex/Downloads/CODEX_ARCHITECTURE_SPEC.md` используется только как нижестоящий baseline там, где более новые документы не задают решение.

Порядок ниже обязателен. Этап считается вертикальным slice: он доводит ограниченный пользовательский или эксплуатационный сценарий через UI, REST, application/domain rules, PostgreSQL и нужные фоновые эффекты. После каждого этапа ранее завершённые сценарии продолжают работать, локальный стек запускается одной документированной командой, а незавершённые функции не показываются в навигации и не объявляются готовыми. Нельзя временно обходить модульные границы общими repositories или прямым чтением чужих PostgreSQL schemas.

Общие правила для всех этапов:

- REST `/api/v1` и `api/openapi.yaml` — source of truth; изменение контракта additive-only, response DTO отделены от Prisma-моделей.
- Каждый новый command сразу получает требуемые `Idempotency-Key`, `If-Match`, CSRF/Origin и object-level authorization, а не откладывает их на hardening.
- Предметный commit и outbox находятся в одной транзакции; Redis, S3, email и moderation provider не участвуют в ней.
- Каждая новая публичная версия скрыта до одобрения текста и всех связанных public media; последняя одобренная версия остаётся видимой.
- Каждый slice добавляет telemetry `requestId -> correlationId -> eventId`, redaction, dashboard/alert для своего journey и обновляет runbook при появлении нового режима деградации.
- DB-изменения выполняются expand/migrate/contract; миграции воспроизводимы и совместимы с предыдущим application image.
- Для каждого slice обязательны unit, integration/API и Playwright tests пропорционально сценарию, architecture-boundary tests и проверка русского UI на 360 px и 1280 px с клавиатуры.

## 2. Последовательность этапов

### Этап 0. Запускаемый application shell и проверяемый контракт

**Goal**

Получить минимальную, но полностью запускаемую систему: русский web shell обращается к stateless API, API и worker подключаются к локальным PostgreSQL, Redis и S3-compatible storage, а CI доказывает сборку и целостность контракта.

**Requirements covered**

TNFR-005, TNFR-012—TNFR-014; NFR-012—NFR-015, NFR-023; ADR-001, ADR-002, ADR-004, ADR-008—ADR-010, ADR-013—ADR-015.

**Backend changes**

- Создать pnpm/Turborepo TypeScript-strict workspace, NestJS modular-monolith package и два entrypoints: `api` и `worker`.
- Ввести configuration validation, stable error envelope, UUIDv7, clock/transaction primitives, structured logging, correlation middleware, readiness/liveness и graceful shutdown.
- Зафиксировать модульные public entrypoints и automated dependency rules; создать пустые module shells без speculative business abstractions.

**Frontend changes**

- Создать Next.js App Router shell с Tailwind/shadcn, TanStack Query, React Hook Form/Zod, русским layout, error boundary и скрытой навигацией для ещё не реализованных features.
- Подключить generated TypeScript client через same-origin `/api/v1`; предусмотреть fallback для неизвестных response enum values.

**DB changes**

- Поднять локальный PostgreSQL и отдельную test database; включить `pg_trgm` и завести ordered migration histories по schemas.
- Не создавать все предметные таблицы заранее; добавить только migration ledger и необходимую platform metadata.

**API changes**

- Реализовать служебные health/readiness endpoints вне business API.
- Настроить lint/parse `api/openapi.yaml`, уникальность `operationId`, generated-client compile и compatibility snapshot; business endpoints пока не экспонировать из UI.

**Tests**

- Smoke: одной командой стартуют web, API, worker, PostgreSQL, Redis и MinIO; web получает health response через reverse proxy.
- CI: format, lint, typecheck, unit, OpenAPI lint/generation, architecture dependency tests, production builds и dependency/secrets scan.

**Dependencies**

Нет. Это единственный обязательный foundation slice.

**Definition of Done**

Fresh clone запускается по README без ручного создания ресурсов; все три process roles собираются и завершаются корректно; CI зелёный; незавершённые routes отсутствуют в UI; система остаётся runnable при отключённом worker, показывая корректную readiness/degraded диагностику.

### Этап 1. Регистрация, согласия и подтверждение email end-to-end

**Goal**

Пользователь 18+ регистрируется с одной формальной ролью и четырьмя отдельными согласиями, получает письмо, подтверждает email и получает активный аккаунт с draft-профилем и основным резюме.

**Requirements covered**

FR-001—FR-005, FR-008—FR-012, FR-152—FR-155; BR-001, BR-002; EC-002, EC-003, EC-003a, EC-003b; ERR-001, ERR-002, ERR-003a; NFR-001, NFR-006, NFR-011, NFR-022; TNFR-006, TNFR-009—TNFR-011; ADR-003, ADR-004, ADR-011, ADR-012.

**Backend changes**

- Реализовать `Identity.register`, одноразовое подтверждение email, consent guards и атомарное создание account/credential/consents/profile/primary resume/outbox.
- Добавить Argon2id, normalization и role/domain validation, anti-enumeration, rate limits, `EmailSender` port, outbox dispatcher, deliveries/inbox, retry/DLQ и legal-evidence consumer.
- Передавать в legal DB только HMAC subject token и минимальные доказательства; недоступность legal consumer не активирует аккаунт, пока proof не подтверждён.

**Frontend changes**

- Реализовать registration wizard с четырьмя непредустановленными consent controls, role-shaped полями, страницами «проверьте почту», повторной отправки и подтверждения.
- Явно объяснять неподтверждённое состояние, требования `@mpei.ru` и отсутствие проверки фактической роли.

**DB changes**

- Добавить `identity.accounts`, `credentials`, `auth_tokens`, `consent_statuses` и минимальную `sessions`, необходимую опубликованному contract подтверждения email; полный login/logout/CSRF/reset lifecycle остаётся этапу 2.
- Добавить draft roots `profiles.profiles`, `profiles.resumes` и initial draft `profiles.profile_versions`, чтобы без временных колонок сохранить обязательный `RegistrationRequest.profile`; moderation/publication lifecycle этой таблицы остаётся этапу 4.
- Добавить `platform.idempotency_records`, `outbox_events`, `outbox_deliveries`, identity inbox и отдельную legal DB с `legal.consent_evidence`; constraints и retention jobs из data model.

**API changes**

- Реализовать `POST /auth/registrations`, `POST /auth/email-verifications`, `POST /auth/email-verifications/resend`, `GET /me` в точном соответствии с OpenAPI.

**Tests**

- Unit: email/domain/role/consent/password rules и document versions.
- Integration/API: единая транзакция регистрации, email duplicate race, token one-time/expiry, idempotency replay/mismatch, Redis/email/legal outage и reconciliation.
- Playwright: happy path для трёх ролей, неверный домен, отсутствующее согласие, истёкшая ссылка и resend.

**Dependencies**

Этап 0; до production нужны утверждённые версии документов согласия и email provider, но локально используются contract-faithful adapters.

**Definition of Done**

Регистрация и активация проходят end-to-end; неподтверждённый пользователь не получает full access; primary resume создаётся ровно один раз; повтор запроса не создаёт дублей; legal evidence не содержит profile/email/content.

### Этап 2. Вход, выход, CSRF и восстановление доступа end-to-end

**Goal**

Пользователь безопасно входит, получает server-side opaque session, выходит и восстанавливает пароль через email; revoke немедленно прекращает HTTP-доступ.

**Requirements covered**

FR-006, FR-007, FR-011, FR-152, FR-160; EC-001; ERR-003; NFR-001—NFR-003; TNFR-009; ADR-003, ADR-012.

**Backend changes**

- Реализовать opaque session hashing/rotation/revoke, CSRF secret, Origin allowlist, state/consent guards и password-reset flow с revoke всех прежних sessions.
- Добавить rate limits по IP/account key; при недоступности distributed limiter auth commands fail closed.

**Frontend changes**

- Реализовать login, logout, forgot/reset password и session bootstrap через `GET /me`/`GET /auth/csrf`.
- Развести UX состояний `unverified`, `active`, `deleting`; защищённые layouts не полагаются только на client checks.

**DB changes**

- Расширить созданную на этапе 1 `identity.sessions` для login/logout/CSRF/reset lifecycle; добавить cleanup для tokens/sessions и обновление `last_login_at`.

**API changes**

- Реализовать `GET /auth/csrf`, `POST /auth/sessions`, `DELETE /auth/session`, `POST /auth/password-resets`, `POST /auth/password-resets/confirm`.

**Tests**

- Integration/API: cookie flags, CSRF/Origin, generic auth errors, session expiry/revoke, concurrent reset, password reuse и forbidden state matrix.
- Playwright: login/logout/reset; проверка, что protected content недоступен гостю и неподтверждённому аккаунту.

**Dependencies**

Этап 1.

**Definition of Done**

Все identity routes соответствуют OpenAPI; raw session/reset secrets нигде не хранятся и не логируются; logout/reset немедленно отзывают доступ; система остаётся stateless между API instances.

### Этап 3. Безопасная загрузка и получение изображения end-to-end

**Goal**

Активный пользователь загружает JPEG/PNG/WebP напрямую в quarantine, получает sanitized private object и может запросить short-lived download URL только при наличии object-level права.

**Requirements covered**

FR-017, FR-047, FR-049, FR-118, FR-119; BR-018, BR-018a; EC-017; ERR-013, ERR-013a; NFR-009, NFR-016; TNFR-009, TNFR-010; ADR-007, ADR-012, ADR-015.

**Backend changes**

- Реализовать `Files` owner contracts, immutable scopes, presigned quarantine upload и worker pipeline: magic bytes/MIME, decode, malware scan, EXIF removal, Full HD/1 MiB resize, move to private media.
- Ввести S3 tombstone, quarantine/session cleanup и authorization для download URL; private scope не имеет dependency path к moderation adapter.

**Frontend changes**

- Создать reusable upload control со status polling, preview только после `technically_ready`, понятными ошибками формата/размера/обработки и безопасным retry.

**DB changes**

- Добавить `files.upload_sessions`, `media_objects`, `media_bindings`, `media_deletion_tombstones` и Files inbox; индексы и state constraints из data model.

**API changes**

- Реализовать `POST /uploads`, `POST /uploads/{uploadId}/complete`, `GET /uploads/{uploadId}`, `GET /media/{mediaId}/download-url`.

**Tests**

- Integration: spoofed MIME, oversized/decompression-bomb/malware input, EXIF removal, resize, duplicate complete, expired upload, scope/owner mismatch, signed URL TTL и cross-account 404.
- Resilience: S3/worker outage не даёт ложного `ready`; cleanup/tombstone replay безопасен.

**Dependencies**

Этап 2; локальный MinIO и malware scanner adapter.

**Definition of Done**

Безопасное изображение проходит upload-to-download journey; опасный объект не покидает quarantine и недоступен пользователю; object key не содержит PII; p95 обработки проверяется относительно лимита 5 секунд.

### Этап 4. Профиль, основное резюме и автомодерация end-to-end

**Goal**

Пользователь заполняет профиль и основное резюме, выбирает канонические теги и опциональные изображения, отправляет версию на обязательную автомодерацию и после одобрения открывает её другим вошедшим пользователям.

**Requirements covered**

FR-013—FR-019, FR-024—FR-032, FR-132—FR-137; BR-003, BR-005, BR-006, BR-021, BR-022; EC-020; ERR-004, ERR-006, ERR-016; NFR-004, NFR-010, NFR-012; ADR-005, ADR-011.

**Backend changes**

- Реализовать `Catalog`, `Profiles` и `Trust` automated moderation ports: immutable versions, one-pending-version guard, text+public-media gate, primary/secondary generation CAS, circuit breaker и fail-closed pending state.
- Добавить generic in-app notification/email consumers для moderation results и базовый Notifications query model; provider violation codes нормализовать к версии prohibited-content policy.

**Frontend changes**

- Реализовать собственный profile/resume editor, tag picker, moderation status/reason, last-approved preview и публичный profile screen.
- Добавить notification center/read state; при задержке moderation показывать pending, не publication success.

**DB changes**

- Добавить `catalog.versions/tags` с воспроизводимым seed ровно 180 записей.
- Расширить созданную на этапе 1 `profiles.profile_versions` полным moderation/publication lifecycle; добавить resume version/project/tag tables, `trust.moderation_requests`, `moderation_decisions`, `notifications.notifications`, `email_deliveries` и consumer inboxes.

**API changes**

- Реализовать `GET/PATCH /me/profile`, `GET /profiles/{accountId}`, `GET /me/resumes`, `GET /me/resumes/{resumeId}`, `PATCH /me/resumes/{primaryResumeId}` и `GET /catalog/tags`.
- Реализовать `GET /notifications`, `PATCH /notifications/{notificationId}`, `POST /notifications/read-all`.

**Tests**

- Unit: role-shaped profile fields, limits, tag catalog and public-version state machines.
- Integration/API: stale `If-Match`, competing edits, provider failover/late callback, media+text gate, last-approved visibility, private-scope rejection и notification/email dedup.
- Playwright: заполнение/публикация для трёх ролей, возврат на доработку, пустой/ошибочный provider state, public view без email.

**Dependencies**

Этапы 1—3; до production — два одобренных moderation endpoints и зафиксированная policy version.

**Definition of Done**

Approved профиль и primary resume доступны только active users; pending/rejected версия не утечёт; private media технически не может попасть к provider; каталог содержит утверждённые 180 тегов; результаты модерации доставляются без влияния email failure на business state.

### Этап 5. Дополнительные резюме и управление видимостью end-to-end

**Goal**

Пользователь создаёт до пяти целевых резюме, редактирует, скрывает и удаляет их, а другой пользователь видит только опубликованные и разрешённые версии.

**Requirements covered**

FR-020—FR-023, FR-027, FR-028; BR-003—BR-005; EC-004—EC-006; NFR-004, NFR-008.

**Backend changes**

- Реализовать slot 1..5 lifecycle, primary visibility invariant, publication/edit/delete commands и snapshot-independent deletion semantics.

**Frontend changes**

- Добавить список шести slots, create/edit/visibility/delete journeys, limit feedback и различие own/private/public presentation.

**DB changes**

- Использовать `UNIQUE(profile_id, slot)` и version constraints; новых cross-module таблиц не добавлять.

**API changes**

- Реализовать `POST /me/resumes`, распространить существующий `PATCH /me/resumes/{resumeId}` на additional slots, реализовать `DELETE /me/resumes/{resumeId}` и расширить public profile response видимыми additional resumes.

**Tests**

- Integration/API: concurrent sixth resume, primary hide/delete rejection, stale update, hidden resume 404 для постороннего, delete while moderation pending.
- Playwright: create/edit/hide/show/delete additional resume на mobile/desktop.

**Dependencies**

Этап 4.

**Definition of Done**

Шестое дополнительное резюме невозможно создать даже в гонке; primary всегда видимо; hidden resume не появляется в public response; завершённые сценарии профиля не регрессируют.

### Этап 6. Поиск людей и активность за 30 дней end-to-end

**Goal**

Активный пользователь ищет людей только по ФИО, сочетает разрешённые фильтры и сортирует по скрытому показателю активности, различая пустую выдачу и сбой.

**Requirements covered**

FR-019, FR-022, FR-023, FR-033—FR-035, FR-042, FR-043; BR-007, BR-024; EC-005, EC-007; ERR-005; NFR-016; TNFR-001—TNFR-003.

**Backend changes**

- Реализовать activity-day recording и Search people projection через outbox/inbox с monotonic `sourceRevision`, incremental 30-day maintenance и authorized cursor query.
- Исключить email, hidden/pending content и absolute activity score; дать bounded rebuild command вне peak path.

**Frontend changes**

- Добавить people search, комбинируемые filters/sort, URL query state, reset, loading/empty/error states и переход в профиль.

**DB changes**

- Добавить `profiles.activity_days`, `search.people_documents`, `pg_trgm`/GIN/B-tree indexes из data model и Search inbox.

**API changes**

- Реализовать `GET /search/people` с signed cursor/filter hash и unknown enum fallback на клиенте.

**Tests**

- Unit: activity formula/timezone/tie-breakers.
- Integration/API: hidden/pending projection, stale event, cursor tamper/filter mismatch, all/any tags, deterministic pagination и query plan.
- Load/Playwright: 10k projections в p95 budget; empty/error UI и keyboard filters.

**Dependencies**

Этапы 4—5.

**Definition of Done**

Поиск выдаёт только approved visible данные, сортировка точна и не раскрывает score, projection восстанавливается из источников, p95 поиска не превышает 2 секунд на целевом dataset.

### Этап 7. Личное объявление: публикация и полный lifecycle end-to-end

**Goal**

Пользователь создаёт личное объявление с изображением и тегами, проходит модерацию, просматривает approved версию, редактирует без потери последней публикации, снимает и удаляет объявление.

**Requirements covered**

FR-044—FR-058; BR-008, BR-009, BR-021; EC-008, EC-020; ERR-006, ERR-011; NFR-010.

**Backend changes**

- Реализовать `Opportunities` personal-author aggregate, 23 type codes, owner authorization, immutable versions, moderation/public-media gate, deactivation и restartable object deletion.
- Добавить maintenance job снятия объявлений после двух месяцев без login и события для notification/search consumers.

**Frontend changes**

- Добавить create/edit/preview/status/manage screens, type `other`, last-approved presentation, deactivation и подтверждение deletion.

**DB changes**

- Добавить `opportunities.opportunities`, `opportunity_versions`, `opportunity_version_tags`, required constraints/indexes и deletion workflow rows для content subject.
- Впервые добавить generic `compliance.deletion_workflows`/`deletion_steps`; пока включить только content subject и минимальные idempotent checkpoints, чтобы удаление объявления уже в этом slice было реальным, а не временным soft-delete.

**API changes**

- Реализовать `POST /opportunities`, `GET/PATCH/DELETE /opportunities/{opportunityId}`, `GET /me/opportunities`, `POST /opportunities/{opportunityId}/deactivation`.

**Tests**

- Unit/integration: type/field/tag/media limits, ownership masking, competing versions, last-approved behavior, deactivation, inactivity job и idempotent deletion replay.
- Playwright: create-to-public, edit-pending, reject/revise, deactivate/delete.

**Dependencies**

Этапы 3—4.

**Definition of Done**

Личное объявление проходит полный lifecycle без ручного DB вмешательства; неapproved version не видна; после deactivation/deletion она исчезает из чтения; maintenance job безопасно повторяется.

### Этап 8. Каталог объявлений, просмотры и популярность end-to-end

**Goal**

Пользователь ищет опубликованные объявления по названию и тегам, фильтрует личных авторов и сортирует по новизне или точной скрытой популярности.

**Requirements covered**

FR-036—FR-043, FR-051—FR-054; BR-007, BR-008, BR-024; EC-007—EC-009; ERR-005; NFR-016; TNFR-003.

**Backend changes**

- Реализовать idempotent unique-view facts, Opportunity Search projection, пересчёт при смене профиля автора и incremental 30-day aggregates.
- Исключать действия автора; подготовить membership hook для исключения команды в этапе 16.

**Frontend changes**

- Добавить catalog/search screen, cards with author kind, filters/sort/reset, empty/error states и переход к актуальному профилю автора.

**DB changes**

- Добавить `opportunity_view_days`, `search.opportunity_documents`, full-text/GIN/popularity/newest indexes и maintenance retention.

**API changes**

- Реализовать `GET /search/opportunities`; расширить `GET /opportunities/{id}` записью view fact без раскрытия popularity.

**Tests**

- Unit: popularity formula, exclusions and tie-breakers.
- Integration/API: title-only search, filters, view dedup, author profile reprojection, cursor integrity, 404 hidden content и query plans.
- Load/Playwright: целевой dataset, p95 ≤2 секунд, empty/error differentiation.

**Dependencies**

Этапы 6—7.

**Definition of Done**

Каталог отражает изменения не позднее operational target, не показывает score и неподходящие версии; rebuild сходится с incremental projection; поиск остаётся в SLO.

### Этап 9. Отклик, повтор и необратимое решение end-to-end

**Goal**

Кандидат отправляет snapshot выбранного резюме, получатель видит pending отклик и необратимо принимает либо отклоняет его; обе стороны получают in-app/email уведомления независимо от доставки side effects.

**Requirements covered**

FR-061—FR-073, FR-078—FR-084; BR-004, BR-010—BR-014; EC-005, EC-006, EC-010—EC-012, EC-010a, EC-014; ERR-007, ERR-008, ERR-010, ERR-018; NFR-006—NFR-008.

**Backend changes**

- Реализовать `Recruitment` snapshot/create/atomic replace/decision flows, cooldown by DB time, CAS и durable application facts.
- Ввести canonical interaction locking contract, application notifications/email и cleanup завершённых записей без permanent history.

**Frontend changes**

- Добавить apply dialog с выбором любого собственного resume, recipient pending inbox в notification journey, snapshot viewer, decision UI и `eligibleAt` feedback.

**DB changes**

- Добавить `recruitment.applications`, `resume_snapshots`, `application_facts`, Recruitment inbox и business-key/queue/cooldown indexes.
- Добавить `trust.interaction_pairs` для сериализации будущих block-aware commands.

**API changes**

- Реализовать `POST/GET /opportunities/{opportunityId}/applications`, `GET /applications/{applicationId}`, `POST /applications/{applicationId}/decision`.

**Tests**

- Integration/concurrency: self-apply, immutable hidden resume snapshot, early/exact-boundary reapply, atomic replacement, double decision, accepted reapply prohibition, deleted opportunity/candidate и email/worker outage.
- Playwright: apply → recipient review → accept/reject → notifications; отсутствие постоянной history page.

**Dependencies**

Этапы 5, 7 и notification infrastructure этапа 4.

**Definition of Done**

Повтор и гонки дают одно согласованное состояние; snapshot не меняется после edit/delete resume; accepted/rejected commit не зависит от email; popularity facts учитывают кандидата ровно один раз в окне.

### Этап 10. Контекстный чат и текстовый realtime messaging end-to-end

**Goal**

После принятия личного отклика ровно один контекстный чат появляется асинхронно; пользователи также создают direct chat, отправляют текст и получают realtime hint с REST-refetch.

**Requirements covered**

FR-074—FR-077, FR-080, FR-115—FR-117, FR-129; EC-013; ERR-009, ERR-010; NFR-005, NFR-006, NFR-016, NFR-017; ADR-015.

**Backend changes**

- Реализовать idempotent `ensureContextConversation`, direct conversation, participants, text send/list и accepted-application chat retry.
- Добавить authenticated same-origin Socket.IO gateway, Redis fan-out, per-room authorization и hints без message body.

**Frontend changes**

- Добавить conversation list/detail, application context banner, text composer, `pending/failed/retry` состояния чата и reconnect indicator.
- Socket hints дедуплицировать по `eventId` и использовать только для TanStack Query invalidation/refetch.

**DB changes**

- Добавить `messaging.conversations`, `conversation_participants`, `messages`, Messaging inbox и context/direct UNIQUE keys.
- Связать application `conversation_status/id` только через публичные module contracts.

**API changes**

- Реализовать `POST /applications/{id}/conversation-retry`, `POST /conversations/direct`, `GET /conversations`, `GET /conversations/{id}`, `GET/POST /conversations/{id}/messages`.
- Реализовать realtime hints `message.created`, `conversation.updated`, `notification.created`.

**Tests**

- Integration/concurrency: worker retry creates one context chat, acceptance survives Messaging outage, direct pair dedup, unauthorized room/REST 404, revoked-session reconnect, cross-origin handshake.
- Playwright multi-context: accept → chat → exchange text; disconnect/reconnect/refetch; notification delivery timing.

**Dependencies**

Этапы 2 и 9.

**Definition of Done**

Accepted application всегда имеет recoverable chat state; retry сходится к одному conversation; realtime не является source of truth и не раскрывает content; text delivery соответствует p95 budgets.

### Этап 11. Фотографии, read/edit/delete и удаление чата end-to-end

**Goal**

Стороны чата отправляют до десяти готовых private photos, видят read state, редактируют/удаляют сообщение и выбирают удаление чата только у себя либо физически у обоих.

**Requirements covered**

FR-118—FR-125, FR-130; BR-018—BR-020, BR-018b, BR-018c; EC-017—EC-019, EC-017a; ERR-013, ERR-013a; NFR-005, NFR-009, NFR-016, NFR-020.

**Backend changes**

- Расширить send-message атомарным binding готовых private media и quota eviction только после успешного commit; реализовать edit/delete CAS и monotonic read cursor.
- Реализовать hide-for-me и restartable delete-for-both: block writes, invalidate evidence references, hard-delete messages/revisions/bindings и idempotently очистить S3.

**Frontend changes**

- Добавить multi-photo composer/status, read/edited/tombstone states, message edit/delete и обязательный выбор scope удаления conversation.
- Не показывать квоту 500 и предупреждение о вытеснении; удалённое вложение отображать как «Фотография больше не хранится».

**DB changes**

- Добавить `messaging.message_attachments`; расширить participant read/hidden fields и message moderation/tombstone fields.
- Использовать media quota index, deletion workflows/tombstones и evidence reverse-invalidation hook.

**API changes**

- Реализовать `PATCH/DELETE /messages/{messageId}`, `POST /conversations/{id}/read`, `DELETE /conversations/{id}?scope=me|both`; расширить send-message `mediaIds`.

**Tests**

- Integration/concurrency: all-ready rule, private scope, max 10, failed send never evicts, exact 501st photo, multi-attachment eviction, edit/delete/read CAS, delete scopes and S3 reconciliation.
- Playwright: photo message, edited/read markers, both deletion scopes; media processing p95 ≤5 seconds.

**Dependencies**

Этапы 3 и 10.

**Definition of Done**

Неполная/опасная фотография не создаёт message; quota соблюдается без UI leakage; delete-for-me не влияет на вторую сторону; delete-for-both физически очищает content/media и безопасно возобновляется после сбоя.

### Этап 12. Личный чёрный список и атомарный запрет взаимодействий end-to-end

**Goal**

Пользователь блокирует другого пользователя, сохраняя историю, и атомарно предотвращает новые чаты, сообщения, отклики и будущие membership interactions.

**Requirements covered**

FR-125—FR-127; BR-019, BR-020; ERR-014, ERR-018; NFR-003, NFR-005—NFR-007; ADR-011.

**Backend changes**

- Реализовать personal block/unblock/list и shared transaction orchestrator, который сериализует block/message/application на canonical interaction pair через public module contracts.
- Закрывать pending cross-user interactions по утверждённым правилам, не удаляя conversation history.

**Frontend changes**

- Добавить block management, actions из профиля/чата и объяснимые blocked states без раскрытия чужих списков.

**DB changes**

- Добавить `trust.personal_blocks`; переиспользовать `interaction_pairs` и deterministic lock order.

**API changes**

- Реализовать `GET /me/blocks`, `PUT/DELETE /me/blocks/{accountId}`; применить `INTERACTION_BLOCKED` ко всем уже реализованным interaction commands.

**Tests**

- Concurrency: block vs message/apply/chat creation в обоих commit orders, deadlock/serialization retry, unchanged history, idempotent block/unblock и account cleanup.
- Security/Playwright: чужой blacklist недоступен; blocked action имеет безопасный русский UX.

**Dependencies**

Этапы 9—11.

**Definition of Done**

После commit block ни одно новое запрещённое взаимодействие не может commit; более ранняя операция либо завершена целиком, либо отклонена; нет cross-schema repository imports.

### Этап 13. Профиль команды end-to-end

**Goal**

Любой активный пользователь создаёт команду, становится её неизменяемым единственным лидером, проходит модерацию профиля и управляет approved представлением.

**Requirements covered**

FR-085—FR-088, FR-092—FR-094, FR-101; BR-015—BR-017; EC-015c; NFR-003, NFR-010.

**Backend changes**

- Реализовать `Teams` aggregate, leader-only commands, immutable moderated versions/projects/tags/media и active/draft visibility.
- Переиспользовать moderation/notification pipelines; не вводить representatives, ownership transfer или member management rights.

**Frontend changes**

- Добавить create/edit/view/my teams screens с явным leader state и moderation feedback.

**DB changes**

- Добавить `teams.teams`, `team_versions`, `team_projects`, `team_version_tags` и Teams inbox; constraints неизменяемого leader.

**API changes**

- Реализовать `POST /teams`, `GET/PATCH /teams/{teamId}`, `GET /me/teams` для relation `leader`.

**Tests**

- Integration/API: one immutable leader, member permissions absent, stale edits, moderation last-approved behavior, hidden draft masking.
- Playwright: create → moderation → public team → edit.

**Dependencies**

Этапы 3—4.

**Definition of Done**

Команда создаётся с одним лидером и доступна после approval; участник не может выполнить leader command даже прямым API; transfer endpoints и representatives отсутствуют.

### Этап 14. Вступление, приглашения и состав команды end-to-end

**Goal**

Пользователь добровольно вступает по заявке со snapshot резюме либо принимает приглашение; лидер принимает решение, управляет составом, а гонки сохраняют первое подтверждённое состояние.

**Requirements covered**

FR-089—FR-093; BR-004, BR-015, BR-016, BR-016a; EC-015a—EC-015c, EC-015b; ERR-011a, ERR-018; NFR-006, NFR-008.

**Backend changes**

- Реализовать join request/withdraw/decision с 7-day cooldown, invitations/revoke/decision, membership creation/removal/leave и event-specific notifications/email.
- Сериализовать membership/invitation/request/block через canonical locks; leader never becomes ordinary member.

**Frontend changes**

- Добавить join form с resume+contribution, applicant status, leader queues/snapshot viewer, invitation inbox и member list/actions.

**DB changes**

- Добавить `teams.memberships`, `join_requests`, `invitations` с current-only/history cleanup constraints/indexes.

**API changes**

- Реализовать `GET /teams/{id}/members`, `DELETE /teams/{id}/members/{accountId}`, `POST /teams/{id}/leave`.
- Реализовать join-request и invitation endpoints из OpenAPI, включая `GET /me/team-invitations`.
- Расширить `GET /me/teams` relation `member`, не меняя уже выпущенную leader semantics.

**Tests**

- Integration/concurrency: duplicate/expired request, exact cooldown, immutable snapshot, accept vs withdraw/revoke/remove, voluntary invitation acceptance, leader self-actions, notification dedup and outage.
- Playwright: request/decision/leave и invite/accept/remove journeys.

**Dependencies**

Этапы 5, 12 и 13.

**Definition of Done**

Membership появляется только после добровольного user action; каждый source закрывается атомарно; leader остаётся единственным manager; завершённые request/invitation не образуют permanent history UI.

### Этап 15. Подписка на команду, событие и календарь end-to-end

**Goal**

Пользователь подписывается на команду и видит её approved события в календаре; лидер создаёт, изменяет и отменяет событие, а подписчики получают уведомления.

**Requirements covered**

FR-097—FR-099, FR-104—FR-114; BR-025; EC-016; ERR-012; NFR-006, NFR-016, NFR-017, NFR-021.

**Backend changes**

- Реализовать subscriptions, follower projection, `Scheduling` versioned/moderated event lifecycle, valid IANA timezone conversion, date-range calendar и notification/email events.
- Отписка немедленно меняет calendar source; recurrence/reminders не вводить.

**Frontend changes**

- Добавить subscribe controls, leader subscriber list/profile links, event editor/status, team events management и календарь с явным timezone.

**DB changes**

- Добавить `teams.subscriptions`, `scheduling.team_events`, `team_event_versions`, tag rows и Scheduling inbox/indexes.

**API changes**

- Реализовать subscription/subscriber endpoints, `POST/GET /teams/{id}/events`, `GET/PATCH/DELETE /events/{id}`, cancellation и `GET /calendar`.

**Tests**

- Unit: UTC/IANA conversion, DST and range validation.
- Integration/API: subscription idempotency, unsubscribe visibility, event moderation/edit/cancel/delete, follower notifications, cursor/date-range query plan.
- Playwright: subscribe → event appears → update/cancel notification → unsubscribe removes it.

**Dependencies**

Этапы 4 и 13.

**Definition of Done**

Календарь однозначно показывает выбранный timezone, содержит только current subscriptions/approved events и укладывается в profile/calendar p95; повторяющиеся события и reminders отсутствуют.

### Этап 16. Командное объявление, командный отклик, чат и blacklist end-to-end

**Goal**

Лидер публикует объявление команды, рассматривает отклики, общается с принятым кандидатом от имени команды и блокирует нежелательного пользователя на уровне команды.

**Requirements covered**

FR-039, FR-052, FR-059, FR-060, FR-067, FR-069—FR-077, FR-094—FR-096, FR-100, FR-116, FR-128; BR-008, BR-010, BR-016; EC-009, EC-013; ERR-009, ERR-014.

**Backend changes**

- Расширить Opportunities/Recruitment author kind `team`, leader authorization, exclusion leader+members from apply/popularity и team-recipient pending queue.
- Создавать единственный team-application conversation с candidate и current leader participant; запретить leader доступ к личным чатам members.
- Реализовать team block/unblock/list, который атомарно rejects join request, revokes invitation и запрещает team apply/new context chat, сохраняя history.

**Frontend changes**

- Добавить team opportunity management/review inbox, team mini-profile attribution, candidate-to-team chat и leader blacklist UI.

**DB changes**

- Использовать существующие polymorphic opportunity/application/conversation rows; добавить `teams.team_blocks` и нужные team interaction keys.
- Обновить Search projection: team author organizational filters всегда null, member actions исключены из popularity.

**API changes**

- Расширить существующие opportunity/application/chat endpoints team semantics.
- Реализовать `GET /teams/{id}/blocks`, `PUT/DELETE /teams/{id}/blocks/{accountId}`.

**Tests**

- Integration/concurrency: only current leader manages/reviews/reads team chat, member cannot apply, team filters invalid, block vs apply/request/invite/message, one context chat, leader change impossible.
- Playwright: team publish → external apply → leader accept → team chat; block prevents new interactions.

**Dependencies**

Этапы 8—10 и 13—14.

**Definition of Done**

Командный journey работает без копирования team data между schemas; права всегда вычисляются через Teams contract; личные чаты участников недоступны лидеру; blacklist действует атомарно на все team interactions.

### Этап 17. Жалоба, ручная проверка и апелляция end-to-end

**Goal**

Пользователь жалуется на допустимый объект или подмену личности, назначенный модератор рассматривает evidence с минимальными правами, возвращает контент на доработку, а владелец один раз обжалует решение.

**Requirements covered**

FR-131—FR-142, FR-156—FR-159; EC-020—EC-021a, EC-020a, EC-021; ERR-015, ERR-016, ERR-016a; NFR-005, NFR-010, NFR-011, NFR-024; TNFR-010—TNFR-012; ADR-005, ADR-007, ADR-012, ADR-014.

**Backend changes**

- Реализовать report/status/claim/decision, one-open-report guard, impersonation/ordinary deadlines, priority escalation и field-filtered views.
- Для message report атомарно создать current reported revision и evidence references без копирования content в audit; private content никогда не отправлять automated provider.
- Реализовать narrow moderator permissions, evidence access audit, manual re-review после moderator return, appeal edit lock и terminal uphold/overturn state machines.

**Frontend changes**

- Добавить report forms/status, owner reason/revision/appeal UX и moderator queues for reports/reviews/appeals с claim, deadlines, escalation и evidence-unavailable state.

**DB changes**

- Добавить `identity.permission_grants`, `messaging.reported_revisions`, `trust.reports`, evidence/items, manual_reviews, appeals; расширить decisions и content roots edit locks.
- Добавить `compliance.audit_entries` для moderation/permission/evidence metadata.

**API changes**

- Реализовать все endpoints раздела Reports, appeals and moderator API в OpenAPI: `/reports`, `/me/reports`, `/moderation-decisions/.../appeals`, `/me/appeals`, moderator report/review/appeal lists, claims, evidence и decisions.

**Tests**

- Integration/security: one open report, 12h/24h/48h/72h deadlines, claim/permission matrix, evidence access audit/redaction, source deletion → unavailable, no backup restore, competing decisions, one appeal, edit lock and overturn.
- Architecture: compile/runtime prohibition `Messaging -> ContentModerator` and private scope.
- Playwright: complaint → moderator decision → correction/manual review или appeal; SLA/escalation display.

**Dependencies**

Этапы 4, 11 и 12; до production — назначенные moderator permissions и operational owners.

**Definition of Done**

Ни один moderation outcome не удаляет content; confirmed content скрывается/возвращается на revision; evidence видит только assignee с `evidence.view`; audit не содержит content; задержка никогда не приводит к auto-approval.

### Этап 18. Privacy requests, удаление аккаунта и каскады end-to-end

**Goal**

Пользователь запрашивает export/correction/restriction/deletion, аккаунт немедленно скрывается, deletion можно отменить 7 суток, затем restartable workflow физически очищает все данные не позднее 30 суток и оставляет только минимальное legal proof.

**Requirements covered**

FR-057, FR-084, FR-102, FR-103, FR-113, FR-124, FR-130, FR-143—FR-151, FR-160; BR-017, BR-020, BR-023, BR-023a; EC-015, EC-022, EC-023; ERR-017; NFR-011, NFR-022; TNFR-007, TNFR-008, TNFR-010, TNFR-011; ADR-006, ADR-007, ADR-012.

**Backend changes**

- Реализовать privacy request registry, re-authenticated account deletion, immediate hide/session revoke/socket disconnect, 7-day restore и high-water-mark export.
- Завершить generic deletion orchestrator для account/team/content/conversation: checkpoints hide/revoke/notify/domain cleanup/media/search/audit/legal proof/hard delete, bounded batches and retries.
- Удалять led teams, opportunities/events/chats/applications/memberships/search/outbox PII/media; legal DB получает только HMAC consent/destruction evidence с retention ≤3 years.

**Frontend changes**

- Добавить settings flows для четырёх request types, re-auth, status/deadline, one-time export URL, deleting-only screen и cancellation before irreversible point.

**DB changes**

- Добавить `compliance.privacy_requests`; расширить введённые в этапе 7 `deletion_workflows`/`deletion_steps` subject types и checkpoints для team/conversation/account; добавить legal destruction evidence и retention cleanup.
- Проверить cascade ownership и reverse indexes; backup user-data retention установить ≤21 day.

**API changes**

- Реализовать `POST/GET /privacy-requests`, `GET /privacy-requests/{id}`, `GET .../result-url`, `POST .../cancel`.
- Реализовать `DELETE /teams/{teamId}` и довести ранее добавленные `DELETE` opportunity/event/conversation до общего restartable workflow semantics.

**Tests**

- Time-controlled integration: immediate hide, command guard in deleting, restore at/before boundary, irreversible boundary, retry every step, leader/team cascade, export authorization/expiry and evidence purge.
- Destructive rehearsal on isolated test data: DB, Redis jobs, S3 objects, search, audit/outbox payloads и backup-retention evidence; никаких post-deletion message/media snapshots.
- Playwright: request deletion → restricted state → restore; export request → one-time download.

**Dependencies**

Этапы 1—17; до production — выполнение BR-023a и юридически утверждённые retention/policy тексты.

**Definition of Done**

Deletion workflow можно безопасно перезапустить с любого checkpoint; после irreversible completion пользовательские данные отсутствуют во всех runtime stores и исчезают из backups в пределах 30 дней от исходного запроса; legal evidence изолировано и не позволяет восстановить профиль/content.

### Этап 19. Production hardening, отказоустойчивость и release gate

**Goal**

Доказать, что полный MVP выдерживает целевую нагрузку, безопасно деградирует, восстанавливается и откатывается, после чего закрыть production readiness checklist доказательствами и владельцами.

**Requirements covered**

NFR-016—NFR-024; TNFR-001—TNFR-014; BR-023a; ADR-006, ADR-008, ADR-012—ADR-015; `docs/production/readiness.md`, `runbook.md`, `rollback.md`.

**Backend changes**

- Завершить OpenTelemetry instrumentation, SLO metrics/alerts, bounded pools/concurrency, DLQ/manual replay, maintenance schedules и health semantics для всех modules/providers.
- Провести security/privacy redaction review, dependency/container/SBOM scanning, secret rotation и failure-mode remediation без изменения product semantics.
- Выпустить immutable Docker images и versioned IaC для public edge, двух local application failure domains, private data network и cold DR target в РФ; настроить rolling deployment без sticky sessions и отдельные service identities для API/worker/legal access.

**Frontend changes**

- Выполнить cross-browser responsive/accessibility pass всех основных journeys, network/reconnect/degraded-state UX и additive API compatibility verification.

**DB changes**

- Проверить все constraints/indexes/query plans, backup automation PostgreSQL/legal/media, 21-day user backup retention, expand/migrate/contract history и restore integrity checks.

**API changes**

- Зафиксировать release snapshot OpenAPI 1.0; пройти breaking-change gate, old-client/new-API и new-client/old-API tests; исправления только additive либо через отдельное ADR/new major.

**Tests**

- Mixed peak/soak: 30 RPS, 5 write RPS, 200 Socket.IO connections, search/messages/media/applications/notifications/moderation/outbox; запас ≥30% DB/worker capacity.
- Chaos/recovery: Redis, worker, email, primary moderation, оба moderation endpoints, S3, PostgreSQL failover и одна app failure domain.
- Квартальный-style cold DR rehearsal в отдельном target: RPO ≤24h, RTO ≤8h; local failover objective ≤15m; rollback rehearsal ≤30m.
- Полный Playwright browser matrix и security gate: CSRF/Origin/CSWSH, room/object auth, media scope, evidence, deletion.

**Dependencies**

Этапы 0—18 и внешние release prerequisites из readiness checklist.

**Definition of Done**

Каждый пункт `docs/production/readiness.md` отмечен ссылкой на актуальный артефакт проверки и владельца исключения; нет unresolved critical security findings; SLO/capacity/recovery/rollback цели доказаны; runbook содержит реальные provider commands/contacts без secrets/PII; formal go/no-go завершён.

## 3. Контроль полноты и порядка

| Группа | Этапы, где достигается работоспособность |
|---|---|
| Identity, consent, sessions | 1—2 |
| Files и public/private media | 3, 4, 11 |
| Profiles, resumes, tags, people search | 4—6 |
| Personal opportunities, search, applications | 7—9 |
| Context/direct messaging, realtime, blocks | 10—12 |
| Teams, membership, subscriptions, events | 13—15 |
| Team opportunities/interactions | 16 |
| Reports, manual moderation, appeals | 17 |
| Privacy, deletion, legal evidence | 18 |
| Capacity, security, DR and release | 19 |

Каждый этап начинается только после выполнения Definition of Done всех зависимостей. Если реализация выявит конфликт с утверждённым требованием, этап останавливается в затронутой части: сначала обновляется requirements context, а архитектурно значимое изменение оформляется или актуализируется ADR. Scope нельзя молча расширять рекомендациями, external calendars, SSO МЭИ, marketing, video, recurring events, reminders, team representatives, ownership transfer, Elasticsearch, Kafka, Kubernetes или post-deletion evidence snapshots.
