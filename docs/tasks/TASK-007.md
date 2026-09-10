# TASK-007: Профиль, основное резюме и автомодерация end-to-end

Статус: реализована; unit, integration, build, lint и typecheck проходят. Полный format:check репозитория сохраняет четыре pre-existing предупреждения вне TASK-007; все изменённые в TASK-007 файлы проходят отдельную проверку Prettier.

Проверено по repository на 10.09.2026, commit `ac7adf0`. Следующий не реализованный шаг обязательного плана — этап 4 из `docs/plans/implementation-plan.md`. Этапы 0—3 представлены реализацией и отмечены завершёнными в `TASK-003`, `TASK-004` и `TASK-006`; lifecycle этапа 2 присутствует в коде, несмотря на неактуальный статус подготовки в `TASK-005`.

# Goal

Реализовать вертикальный slice этапа 4: активный пользователь редактирует собственный профиль и созданное при регистрации основное резюме, выбирает только канонические теги и опциональные публичные изображения, отправляет каждую immutable version на обязательную автомодерацию и видит её состояние. После одобрения профиль и primary resume становятся доступны другим вошедшим активным пользователям; во время проверки или после возврата на доработку наружу продолжает выдаваться только последняя одобренная версия.

В этот же slice входят product-managed каталог из ровно 180 тегов, первичная query model внутренних уведомлений и сервисное письмо о результате модерации. Сбой email, Redis, worker или moderation provider не должен откатывать сохранённую версию, давать ложный publication success или открывать не проверенный текст/media.

# Context

- `docs/plans/implementation-plan.md` требует выполнять этапы по порядку. Этап 4 зависит от этапов 1—3 и предшествует дополнительным резюме, поиску и остальным публичным сущностям.
- Регистрация уже создаёт `profiles.profiles`, draft `profiles.profile_versions` и primary row `profiles.resumes` со `slot = 0` через `ProfilesService.createInitialProfile()`. Таблицы/Prisma-модели для содержимого resume versions ещё отсутствуют.
- `ProfilesService` сейчас предоставляет только `createInitialProfile()` и `ownsMediaOwner()`. HTTP controller, input schemas, DTO mapping и publication/moderation state machine для Profiles отсутствуют.
- `backend/src/modules/catalog/index.ts`, `backend/src/modules/trust/index.ts` и `backend/src/modules/notifications/index.ts` содержат только `export {};`. Эти bounded contexts ещё не подключены к `AppModule` или `WorkerModule`.
- `api/openapi.yaml` уже публикует полный MVP contract, включая profile/resume/catalog/notification operations и операции дополнительных резюме. Наличие paths и сгенерированных типов не означает наличие runtime handlers.
- Stage 3 создал Files pipeline. `FilesWorkerService.#processSession()` переводит sanitized `public_content` media в `moderation_pending`; `publicStateFor()` сохраняет это публичное состояние. `FilesService.createDownloadUrl()` запрещает выдавать такое media до `approved`/`attached`.
- В `docs/context/requirements-log.md` зафиксировано: PostgreSQL хранит внутреннее `technically_ready`, API возвращает `ready` только для private media, а `public_content` до moderation approval остаётся `moderation_pending` и недоступен по download URL.
- Существующий `MediaUpload` рассчитан на немедленное получение download URL и вызывает `onReady(mediaId, downloadUrl)`. Для `public_content` этот flow не может завершиться до модерации и должен быть адаптирован без ослабления Files gate.
- `FilesService` сейчас зависит от публичного `ProfilesService` для `ownsMediaOwner()`. Реализация profile publication не должна добавить обратный импорт `Profiles -> Files` и тем самым создать запрещённый architecture cycle; синхронные проверки и binding должны быть организованы через ацикличные публичные contracts/composition.
- В `docs/product/appendix-prohibited-content.md` есть утверждённый перечень из 35 разделов с датой актуальности 17.08.2026, но в runtime пока нет стабильной policy version и нормализованных violation codes.
- До production план требует два одобренных независимо отказоустойчивых moderation endpoints. Локальная и test-конфигурация не должна притворяться таким production approval.

# Relevant requirements

