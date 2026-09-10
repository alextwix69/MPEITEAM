# TASK-006: Безопасная загрузка и получение изображения end-to-end

Статус: реализована; unit, integration, build, lint и typecheck проходят. Полный format:check репозитория сохраняет четыре pre-existing предупреждения вне TASK-006.

Источник: этап 3 «Безопасная загрузка и получение изображения end-to-end» из `docs/plans/implementation-plan.md`.

Проверено по repository на 08.09.2026, commit `fd64075`. Этапы 0 и 1 отмечены реализованными в `TASK-003` и `TASK-004`; фактический код и последний commit содержат lifecycle этапа 2 из `TASK-005`. Поэтому следующей задачей является этап 3, а не повторная реализация auth.

# Goal

Дать активному пользователю безопасный end-to-end сценарий изображения: API создаёт короткоживущую direct-upload session, браузер отправляет исходный JPEG/PNG/WebP непосредственно в quarantine S3-compatible storage, worker проверяет и sanitizes объект, после чего разрешённый private object можно получить через short-lived signed download URL при наличии object-level authorization.

Непроверенный, опасный, просроченный или принадлежащий другому владельцу объект не должен стать доступным через API или signed URL. Сценарий должен работать при нескольких экземплярах API и отдельном worker, используя PostgreSQL как source of truth, а не память процесса или Redis.

# Context

- В `docs/plans/implementation-plan.md` этап 3 зависит от завершённого этапа 2 и требует `Files` owner contracts, direct presigned upload, quarantine pipeline, S3 tombstone, cleanup и object-level authorization.
- Публичный REST-контракт для Files уже опубликован в `api/openapi.yaml`, а generated TypeScript client находится в `frontend/src/lib/api/generated.ts`. Отсутствие handler-ов в backend означает, что операции ещё не реализованы.
- `backend/src/modules/files/index.ts` существует, но содержит только `export {};`. Files не зарегистрирован в `backend/src/app.module.ts` или `backend/src/worker/worker.module.ts`.
- PostgreSQL schema `files` создаётся foundation migration `backend/prisma/migrations/20260901000100_platform_foundation/migration.sql`, однако таблиц `upload_sessions`, `media_objects`, `media_bindings` и `media_deletion_tombstones` нет ни в миграциях, ни в `backend/prisma/schema.prisma`.
- MinIO уже поднимается в `docker-compose.yml`, bucket `komanda-media` создаётся сервисом `minio-setup`, а AWS SDK уже присутствует в `backend/package.json`. Это существующая инфраструктурная основа, а не готовый media adapter.
- Сейчас `S3Client` используется только в `backend/src/platform/health/runtime-dependencies.ts` для `HeadBucketCommand`. Ни presigned PUT/GET, ни object metadata, ни worker image processing в repository не найдены.
- В текущем OpenAPI enum состояния содержит `ready`, тогда как `docs/architecture/data-model.md` использует внутреннее состояние `technically_ready`. Это нельзя разрешать молча: до изменения публичного контракта зафиксировать mapping или обновить OpenAPI и generated client, а архитектурно значимое отклонение записать в `docs/context/requirements-log.md` или ADR.
- Пока не реализованы profile editor, resume editor, messaging, teams и opportunities. Files должен предоставить публичные owner/binding contracts без прямого чтения чужих repositories или внутренних Prisma-моделей; интеграция конкретных бизнес-владельцев выполняется соответствующими последующими этапами.

# Relevant requirements