- `FR-013—FR-017`: ФИО, роль и специализация обязательны; student требует институт и курс 1—6, teacher — кафедру, employer — компанию; avatar опционален.
- `FR-018`, `FR-024—FR-029`: primary resume содержит «Обо мне», до 10 проектов и до 20 тегов; `about` не длиннее 1024 символов; владелец может редактировать профиль и resume; описание работы студента на кафедре не требует смены formal role.
- `FR-019`, `BR-003`: primary resume всегда search-visible. Реализация Search projection относится к этапу 6, но Profiles не должна допускать невидимое состояние primary resume.
- `FR-028`, `FR-153`, `FR-154`: другой вошедший активный пользователь видит одобренный публичный профиль и разрешённые resume без email, password, переписки и иных закрытых данных; optional avatar, tags/about/projects публикуются только после заполнения и одобрения.
- `FR-030—FR-032`, `BR-006`: используется единый product-managed справочник ровно из 180 тегов из `docs/product/tag-catalog.md`; пользовательские теги запрещены.
- `FR-132—FR-137`, `BR-021`, `BR-022`: каждая новая версия публичного текста и связанного public media проходит автомодерацию до публикации; нарушение скрывает только новую версию, возвращает её на доработку и сообщает правило/объект; изменение отправляется на проверку повторно.
- `EC-020`: при ошибке или отказе автомодерации новая версия не публикуется, а последняя одобренная остаётся доступна.
- `ERR-004`, `ERR-006`, `ERR-016`: превышенный лимит называется явно; pending не выглядит как публикация; причина возврата содержит стабильное правило, объект и понятный способ повторной отправки.
- `NFR-004`: скрытые дополнительные resume не должны утечь. Хотя их создание относится к этапу 5, DTO/query code этапа 4 нельзя проектировать так, чтобы он игнорировал visibility.
- `NFR-010`: никакой public content не становится видимым до обязательного moderation approval.
- `NFR-012`, `NFR-023`: пользовательские ошибки и весь новый UI — на русском языке и с понятным следующим действием.
- `NFR-017`: при штатной работе internal notification доставляется не более чем за 10 секунд p95, email — не более чем за 5 минут p95; это проверяется без включения provider/email в business transaction.
- `ADR-004`: commit версии и transactional outbox выполняются атомарно; consumers работают at-least-once, фиксируют inbox marker вместе с эффектом и восстанавливаются из PostgreSQL, а не из Redis.
- `ADR-005`: использовать port `ContentModerator`, primary/secondary failover, endpoint-specific circuit breaker, стабильный provider idempotency key и generation/endpoint CAS; оба недоступных endpoint оставляют version в `pending`.
- `ADR-009`, `ADR-010`, `ADR-012`: `Catalog`, `Profiles`, `Trust`, `Notifications` и `Files` владеют своими schemas и публикуют только application/query contracts; запрещены чужие repositories/Prisma models, cross-schema SQL и передача private media, email или полного resume в telemetry.
- `ADR-011`: business invariants защищаются транзакцией, constraints, row lock/CAS, `Idempotency-Key` и `If-Match`; side effects не расширяют command transaction.
- `ADR-015`: REST `/api/v1` и `api/openapi.yaml` остаются source of truth; notification/moderation realtime hint не является источником business state. Socket.IO не требуется в этом этапе.

# Existing code

| Файл | Фактическое состояние |
|---|---|
| `backend/src/modules/profiles/application/profiles.service.ts` | `ProfilesService.createInitialProfile(transaction, accountId, formalRole, input)` создаёт profile, profile version `versionNo: 1` и primary resume; `ownsMediaOwner(accountId, ownerType, ownerId)` используется Files. Методов чтения/редактирования/публикации нет. |
| `backend/src/modules/profiles/profiles.module.ts` | Регистрирует и экспортирует только `ProfilesService`; controllers отсутствуют. |
| `backend/src/modules/profiles/index.ts` | Экспортирует `ProfilesModule`, `ProfilesService`, `FormalRole` и `InitialProfileInput`. Это текущий публичный entrypoint модуля. |
| `backend/prisma/schema.prisma` | Уже содержит `PublicationState`, `PublicVersionState`, `Profile`, `ProfileVersion` и `Resume`. `ResumeVersion`, projects и tag membership отсутствуют; datasource перечисляет только `identity`, `platform`, `profiles`, `files`. |
| `backend/prisma/migrations/20260904000100_registration_identity/migration.sql` | Создаёт текущие profile/resume roots, pointer columns и role validation trigger. Pointer ownership и resume-version FKs ещё невозможно выразить, потому что resume-version table отсутствует. |
| `backend/src/modules/catalog/index.ts` | Пустой shell (`export {};`); Catalog service/controller/seed отсутствуют. |
| `backend/src/modules/trust/index.ts` | Пустой shell; `ContentModerator`, requests, decisions, adapters и worker отсутствуют. |
| `backend/src/modules/notifications/index.ts` | Пустой shell; Notifications controller/query/consumers отсутствуют. |
| `backend/src/modules/files/application/files.service.ts` | `createUploadSession()`, `completeUpload()`, `getUploadSession()`, `createDownloadUrl()` и `queueDeletion()` реализованы. Private `assertOwner()` вызывает `ProfilesService.ownsMediaOwner()`. Публичного contract для проверки, резервирования, binding и moderation transition public media нет. |
| `backend/src/modules/files/worker/files-worker.service.ts` | `#processSession()` sanitizes media и создаёт public `MediaObject` в `moderation_pending`; `#processTombstones()` и cleanup уже реализованы. Content moderation не запускается. |
| `backend/src/modules/files/files.types.ts` | Содержит `UploadCreateInput`, `UploadSessionView`, `DownloadUrlView`, `ContentScope`, `PublicUploadState`, owner types и media states. Типа результата public-media binding/moderation пока нет. |
| `backend/prisma/migrations/20260908000100_files_media/migration.sql` | Уже создаёт `files.media_objects` и `files.media_bindings` с owner types `profile_version`/`resume_version`, public media states и scope constraints. Binding rows runtime-кодом пока не создаются. |
| `backend/src/modules/identity/http/session.guard.ts` | Глобальный `SessionGuard` по умолчанию требует active account, устанавливает `request.currentAccount`, ставит `Cache-Control: no-store` и проверяет CSRF у unsafe methods. |
| `backend/src/modules/identity/identity.types.ts` | `CurrentAccount` уже содержит `id`, `formalRole`, `systemRole`, account `state`, capabilities и timestamps; response DTO не содержит password/hash. |
| `backend/src/worker/outbox-worker.service.ts` | Dispatcher/lease/retry/DLQ уже работают, но `#handle()` жёстко перечисляет только verification email, password reset email и consent evidence consumers. Реестра moderation/notification consumers и отдельных resource queues нет. |
| `backend/src/app.module.ts` | Подключает `DatabaseModule`, `IdentityModule`, `FilesModule` и `HealthModule`; Catalog/Profiles HTTP/Trust/Notifications ещё не подключены отдельными feature modules. |
| `backend/src/worker/worker.module.ts` | Подключает `ComplianceModule`, `FilesModule`, `WorkerService` и `OutboxWorkerService`; moderation/notification workers отсутствуют. |
| `backend/src/platform/config/env.schema.ts` | Валидирует DB, Redis, S3, Files, SMTP, outbox и auth settings. Moderation endpoint, timeout, policy version и circuit-breaker settings отсутствуют. |
| `api/openapi.yaml` | Уже описывает `ProfileInput`, `Profile`, `PublicProfile`, `ResumeInput`, `Resume`, `ModerationStatus`, `TagCatalog`, `Notification` и требуемые paths. Generated contract должен изменяться только через этот файл. |
| `frontend/src/lib/api/generated.ts` | Уже содержит paths `/me/profile`, `/profiles/{accountId}`, `/me/resumes`, `/me/resumes/{resumeId}`, `/catalog/tags` и notification paths. Файл генерируется и не редактируется вручную. |
| `frontend/src/lib/api/client.ts` | Экспортирует typed `apiClient` на базе `openapi-fetch` с `baseUrl: '/api/v1'`. |
| `frontend/src/lib/idempotency.ts` | `prepareIdempotencyAttempt()` повторно использует key при том же canonical payload; его следует использовать для profile/resume/notification commands, не сохраняя keys в persistent browser storage. |
| `frontend/src/components/media-upload.tsx` | Реализует upload/poll/download UI. Текущий `MediaUploadProps.onReady(mediaId, downloadUrl)` не подходит для public media, которое законно останавливается в `moderation_pending`. |
| `frontend/src/app/account/layout.tsx` | `requireServerSession()` защищает только `/account`; profile/resume editor routes и public profile route отсутствуют. |
| `tests/architecture/module-boundaries.ts` | Проверяет imports чужой internal implementation/provider SDK и циклы между bounded contexts. Новые связи должны пройти этот test без исключений. |
| `infra/observability/files-alerts.yml`, `files-dashboard.json` | Уже покрывают техническую media processing/cleanup очередь, но не moderation provider, pending age и notification delivery. |

# Files likely affected

Существующие файлы, которые почти наверняка потребуют изменения:

- `backend/prisma/schema.prisma` и новая ordered migration `backend/prisma/migrations/<timestamp>_profile_moderation/migration.sql`.
- `backend/src/modules/profiles/application/profiles.service.ts`, `backend/src/modules/profiles/profiles.module.ts`, `backend/src/modules/profiles/index.ts`.
- Пустые public entrypoints `backend/src/modules/catalog/index.ts`, `backend/src/modules/trust/index.ts`, `backend/src/modules/notifications/index.ts`.
- `backend/src/modules/files/application/files.service.ts`, `backend/src/modules/files/files.module.ts`, `backend/src/modules/files/files.types.ts`, `backend/src/modules/files/index.ts` — только для ацикличного public-media verify/bind/decision contract; не переносить Profiles rules в Files.
- `backend/src/app.module.ts`, `backend/src/worker/worker.module.ts`, `backend/src/worker/outbox-worker.service.ts`.
- `backend/src/platform/config/env.schema.ts`, `.env.example`, `docker-compose.yml`, `infra/postgres/init-test-database.sql`.
- `api/openapi.yaml`, `api/openapi.release.yaml` и генерируемый `frontend/src/lib/api/generated.ts` — только если runtime выявит необходимое additive уточнение; release snapshot нельзя обновлять для сокрытия breaking change.
- `frontend/src/components/media-upload.tsx`, `frontend/src/lib/media-upload.ts`, `frontend/src/app/account/page.tsx`, `frontend/src/app/page.tsx`.
- `README.md`, `docs/production/runbook.md`, `infra/observability/prometheus.yml` и новые moderation/notification dashboard/alert artifacts.

Вероятные новые файлы внутри уже утверждённых bounded contexts:

- `backend/src/modules/profiles/http/profiles.controller.ts`, `backend/src/modules/profiles/profiles.schemas.ts`, `backend/src/modules/profiles/profiles.types.ts` и domain/application файлы publication state machine.
- `backend/src/modules/catalog/catalog.module.ts`, application service/controller и versioned seed artifact, полученный из `docs/product/tag-catalog.md`.
- `backend/src/modules/trust/trust.module.ts`, application service, `ContentModerator` port, primary/secondary infrastructure adapters, policy-code mapping и moderation worker/consumer.
- `backend/src/modules/notifications/notifications.module.ts`, application/query service, controller и idempotent in-app/email consumers.
- `frontend/src/app/account/profile/page.tsx`, route/editor для primary resume, `frontend/src/app/profiles/[accountId]/page.tsx`, `frontend/src/app/notifications/page.tsx` и feature-local components/schemas.
- `backend/tests/unit/profiles-*.test.ts`, `catalog-*.test.ts`, `moderation-*.test.ts`, `notifications-*.test.ts`; соответствующие integration tests и `tests/e2e/profile-moderation.spec.ts`.

Названия новых внутренних файлов могут быть скорректированы под получившийся cohesive design. Нельзя выдавать их за уже существующие или вводить общий cross-domain repository.

# API changes

- Реализовать существующие OpenAPI operations этапа 4:
  - `GET /me/profile` (`getOwnProfile`) — owner-only view с `published`, `pending`, `publicationState`, `moderation`, `editLocked`, `rowVersion` и `ETag`;
  - `PATCH /me/profile` (`updateOwnProfile`) — Active + owner, обязательные `X-CSRF-Token`, `Idempotency-Key`, `If-Match`; `202 Profile` после commit immutable pending version;
  - `GET /profiles/{accountId}` (`getPublicProfile`) — Active viewer, только одобренные profile/resume payloads, без email и owner-only state;
  - `GET /me/resumes` (`listOwnResumes`) и `GET /me/resumes/{resumeId}` (`getOwnResume`) — owner-only state. На этапе 4 фактически существует только primary slot 0;
  - `PATCH /me/resumes/{resumeId}` (`updateOwnResume`) — в этом этапе разрешён только ID primary resume; обязательны CSRF, Idempotency-Key и If-Match, ответ `202 Resume`;
  - `GET /catalog/tags` (`listTags`) — ровно 180 active tags, optional exact category filter, stable `sortOrder`, `ETag`/`If-None-Match`;
  - `GET /notifications` (`listNotifications`) — recipient-only cursor page, `createdAt DESC, id DESC`, filters `unreadOnly`/`type`;
  - `PATCH /notifications/{notificationId}` (`markNotificationRead`) — recipient-only `{read: true}`, CSRF, If-Match, optional idempotency key, повтор безопасен;
  - `POST /notifications/read-all` (`markAllNotificationsRead`) — recipient-only high-water `{before?}`, CSRF и обязательный idempotency key.
- Не реализовывать на этом этапе `POST /me/resumes`, `DELETE /me/resumes/{resumeId}` или изменение additional resume: эти paths уже опубликованы полным MVP OpenAPI, но относятся к этапу 5.
- `If-Match` сравнивается с текущим `rowVersion`. Устаревший или конкурентный writer получает согласованный `412 VERSION_MISMATCH`; отсутствие обязательного precondition — `428 PRECONDITION_REQUIRED`. `ETag` должен иметь документированный формат `"<rowVersion>"` во всех profile/resume/notification handlers.
- Повтор command с тем же actor/route/key и тем же canonical payload возвращает сохранённый результат и `Idempotency-Replayed: true`; тот же key с иным payload даёт `IDEMPOTENCY_KEY_REUSED`.
- Использовать уже опубликованные DTO, не возвращать Prisma-модели. Сохранять stable errors `CONTENT_EDIT_LOCKED`, `MEDIA_NOT_READY`, `ROLE_FIELDS_INVALID`, `TAG_NOT_FOUND`, `PRIMARY_RESUME_MUST_BE_VISIBLE`, `NOTIFICATION_NOT_FOUND` и общий problem envelope через `ApplicationError`/`ProblemDetailsFilter`.
- Если требуется только additive уточнение moderation/media error details или enum fallback, сначала изменить `api/openapi.yaml`, затем сгенерировать client и проверить compatibility. Provider callback/credentials не становятся browser API.

# Database changes

- Расширить Prisma datasource schemas и PostgreSQL grants для `catalog`, `trust`, `notifications`, сохраняя разные минимальные права API и worker. Не давать API provider credentials и не давать web/browser прямой доступ к DB/S3.
- Добавить `catalog.versions` и `catalog.tags` по `docs/architecture/data-model.md`: unique version, единственная active version, immutable после activation, unique `(catalog_version_id, code)` и `(catalog_version_id, sort_order)`.
- Добавить воспроизводимый seed одной active catalog version ровно с 180 rows из `docs/product/tag-catalog.md`. Seed хранит стабильные IDs/codes/category/order, повторный запуск идемпотентен, а release/test validation падает при пропуске, дубле, лишнем теге или расхождении порядка.
- Расширить текущие Profiles tables без пересоздания registration data:
  - добавить `profiles.resume_versions`, `profiles.resume_projects`, `profiles.resume_version_tags`;
  - добавить resume pointer FKs и constraints принадлежности `published_version_id`/`pending_version_id` своему root;
  - обеспечить принадлежность profile pointers своему root, различие pointers, монотонный `version_no`, one-pending-version invariant и immutable submitted/decided versions;
  - сохранить role-shaped CHECK/trigger для profile version и усилить его на все writers;
  - сохранить `slot = 0 -> is_search_visible = true`, max 10 ordered projects, max 20 unique canonical active tag IDs и `about <= 1024` на уровне, устойчивом к конкурентным writers.