- Этап 3 из `docs/plans/implementation-plan.md`: JPEG/PNG/WebP, quarantine, magic bytes/MIME, malware scan, EXIF removal, Full HD/1 MiB resize, private media, S3 tombstone, cleanup и authorization на download URL.
- `FR-017`, `FR-047`, `FR-049`, `FR-118`, `FR-119` из `docs/product/product-spec.md`: необязательный avatar; изображения для публичного контента; исходный файл не более 5 MiB; сохранённая версия не выше Full HD и 1 MiB; видео не поддерживается.
- `BR-018`, `BR-018a` из `docs/product/product-spec.md`: принимаются только JPEG/PNG/WebP, EXIF удаляется; профильные и прочие owner media не смешиваются с лимитом фотографий переписки.
- `EC-017`, `ERR-013`, `ERR-013a`: неполная/опасная фотография не считается доставленной, unsupported или dangerous input не доставляется, ошибка sanitization не должна подтверждать пользовательскую операцию.
- `NFR-009` и `NFR-016`: опасная фотография не видна пользователю; p95 обработки после завершения передачи исходного файла — не более 5 секунд.
- `TNFR-009`, `TNFR-010`: server-side validation, отсутствие media/secrets/PII в telemetry и безопасное хранение.
- `ADR-007`: private S3-compatible storage, immutable `contentScope`, оба scope проходят quarantine и sanitization; только `public_content` может иметь последующий путь к ContentModerator; private media не имеет dependency path к moderation adapter.
- `ADR-012`: API — единственная пользовательская граница доступа к business data и signed URLs; worker использует отдельную service identity с минимальными grants; logs/traces/audit не содержат media или secrets.
- `ADR-015` и `docs/architecture/api-contracts.md`: `/api/v1` и OpenAPI — source of truth, command operations используют CSRF и Idempotency-Key, response DTO отделены от Prisma, ошибки используют stable code и русский message.
- `docs/architecture/data-model.md`, раздел 12: lifecycle и индексы `files.upload_sessions`, `files.media_objects`, `files.media_bindings`, `files.media_deletion_tombstones`; object key не содержит PII; quarantine retention не более 24 часов, completed tombstones — 30 дней.

# Existing code

| Реальный файл | Найденные структуры и фактическое состояние |
|---|---|
| `api/openapi.yaml` | Уже описаны `POST /uploads` (`createUploadSession`), `GET /uploads/{uploadId}` (`getUploadSession`), `POST /uploads/{uploadId}/complete` (`completeUpload`) и `GET /media/{mediaId}/download-url` (`createMediaDownloadUrl`). Существуют schemas `UploadCreate`, `UploadSession`, `DownloadUrl`, параметры `UploadId`/`MediaId`, CSRF и Idempotency-Key. |
| `frontend/src/lib/api/client.ts` | `apiClient = createClient<paths>({ baseUrl: '/api/v1' })`; generic REST client уже типизирован generated OpenAPI types. |
| `frontend/src/lib/api/generated.ts` | Generated types для uploads/media уже присутствуют; файл не должен редактироваться вручную. |
| `backend/src/modules/files/index.ts` | Пустой public entrypoint `export {};`; application/domain/infrastructure Files-кода нет. |
| `backend/src/app.module.ts` | `AppModule.register()` подключает `DatabaseModule`, `IdentityModule` и `HealthModule`; `FilesModule` отсутствует. |
| `backend/src/worker/worker.module.ts` | `WorkerModule.register()` подключает `ComplianceModule`, `WorkerService`, `OutboxWorkerService`, `SmtpEmailSender` и runtime tokens; Files pipeline отсутствует. |
| `backend/src/platform/health/runtime-dependencies.ts` | `RuntimeDependencies` создаёт `S3Client`, `checkObjectStorage()` выполняет `HeadBucketCommand`, а `close()` уничтожает client. Это health probe, не storage abstraction для media. |
| `backend/src/platform/config/env.schema.ts` | `ApiEnvironment`/`WorkerEnvironment` уже валидируют `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, credentials, path-style, timeout и worker heartbeat settings. Лимиты media, quarantine TTL и signed URL TTL пока отсутствуют. |
| `backend/src/platform/http/application-error.ts`, `problem-details.ts` | Существующие `ApplicationError` и `ProblemDetailsFilter` являются общей основой для stable error envelope и русского сообщения. Новые media error codes должны использовать этот механизм. |
| `backend/src/modules/identity/http/session.guard.ts` | Глобальный `APP_GUARD` разрешает только публичные/logout exceptions, для остальных routes вызывает `IdentityService.authorizeSession()` и проверяет CSRF для unsafe methods. Upload POST handlers должны использовать эту existing boundary. |
| `backend/src/modules/identity/application/identity.service.ts` | Реализованы session authorization, CSRF/Origin validation, idempotency helpers и account state/capabilities. Files не должен обращаться к private implementation Identity; для owner authorization использовать public contract. |
| `backend/src/worker/outbox-worker.service.ts` | `onApplicationBootstrap()`, `#dispatch()`, `#handle()` и `#cleanupIfDue()` реализуют BullMQ/outbox delivery, retry/lease и cleanup для verification, password reset и consent evidence. Media jobs/tombstones и image processing отсутствуют. |
| `backend/src/modules/profiles/application/profiles.service.ts` | `ProfilesService.createInitialProfile()` создаёт profile/profile version/primary resume и принимает `avatarMediaId`; отдельного media binding или проверки готовности media пока нет. Не добавлять в Files прямой доступ к этому service implementation. |
| `backend/prisma/schema.prisma` | Есть Prisma models identity, profiles и platform (`Account`, `Credential`, `AuthToken`, `Session`, `ConsentStatus`, `Profile`, `ProfileVersion`, `Resume`, `IdempotencyRecord`, `OutboxEvent`, `OutboxDelivery`); Files models отсутствуют. |
| `docker-compose.yml` | MinIO, `minio-setup`, API и worker уже работают с локальным bucket; API/worker сейчас используют один локальный S3 credential block. Production least-privilege identities остаются обязательными по ADR-012. |
| `tests/architecture/module-boundaries.test.ts` и `tests/architecture/module-boundaries.ts` | Уже проверяются 13 module entrypoints, запрет provider SDK в application/domain и запрет прямого импорта чужой infrastructure/repository. Тестовый fixture отдельно доказывает, что `@aws-sdk/*` нельзя импортировать из `backend/src/modules/files/application/*`. |