- Добавить `trust.moderation_requests` и `trust.moderation_decisions` с enums/constraints/indexes из `docs/architecture/data-model.md`: unique content/version/policy request, unique provider key, pending claim index, generation/active endpoint, stable violations, immutable unique decision per source.
- Добавить module-owned inbox tables (`trust.inbox_events`, `profiles.inbox_events`, `notifications.inbox_events` там, где модуль является consumer) с `event_id` PK и effect/inbox marker в одной транзакции.
- Добавить `notifications.notifications` и `notifications.email_deliveries`: unique `(source_event_id, recipient_account_id, type/template_code)`, recipient cursor/unread indexes, delivery lease/retry/DLQ fields и terminal retention.
- Использовать уже существующие `platform.outbox_events`, `platform.outbox_deliveries` и `platform.idempotency_records`; version/root update и исходящее событие должны быть в одной PostgreSQL transaction.
- Использовать `files.media_bindings` для `profile_version`/`resume_version` только через публичный Files contract. Нельзя добавлять cross-schema FK на Profiles или читать/обновлять `files.media_objects` из Profiles/Trust SQL напрямую.
- Миграция выполняется по expand/migrate/contract, дважды идемпотентно применяется в integration setup и остаётся совместимой с предыдущим application image. Существующие account/profile/resume rows получают валидное состояние без выдуманного одобрения или публикации.

# Backend changes

- Реализовать Zod validation и явные response mappers для `ProfileInput`, `Profile`, `PublicProfile`, `ResumeInput`, `Resume`, `TagCatalog`, `NotificationPage`. Не использовать Prisma return types как public DTO.
- Расширить `ProfilesService` cohesive use cases чтения и изменения, сохранив существующие `createInitialProfile()` и `ownsMediaOwner()` либо совместимо заменив их публичным contract. Registration integration tests не должны сломаться.
- Profile update:
  - проверить active owner, актуальный If-Match, отсутствие edit lock/pending version и role-shaped fields по immutable `formalRole`;
  - проверить optional `avatarMediaId` как собственное sanitized `public_content` media, созданное для данного profile root;
  - под row lock/CAS создать следующую immutable `ProfileVersion`, поставить root в `pending`, записать idempotency result и outbox event в одной transaction.
- Primary resume update:
  - разрешить только `slot = 0`, принудительно сохранять `searchVisible = true`;
  - проверить limits, unique active catalog tags, project order/URL и optional `imageMediaId` для данного resume root;
  - атомарно создать `ResumeVersion`, projects/tag membership, pending pointer, idempotency result и moderation event.
- One-pending-version guard должен работать на уровне DB/CAS и двух API replicas. Нельзя перезаписать pending payload или published row; следующий edit создаёт новую version только после terminal result текущей.
- Определить ацикличный public contract между Files и Profiles для проверки ownership/scope/readiness, binding media к конкретной pending version, выдачи provider-scoped URL, применения `approved|rejected|moderation_failed` и безопасной замены/удаления media. Удалить необходимость обратных imports либо вынести orchestration в composition layer; `tests/architecture/module-boundaries.test.ts` должен оставаться зелёным без `forwardRef`-цикла и cross-schema SQL.
- Реализовать `ContentModerator` port, два независимо конфигурируемых adapters и локальный deterministic fake/stub только для development/tests. Adapter принимает только минимальный public text и short-lived scoped URL sanitized public media; `private_message` отвергается runtime guard до provider call.
- Для text version и каждого связанного public media создать idempotent moderation work. Публикация разрешена только когда текст и все связанные media получили approval по актуальной policy version. Любой reject возвращает candidate version на доработку; отсутствие provider result оставляет её pending.
- Реализовать primary -> secondary failover на timeout/transport error/open circuit, endpoint-specific circuit breakers, bounded retry/backoff и generation/active-endpoint CAS. Поздний, повторный или конкурентный result старой generation не изменяет version/media/pointers.
- При approval атомарно применить immutable `ModerationDecision`, переключить соответствующий published pointer, очистить pending pointer, обновить root `publicationState`/`rowVersion` и завершить Files binding/state через публичные contracts. При rejection оставить прежний published pointer, перевести candidate/root в revision-required и сохранить безопасные `violationCodes`/reason.
- Public query возвращает только active target account, approved profile version и только approved visible resume versions. Email, moderation internals, pending payload и signed URL не попадают в response. Если первой approved profile version ещё нет, использовать generic not-found/невидимое состояние без existence leak.
- Реализовать Notifications consumers результата модерации: в одной module transaction фиксировать inbox marker и deduplicated in-app notification; email delivery создаётся durable и отправляется отдельно через существующий `EmailSender` port/Identity public recipient lookup. SMTP failure не меняет moderation decision или publication state.
- Расширить `OutboxWorkerService` через явный consumer registry либо отдельные cohesive worker services/queues. Не наращивать неограниченную цепочку `if/else`, не хранить authoritative state только в BullMQ и не смешивать resource-heavy moderation с notifications queue.
- Добавить metrics/traces/logs: request -> correlation -> event/provider request, moderation attempts/result/latency, pending age, failover/circuit state, notification/email backlog/DLQ. Labels и сообщения не содержат fullName, specialization, about, projects, tag list пользователя, email, media URL/body, provider payload или credentials.
- Обновить readiness/degraded диагностику и runbook для обоих provider endpoints, stuck pending, late result, notification/email retry и безопасного replay. Отключённый worker/provider не должен делать API process unhealthy, но journey должен наблюдаемо оставаться pending/degraded.