# Files likely affected

## Существующие файлы, которые должны быть изменены

- `api/openapi.yaml` — только если потребуется зафиксировать mapping `ready`/`technically_ready`, уточнить media errors или исправить контракт; после этого обновить generated client и compatibility snapshot.
- `frontend/src/lib/api/generated.ts` — только через `pnpm openapi:generate`, если меняется OpenAPI; вручную не редактировать.
- `backend/src/app.module.ts` — зарегистрировать Files public API module.
- `backend/src/worker/worker.module.ts` — зарегистрировать Files worker/pipeline providers и storage/scanner adapters.
- `backend/src/platform/config/env.schema.ts`, `.env.example` — добавить только необходимые validated limits, TTL, scanner и storage settings с безопасными локальными примерами.
- `backend/prisma/schema.prisma` — добавить Prisma representation Files tables/enums, если выбранный implementation использует Prisma для этих schemas.
- `backend/src/worker/outbox-worker.service.ts` — подключить media processing/tombstone dispatch только через public Files worker contract; не смешивать media payload с identity consumers.
- `docker-compose.yml`, `infra/postgres/init-test-database.sql`, `infra/docker/backend.Dockerfile` — обновить только при необходимости migration/grants, fixture tools или runtime dependencies; сохранить раздельную test database и существующий MinIO setup.
- `tests/architecture/module-boundaries.test.ts` и/или `tests/architecture/module-boundaries.ts` — расширить исполняемые boundary checks, если новые Files providers требуют дополнительных запретов.
- `README.md`, `docs/production/runbook.md` и media-specific observability/runbook artifact — описать local upload checks, stuck quarantine, scanner/S3 outage и tombstone replay после появления реализации.

## Новые целевые файлы

Ожидаемые имена могут быть уточнены стандартной структурой проекта, но новые файлы должны оставаться внутри Files public boundary:

- `backend/src/modules/files/files.module.ts` и обновлённый `backend/src/modules/files/index.ts`.
- `backend/src/modules/files/application/` — upload session service, completion/status/download use cases и public owner/binding ports; application не импортирует `@aws-sdk/*`, `sharp`, scanner SDK или Redis/BullMQ напрямую.
- `backend/src/modules/files/domain/` — scope/state/limit rules и transitions без provider dependencies.
- `backend/src/modules/files/infrastructure/` — Prisma repository, S3 adapter/presigner, image sanitizer и malware scanner adapter; конкретные provider imports изолированы здесь.
- `backend/src/modules/files/http/` — controller/DTO mapping для четырёх OpenAPI operations; response DTO не являются Prisma models.
- `backend/src/modules/files/worker/` или соответствующий public worker contract — processing, quarantine cleanup и tombstone jobs.
- `backend/prisma/migrations/<timestamp>_files_media/migration.sql` — expand migration для Files schemas/tables/enums/indexes/grants.
- `backend/tests/unit/files-*.test.ts`, `backend/tests/integration/files-*.test.ts` и при необходимости `backend/tests/fixtures/media/*` — синтетические безопасные/опасные fixtures без пользовательских файлов.
- `frontend/src/components/media-upload.tsx` и `frontend/src/lib/media-upload.ts` либо эквивалентная feature-local структура — reusable control, polling, preview gating и retry без добавления незавершённого business route в навигацию.
- `tests/e2e/media-upload.spec.ts`, `tests/smoke/*` и observability artifacts — только при необходимости для запускаемого upload-to-download journey.

# API changes

- Реализовать существующие, уже опубликованные операции под global prefix `/api/v1`:
  - `POST /uploads` (`createUploadSession`): Active session, CSRF и обязательный `Idempotency-Key`; принять `UploadCreate` с `contentScope`, allowlisted `ownerType/ownerId`, `mimeType` JPEG/PNG/WebP и `sizeBytes` 1..5 MiB; вернуть `201 UploadSession` со short-lived object-scoped presigned PUT URL и фиксированными upload headers.
  - `GET /uploads/{uploadId}` (`getUploadSession`): Active uploader only; вернуть `200 UploadSession` без object key, credentials или internal scanner details.
  - `POST /uploads/{uploadId}/complete` (`completeUpload`): Active uploader, CSRF и Idempotency-Key; server-side проверить наличие/размер/metadata объекта в S3 и перевести session в processing; вернуть `202` для нового и безопасного повторного complete.
  - `GET /media/{mediaId}/download-url` (`createMediaDownloadUrl`): Active account и текущая object-level permission; вернуть `200 DownloadUrl`, `Cache-Control: no-store`, TTL не более 5 минут; signed URL не должен быть доступен по одному знанию UUID без authorization.
- Сохранить error codes из OpenAPI: `UPLOAD_SCOPE_MISMATCH`, `UPLOAD_LIMIT_EXCEEDED`, `OWNER_NOT_FOUND`, `UPLOAD_NOT_FOUND`, `UPLOAD_EXPIRED`, `UPLOAD_OBJECT_MISMATCH`, `MEDIA_NOT_READY`, `MEDIA_NO_LONGER_STORED`, а также общие `AUTH_REQUIRED`, `CSRF_FAILED`, `FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`.
- Cross-account и несуществующие/недоступные upload/media resources не должны раскрывать owner или существование чужого объекта; использовать согласованный 404/generic problem response.
- Не добавлять новые browser routes, callbacks с raw object key или публичные S3 endpoints. API остаётся единственной границей выдачи signed URL.
- Если mapping `technically_ready` → публичный `ready` выбран как internal-to-API translation, закрепить его в DTO и тесте. Если меняется public enum, обновить `api/openapi.yaml`, generated client и `api/openapi.release.yaml` только additive-совместимым способом.

# Database changes

- Создать воспроизводимую expand migration для существующей `files` schema с enum/check constraints и таблицами:
  - `files.upload_sessions`: UUID PK, owner account, immutable `content_scope`, `owner_type`, `owner_ref`, expected MIME/size, random object key, state, expiry, failure code и common timestamps; unique object key и partial expiry index.
  - `files.media_objects`: UUID PK, unique upload session, uploader, scope/state, bucket/object key, sha256, sanitized MIME/size/width/height, retention class, attach/delete timestamps; unique `(bucket, object_key)` и owner/state indexes.
  - `files.media_bindings`: authoritative one-owner/one-slot binding с unique `(owner_type, owner_id, slot)`; удаление binding предшествует tombstone.
  - `files.media_deletion_tombstones`: media ID PK, bucket/object key, pending/in-progress/completed/failed state, attempt/lease/retry timestamps and error code.
- Реализовать state constraints и допустимые transitions: upload `created -> uploaded/processing -> technically_ready|failed|expired|consumed`; media quarantine/sanitization/technical readiness; public content не становится downloadable до допустимого moderation state; private scope не направляется в moderation.
- Не добавлять cross-schema foreign keys к будущим Team/Messaging/Opportunity/Event owners, не создавать shared repository и не использовать JSON placeholder tables. Owner validation выполняется через public contracts bounded contexts.
- Применить grants для API/worker согласно ADR-012: API не получает больше, чем требуется для metadata/presign/read authorization; worker получает только processing/tombstone access; raw credentials не коммитить.
- Зафиксировать retention: quarantine/created upload cleanup не позднее 24 часов, terminal upload metadata не более 7 дней, completed tombstones 30 дней для reconciliation. Cleanup должен быть batch/restartable и не удалять media row до фиксации tombstone.
- Расширить Prisma schema/client либо использовать безопасный SQL repository, но не смешивать Prisma model names с публичными response DTO. Migration должна применяться на чистой и существующей registration/session database без потери данных.

# Backend changes

- Создать `FilesModule` с public exports только для application contracts, необходимых controller, worker и будущих bounded contexts. Подключить его в `AppModule`/API и отдельный worker contract в `WorkerModule`.
- Реализовать owner/scope policy: `private_message` разрешён только message-draft contract, `public_content` — только allowlisted public owner contract; проверять account state, ownership, slot/retention class и отсутствие cross-account доступа. Не создавать в Files фиктивные team/message/opportunity domain entities.
- Создать S3 storage port и adapter в `infrastructure`: случайные non-PII keys с отдельными quarantine/private prefixes, presigned PUT с коротким TTL и точными content-length/content-type constraints, HeadObject/Copy/Delete/ presigned GET; никогда не принимать object key от клиента как authority.
- Реализовать completion transaction: idempotency reservation, verify session owner/expiry, verify uploaded object against expected size and server-observed type, persist processing state and enqueue/claim work atomically. Потерянный HTTP response должен безопасно повторяться по тому же key/payload.
- Реализовать worker pipeline с fail-closed semantics: magic bytes и MIME sniffing, decode validation, decompression-bomb/resource limits, malware scanner port, EXIF removal, orientation-safe resize/re-encode до 1920x1080 и ≤1 MiB, sha256/metadata persistence и move из quarantine в private sanitized key. Исходник не должен считаться готовым объектом.
- Для `public_content` подготовить state/contract для последующей moderation; не передавать `private_message` в ContentModerator и не добавлять dependency path к moderation adapter. До готового public moderation state выдавать `MEDIA_NOT_READY`.
- Реализовать cleanup просроченных upload sessions/quarantine objects и restartable tombstone worker. Missing-object delete считать успешным, retries/lease делать идемпотентными, orphaned object и DB row не оставлять после успешной reconciliation.
- Добавить structured logs/metrics с requestId/correlationId/eventId, scope/state/result/latency и counts, но без email, filename, object key, signed URL, image bytes, scanner payload или credentials. Добавить dashboard/alert/runbook для failed processing, quarantine age, tombstone backlog и p95 processing.
- Пропустить все provider SDK imports через infrastructure; application/domain слой не импортирует `@aws-sdk/*`, `sharp`, `pg`, `ioredis`, `bullmq` или scanner SDK, чтобы существующий architecture test оставался зелёным.

# Frontend changes