# Frontend changes

- Добавить защищённый русский editor собственного профиля: поля `fullName`, `specialization`, `timezone` и только поля текущей `formalRole`; optional avatar использует существующий Files upload flow с `contentScope: public_content`, `ownerType: profile`, `ownerId: profile.id`.
- Добавить editor существующего primary resume: `about`, до 10 упорядоченных projects, picker до 20 canonical tag IDs, `searchVisible` зафиксирован true, optional image использует `ownerType: resume` и ID primary resume.
- Адаптировать `MediaUpload`/`MediaUploadProps`: public upload должен вернуть владельцу `mediaId` в технически готовом `moderation_pending` без попытки немедленно получить запрещённый download URL. Preview/download показывается только после public media approval; signed URL не хранится в localStorage/sessionStorage и не попадает в referrer/telemetry.
- Загрузить `GET /catalog/tags` typed client-ом, показать все 180 тегов по категориям, поддержать keyboard selection и не позволять ввод/отправку custom tag. Обработать `304`/ETag либо согласованный client cache без второго источника каталога.
- Получать и сохранять `ETag` для profile/resume/notification mutations; при stale `If-Match` обновлять current state и объяснять конфликт по-русски, не отправляя payload автоматически поверх чужого изменения.
- Использовать `prepareIdempotencyAttempt()` для retries одного payload и создавать новый key после изменения payload/явного нового submit. Payload и idempotency state хранятся только в памяти формы.
- Явно показывать `draft`, `pending`, `approved`, `revision_required` и recoverable provider delay. Pending не называется публикацией; violation codes отображаются через стабильный русский mapping с объектом нарушения и действием «исправить и отправить повторно».
- Показывать owner-only pending form отдельно от last-approved preview. При повторной модерации public screen продолжает показывать только last-approved payload; при первом pending/rejected submission публичная страница отсутствует.
- Добавить protected public profile screen `/profiles/[accountId]`, который отображает только `PublicProfile`, не email и не owner-only moderation metadata.
- Добавить notification center с unread state, cursor pagination, mark-one/read-all и polling/refetch, достаточным для штатного 10-second p95 без Socket.IO как источника состояния. Переход по notification повторно загружает и авторизует resource.
- Добавить ссылки только на реализованные profile/resume/notification screens. Additional resume creation, people search и moderation administration не появляются в навигации.
- Проверить keyboard flow, labels/live regions/focus after errors, отсутствие horizontal overflow и понятные русские состояния на 360 px и 1280 px. Unknown future enum/notification types получают безопасный fallback, а не crash.

# Edge cases

- Student не передал institute/course либо передал teacher/employer fields; teacher передал institute/company; employer не передал company. `formalRole` из request body не принимается и не меняется.
- Пустые/space-only обязательные строки, Unicode length, `about` 1025 символов, 11-й project, 21-й tag, duplicate tag ID, invalid URL, неизвестный/retired tag и custom text вместо tag ID.
- Primary resume пытаются сделать невидимым, изменить через чужой `resumeId`, удалить или использовать additional-resume operation до этапа 5.
- Два PATCH приходят с одним ETag; запрос теряет ответ после commit; один Idempotency-Key повторяется с другим body; pending version уже существует; account/session становится deleting между read и command.
- Первая version pending/rejected и published pointer отсутствует; новая version pending/rejected при существующей approved; profile approved раньше resume или наоборот. Каждый публичный fragment появляется только после собственного gate, unapproved payload не подмешивается.
- `avatarMediaId`/`imageMediaId` чужой, private, относится к другому owner root, ещё processing, rejected/deleted, уже bound к другой version или заменён конкурентно. UUID knowledge не раскрывает existence.
- Text approved, media rejected; media approved, text rejected; несколько media results приходят в разном порядке. Version публикуется ровно один раз только после полного gate.
- Primary provider отвечает timeout/transport error, secondary недоступен, оба circuit открыты, worker падает после provider response до DB commit, callback/result повторяется, поздний primary result приходит после secondary generation.
- Policy version меняется, пока request pending. Existing request завершается только по зафиксированной version; новая публикация использует active policy и не переинтерпретирует старое решение молча.
- Catalog seed запускается повторно, содержит 179/181 row, duplicate code/order или отличается от `tag-catalog.md`; category filter пуст/неизвестен; client получил старый ETag.
- Одна moderation event доставлена несколько раз; notification consumer падает между insert/effect; email отправлен, но delivery completion не записан; SMTP недоступен. In-app row и email business key не дублируются, publication не откатывается.
- Notification принадлежит другому recipient, уже прочитан, удалён или изменён после получения ETag; `read-all.before` находится в будущем/между конкурентными inserts. Новые notification после high-water не помечаются прочитанными.
- Provider возвращает неизвестный violation code, чрезмерный reason или unsafe payload. Backend сохраняет/показывает только allowlisted normalized code и bounded safe reason; raw response не попадает в API/logs.
- Redis/BullMQ, one worker replica, S3 или один provider недоступны после subject commit. Reconciliation безопасно продолжает работу, а API не сообщает approval до authoritative PostgreSQL transition.