- Создать reusable upload control на базе существующего `frontend/src/lib/api/client.ts` и generated types: выбрать файл, показать допустимые форматы/лимит 5 MiB, создать session, отправить PUT на presigned URL, вызвать complete и polling `GET /uploads/{uploadId}`.
- Показывать preview/download только после технически готового разрешённого состояния; не строить preview из непроверенного локального object URL как будто он уже доставлен получателю. Signed URL и token не сохранять в localStorage/sessionStorage и не отправлять в telemetry/referrer.
- Обработать retry только для recoverable network/S3/worker states; повтор complete использует тот же idempotency key/payload, а новый upload создаётся только после явного отказа/expiry. Ошибки `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `MEDIA_NOT_READY` и processing failure должны объяснять следующее действие на русском.
- Не добавлять в навигацию несуществующие profile/message/opportunity screens. До появления их bounded contexts компонент допускается проверить unit/component тестами и отдельным техническим harness, не объявляя бизнес-функцию готовой.
- Сохранить keyboard focus, отсутствие horizontal overflow и проверку viewport 360 px/1280 px; control должен корректно работать при отключённом worker и после reload status page.

# Edge cases

- MIME `image/jpeg`/`image/png`/`image/webp` подменён расширением или header; файл пустой, повреждён, содержит polyglot/декомпрессионную бомбу, превышает 5 MiB до передачи либо после sanitization остаётся больше 1 MiB.
- EXIF содержит GPS/ориентацию/thumbnail; после обработки не должно остаться EXIF/ICC payload, а визуальная ориентация должна сохраниться безопасным re-encode.
- S3 объект отсутствует, размер отличается, content type не совпадает, upload session истекла между PUT и complete, complete пришёл дважды или одновременно из двух API replicas.
- Worker, S3, scanner или Redis недоступны после commit; API не возвращает `ready`/`technically_ready` ложно, pending processing можно возобновить, а повторная доставка job не создаёт второй media object.
- Пользователь меняет аккаунт/сессию между create, PUT, complete и polling; чужой `uploadId`/`mediaId`, неразрешённый owner slot и удалённый object дают generic 404/forbidden без existence leak.
- Download URL просрочен, повторно запрошен, попал в browser cache, signed URL использован для другого key/bucket или объект переведён в deleting/deleted.
- Public content находится в `moderation_pending`/`rejected`; private content никогда не попадает в moderation adapter. Unknown future enum values не ломают frontend status rendering.
- Quarantine cleanup и account deletion/будущая owner deletion конкурируют с processing; tombstone должен быть durable и повторяемым.
- Параллельные запросы с одинаковым Idempotency-Key и различным payload; потерянный ответ после DB commit; retry после TTL ключа.

# Tests

- Unit: Zod/request validation, byte/MIME sniff policy, size/dimension limits, random non-PII object keys, scope/owner rules, state machine, TTL limits, signed URL no-store mapping, idempotency fingerprint и redaction.
- Integration/API с отдельными PostgreSQL test database и MinIO: create session, presigned PUT, HeadObject/complete, status polling, download authorization, exact statuses/error envelope, migrations/grants и cross-account 404. Проверить replay complete и two-replica race.
- Media pipeline: synthetic JPEG/PNG/WebP with spoofed MIME, EXIF/GPS, large dimensions, truncated/decompression-bomb input, malware scanner verdicts, sanitized sha256/size/dimensions, no original object exposure и p95 ≤5 секунд после upload.
- Resilience: S3/scanner/worker/Redis outages, job retry/lease loss, expired upload sweep, orphan cleanup, tombstone replay/missing-object delete, DB rollback and no false-ready state.
- Security/privacy: no raw object key, filename, URL, image bytes, scanner payload or credentials in logs/metrics/traces; private scope has no import/dependency path to moderation; architecture boundary tests pass.
- Contract/quality: `pnpm openapi:lint`, `pnpm openapi:check`, format/lint/typecheck/unit/integration/build; generated client changes only from OpenAPI; existing registration/login/reset/health/degraded tests remain green.
- Frontend/Playwright: keyboard upload control, Russian validation/error states, polling to ready/failure, retry after worker recovery, no preview before ready, no horizontal overflow at 360 px and 1280 px, no signed URL in telemetry/referrer.

# Acceptance criteria

1. Активный пользователь может через опубликованные четыре Files operation создать session, передать JPEG/PNG/WebP до 5 MiB, завершить upload и получить состояние обработки; OpenAPI, generated client и runtime handlers согласованы.
2. S3 object key случайный и не содержит email, filename, account ID или другой PII; исходный upload доступен только в quarantine и не выдаётся через download endpoint.
3. Object проходит server-side magic-byte/MIME validation, malware scan, decode/resource checks, EXIF removal, orientation-safe resize до Full HD и re-encode не более 1 MiB; неподдерживаемый, опасный или повреждённый input получает safe failure и не становится ready.
4. Только `technically_ready`/его явно зафиксированное публичное mapping состояние может считаться готовым private media; `GET /media/{mediaId}/download-url` проверяет текущую object-level permission, возвращает signed GET с TTL ≤5 минут и `Cache-Control: no-store`.
5. Чужой account, чужой upload/media UUID, неверный owner/scope/slot и deleted media не раскрывают existence или signed URL; API возвращает согласованный generic problem response.
6. Повтор create/complete с тем же key и payload не создаёт duplicate session/media/worker effect; другой payload с тем же key отклоняется. Concurrency на двух API instances сохраняет единственный authoritative state.
7. Worker/S3/scanner outage не даёт ложного success/ready; после восстановления processing, cleanup и tombstone можно безопасно продолжить с любого checkpoint. Missing-object hard delete считается успешно завершённым.
8. `files.upload_sessions`, `media_objects`, `media_bindings`, `media_deletion_tombstones` имеют требуемые constraints/indexes/retention, migration обратимо совместима с предыдущим application image и не создаёт cross-module repositories/FKs, нарушающие boundaries.
9. Private media не имеет зависимости на ContentModerator; public media до последующего moderation approval остаётся недоступным как пользовательский ready object. Future owner modules получают Files только через public contracts.
10. Русский reusable frontend control показывает безопасные статусы, preview только после ready, recoverable retry и работает с клавиатуры на 360 px/1280 px; незавершённые бизнес-фичи не появляются в навигации.
11. Пройдены unit, integration/API, pipeline/resilience, architecture, OpenAPI, Playwright и p95 processing gates; telemetry не содержит PII, media, raw secrets или signed URLs; добавлены runbook/metrics/alerts для нового journey.

# Out of scope

- Profile/resume editor, публикация profile/resume, team/opportunity/event forms и их media bindings; эти владельцы реализуются этапами 4, 5, 13 и 15–16.
- Messaging, chat photo quota 500/501-й eviction, message delivery и `private_message` binding в Messaging; Files предоставляет contract, но не реализует Messaging domain.
- Content moderation business workflow, moderator UI, appeals и окончательное решение `approved/rejected` для public content; публичный путь должен быть подготовлен и fail closed до соответствующего этапа.
- Видео, audio, документы, animated media beyond explicitly supported validation, client-side trust of MIME/extension, public S3 bucket и long-lived download links.
- Account deletion cascade, legal evidence, backup restore and production DR/release gate; Files должен оставить restartable tombstones и public hooks для этапа 18/19.
- CDN, cross-user deduplication, image search, arbitrary transformations, user-visible quota UI и изменение уже реализованного Identity/session lifecycle.
- Реализация новых бизнес endpoints или ручное редактирование `frontend/src/lib/api/generated.ts` без изменения source-of-truth OpenAPI.

# Risks

- Несогласованность `ready` в OpenAPI и `technically_ready` в data model может привести к несовместимому generated client или к ложной готовности. Решение требуется зафиксировать до кода и покрыть contract test.
- Presigned PUT не доказывает, что клиент отправил заявленный MIME/size. Только server-side HeadObject plus magic-byte/decode validation может перевести объект из quarantine; ранний state transition создаст media bypass.
- Image decoder и EXIF/resize library могут иметь уязвимости или неограниченное потребление памяти. Нужны bounded worker concurrency, input limits, dependency scanning и fail-closed scanner policy.
- S3 и PostgreSQL не участвуют в одной транзакции. Durable upload/media state, idempotent copy/delete и tombstones должны закрывать окно между DB commit и object operation; иначе появятся orphaned objects или преждевременные удаления.
- Общий локальный S3 credential в текущем `docker-compose.yml` удобен для development, но не доказывает least privilege production. Production deployment должен иметь отдельные API/worker identities и проверяемые grants.
- Owner contracts ещё не существуют для большинства bounded contexts. Прямое чтение чужих tables ради «быстрого» authorization нарушит ADR-009/012 и усложнит последующие migrations; лучше временно отклонять неподдержанный owner type явно.
- Signed URL может попасть в browser history, referrer, logs или cache. `no-store`, referrer policy, redaction и короткий TTL должны проверяться не только unit-тестом, но и browser/network test.
- Worker outage после успешного direct PUT оставляет quarantine object. Expiry sweep и orphan inventory должны быть независимыми от успешного completion, иначе storage будет расти незаметно.