# Tests

- Unit Profiles: role-shaped schema, trimming/lengths, timezone, project/tag limits, primary visibility, public DTO redaction, publication state transitions, ETag/If-Match и idempotency fingerprint.
- Unit Catalog: ровно 180 deterministic seed rows, уникальные IDs/codes/orders, categories/order совпадают с `docs/product/tag-catalog.md`, custom/retired tags отклоняются.
- Unit Trust: stable policy/violation mapping, public-scope guard, primary/secondary failover, circuit breaker, provider idempotency key, generation/endpoint CAS, duplicate/late results и full text+media gate.
- Unit Notifications: cursor ordering, unread filters, mark-read/read-all high-water, recipient authorization, event/template dedup и safe payload mapping.
- Integration/API с отдельной PostgreSQL test DB: все 10 операций этапа 4, exact status/problem/headers, migrations/grants, initial registration rows, first moderation, re-edit with last-approved visibility, stale/concurrent PATCH и cross-account generic not-found.
- Integration Files/Trust: profile/resume upload owner, only sanitized `public_content`, scoped provider URL, binding to pending version, approve/reject/failure transitions, replacement/tombstone и доказательство отсутствия private-media provider call.
- Worker/resilience: outbox -> inbox -> moderation -> Profiles decision -> notification/email; repeated delivery, lease loss, Redis restart, provider/S3/SMTP outages, primary failover, both-down pending, late result and reconciliation from PostgreSQL.
- Security/privacy: responses/logs/metrics/traces не содержат email другого пользователя, raw provider body, full profile/resume, media/signed URL или secrets; user UUID/media UUID не обходит object-level authorization.
- Migration: fresh database и upgrade от `20260908000100_files_media`; migration deploy дважды; catalog count/constraints/pointer ownership/immutability/inbox uniqueness проверяются реальным PostgreSQL.
- Contract gates: `pnpm openapi:lint`, `pnpm openapi:check`, generated-client compile и compatibility tests. `frontend/src/lib/api/generated.ts` меняется только генератором.
- Frontend unit/component: role-shaped form, tag picker limits, public upload `moderation_pending`, no preview before approval, moderation reason/fallback, ETag conflict, notification pagination/read state.
- Playwright: заполнение profile + primary resume для student/teacher/employer, optional media, pending -> approved public view, return for revision with last-approved view, both-provider outage/recovery, notification read/read-all, keyboard-only flow и 360/1280 layouts.
- Regression: registration/verification/login/logout/reset, session cache, Files private upload/download, health/degraded, architecture boundaries, lint/typecheck/build/unit/integration остаются зелёными. Не добавлять новые format violations; учитывать зафиксированный в `TASK-006` pre-existing repository format baseline.
- Performance/observability: p95 штатной internal notification <= 10 секунд, email <= 5 минут; moderation pending-age alerts на 5/30 минут, provider failover/circuit и queue/DLQ alerts проверяются executable rules/tests.

# Acceptance criteria

1. Все 10 REST operations этапа 4 реализованы по текущему OpenAPI, используют active session/object-level authorization и возвращают отдельные DTO; операции создания/удаления additional resume не реализованы и не показаны в UI.
2. Существующие registration rows мигрируют без потери данных: profile draft сохраняется, primary resume slot 0 получает version lifecycle при первом edit, pointer/role/limit/visibility invariants защищены DB и application rules.
3. `GET /catalog/tags` выдаёт одну active version и ровно 180 канонических стабильных тегов в утверждённом порядке; повторный seed безопасен, пользовательский/неактивный tag нельзя сохранить.
4. Profile и primary resume PATCH создают immutable pending versions, требуют CSRF + Idempotency-Key + актуальный If-Match и сходятся в одно состояние при retry/concurrency двух API instances.
5. Optional profile/resume image проверяется как собственное sanitized `public_content`, связывается с конкретной version через публичный Files contract и не выдаётся/не публикуется до полного text+media approval. Private media технически не может попасть в `ContentModerator`.
6. `ContentModerator` имеет primary/secondary adapters, стабильные provider keys, circuit breakers и generation/endpoint CAS. Один endpoint failover-ится на второй; при отказе обоих version остаётся pending, а поздний/duplicate result не меняет актуальное решение.
7. Approval атомарно переключает published pointer и сохраняет immutable decision; rejection возвращает candidate на доработку с нормализованной policy version/violation codes. Pending/rejected payload никогда не выдаётся другому пользователю, а последняя approved version остаётся видимой.
8. `GET /profiles/{accountId}` доступен только active viewer для видимого active target и не раскрывает email, pending payload, moderation internals или постоянный media URL. До первой approved profile version используется безопасное невидимое/not-found состояние.
9. Результат модерации создаёт не более одного in-app notification и одной email delivery на business event. Inbox/outbox replay не создаёт дублей; SMTP failure не изменяет decision/publication, а notification появляется в пределах штатного p95.
10. Русский UI позволяет с клавиатуры заполнить role-shaped profile и primary resume, выбрать до 20 из 180 тегов, добавить optional public media, различает pending/approved/revision-required и показывает last-approved public preview на 360/1280 px.
11. Module graph остаётся ацикличным: Profiles/Trust/Notifications не импортируют Files/Catalog/Identity internals или чужие Prisma models и не читают чужие schemas напрямую; architecture tests доказывают отсутствие private-media moderation path.
12. Пройдены unit, PostgreSQL integration/API, worker/resilience, privacy, migration, OpenAPI/compatibility, Playwright, performance и observability gates; предыдущие auth/files/health journeys не регрессировали, а runbook описывает failover, pending recovery и safe replay.

# Out of scope

- Создание, удаление и управление visibility дополнительных resume (этап 5), включая лимит пяти, snapshots и отдельные additional-resume screens.
- Search people projection, активность за 30 дней и показ primary resume в поисковой выдаче (этап 6). Profiles только сохраняет обязательный `searchVisible = true` для будущего consumer.
- Объявления, teams, events и их versions/media bindings. Общие contracts должны быть переиспользуемы, но handlers этих bounded contexts не создаются.
- Жалобы, ручная moderation queue/UI, moderator decisions, SLA escalation и appeals (этап 17). Автомодерация этапа 4 не заменяется ручным fail-open.
- Realtime Socket.IO notification hints. REST query/polling остаётся source of truth; realtime transport вводится последующим messaging slice.
- Marketing email, пользовательские notification preferences, постоянная история уведомлений или произвольные notification types вне результата модерации.
- Production procurement, юридическое одобрение и секреты реальных providers. Для production release остаётся обязательным наличие двух одобренных endpoints и зафиксированной policy version; тестовый adapter не удовлетворяет этому gate.
- Account deletion cascade, privacy export и окончательная очистка versions/media/notifications (этап 18); текущий slice обязан лишь не создавать неочищаемых cross-domain связей.
- Ручное редактирование `frontend/src/lib/api/generated.ts`, ослабление existing CSRF/session/idempotency/Files gates или появление публичного S3 bucket/long-lived URLs.

# Risks

- Текущая зависимость `FilesService -> ProfilesService` конфликтует с естественной потребностью Profiles вызывать Files при publication. Прямой обратный import создаст cycle, а прямой SQL — нарушение ADR-009/012. До написания handlers нужен явный ацикличный composition/public-contract design.
- Existing `ProfileVersion` создан регистрацией как draft, а primary resume не имеет version row. Ошибочный backfill может объявить непроверенные регистрационные данные approved или потерять их; migration должна сохранять draft/pending semantics.
- `MediaUpload` считает завершением получение download URL, тогда как public media обязано остановиться в `moderation_pending`. Унификация private/public UX без явного state-aware contract способна либо сломать profile form, либо открыть media раньше approval.
- Один provider result не обязательно означает approval всей version: текст и media могут завершиться в разном порядке. Без durable aggregate gate появятся преждевременная публикация, зависшее media или version, опубликованная после rejection другого компонента.
- `OutboxWorkerService.#handle()` уже является жёстким consumer switch, а ADR требует разные resource queues. Простое добавление moderation HTTP call в существующую notification delivery может вызвать starvation auth email и затруднить independent retry/circuit metrics.
- Product policy имеет дату актуальности, но не machine-readable version/codes. Нестабильная генерация кодов из русского заголовка сломает аудит/UI; version и mapping нужно зафиксировать явно и менять согласованно с product source.
- Full MVP OpenAPI уже содержит stage-5 additional-resume operations. Подключение controller с общим route может случайно сделать их частично доступными; contract tests должны отличать опубликованную спецификацию от реализованного scope этапа.
- Catalog seed из prose markdown легко получить с ошибкой нормализации/порядка. Нужен reviewed deterministic artifact и проверка exact count/content, а не runtime parsing документа.
- Provider и S3 находятся вне PostgreSQL transaction. Без provider idempotency, generation CAS, durable Files binding/tombstone и reconciliation сбой между внешним эффектом и commit создаст orphan/stale result.
- Publication и notifications работают с персональными данными. Raw provider payload, fullName/about/projects, signed URLs и email особенно легко случайно попасть в logs/traces/DLQ; redaction должна проверяться автоматическими тестами.
- Требование двух одобренных независимых endpoints — production blocker, который нельзя закрыть двумя URL одного failure domain или local fake. Реализация может быть функционально завершена для test/local, но release gate остаётся красным до внешнего approval.
