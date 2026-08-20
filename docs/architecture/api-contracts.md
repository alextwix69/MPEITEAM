# API-контракты frontend ↔ backend

Статус: контракт MVP. Машиночитаемый источник — [`api/openapi.yaml`](../../api/openapi.yaml). Документ основан на `docs/product/product-spec.md`, `docs/architecture/system-design.md` и `docs/architecture/data-model.md`.

## 1. Граница и общие соглашения

- Публичный browser API — REST/JSON по HTTPS с base path `/api/v1`. Внутренние provider callbacks, worker jobs, outbox/inbox и legal database API в контракт frontend ↔ backend не входят.
- JSON кодируется в UTF-8; имена полей — `camelCase`; UUID — UUIDv7; дата/время — RFC 3339 UTC; часовой пояс события — IANA name.
- Успех означает commit постоянного бизнес-состояния. Email, уведомления, поисковая проекция, создание контекстного чата, модерация и обработка media могут завершаться асинхронно; их состояние явно возвращается в DTO.
- Response DTO не повторяют ORM-модели и не содержат email другого пользователя, credentials, внутренних permission grants, абсолютных показателей активности/популярности, текста личных сообщений вне разрешённого чата или постоянных media URL.
- `X-Request-Id` можно передать как UUID; сервер всегда возвращает итоговый `X-Request-Id`. Неизвестные request-поля отклоняются, неизвестные response-поля клиент обязан игнорировать.
- Успешное создание возвращает `201`, синхронная команда — `200`/`204`, принятая асинхронная обработка — `202`. Пустой список — `200` с `items: []`, а не `404`.

## 2. Authentication, CSRF и authorization

Сессия передаётся только cookie `__Host-session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`). `GET /auth/csrf` выдаёт связанный с сессией CSRF token; любой `POST`, `PUT`, `PATCH` и `DELETE`, кроме регистрации, входа, подтверждения/повторной отправки email и reset-flow, требует allowlisted same-origin `Origin` и `X-CSRF-Token`.

Обозначения в таблицах:

- `Public` — сессия не нужна;
- `Session` — допустимы `unverified`, `active` и, только для явно указанных Identity/Compliance операций, `deleting`;
- `Active` — подтверждённый аккаунт, действующие обязательные согласия, состояние `active`;
- `Moderator(permission)` — активная moderator-сессия и указанное permission.

Авторизация deny-by-default выполняется в application service для каждого ID. Чужой или скрытый объект, существование которого нельзя раскрывать, возвращает одинаковый `404 RESOURCE_NOT_FOUND`. `403` используется, когда объект уже раскрыт пользователю, но роль/отношение не разрешает действие. Формальная роль `student|teacher|employer` не является системным правом.

## 3. Версии, повторы и конкурентные изменения

### 3.1 API evolution

- Внутри `/api/v1` разрешены только additive изменения: новые optional response fields, новые endpoints и новые необязательные request fields с безопасным default.
- Нельзя удалять/переименовывать поле, сужать допустимые значения, менять смысл существующего значения или делать optional field обязательным в rolling window.
- Enum-клиенты должны иметь fallback для неизвестного значения. Новый обязательный вариант поведения требует `/api/v2` либо заранее введённого capability.
- Breaking change: пометка `deprecated`, минимум один поддерживаемый release window, telemetry использования, новая major version. CI сравнивает OpenAPI с последним release и запускает old-client/new-API и new-client/old-API contract tests.
- OpenAPI version фиксирует контракт (`info.version`), а не URL major version. Ответы могут содержать `Deprecation` и `Sunset` по RFC 9745/8594.

### 3.2 Idempotency и retries

`Idempotency-Key` обязателен на отмеченных `I:req` command endpoints. Формат — 1–128 printable ASCII characters; рекомендуемый формат UUIDv4. Область ключа: `(account, HTTP method, normalized route)`, TTL — не менее 24 часов.

- первый запрос атомарно сохраняет hash canonical payload и результат вместе с business commit;
- повтор с тем же key и payload возвращает исходные status/body и `Idempotency-Replayed: true`;
- тот же key с другим payload — `409 IDEMPOTENCY_KEY_REUSED`;
- незавершённый первый запрос — `409 IDEMPOTENCY_IN_PROGRESS` с `Retry-After`;
- предметные UNIQUE/state constraints остаются вторым уровнем дедупликации.

Клиент автоматически повторяет только network timeout и ответы `429`, `502`, `503`, `504`, а также `409 RETRYABLE_CONFLICT` при `error.retryable=true`. Для `429/503` учитывается `Retry-After`; backoff exponential с full jitter, максимум две автоматические попытки. Unsafe request повторяется только с тем же `Idempotency-Key` и неизменным payload. Другие `4xx` автоматически не повторяются.

### 3.3 Optimistic concurrency

Изменяемые resources возвращают `ETag: "<rowVersion>"`. Отмеченные `C:yes` операции требуют `If-Match`; отсутствие — `428 PRECONDITION_REQUIRED`, устаревшая версия — `412 VERSION_MISMATCH` с `details.currentVersion`. Нельзя автоматически поверх нового состояния повторять PATCH: клиент refetch-ит resource и предлагает разрешить конфликт.

Необратимые решения дополнительно выполняют CAS из допустимого исходного статуса. При гонке первое подтверждённое действие побеждает, второе получает `409 STATE_CONFLICT` и актуальные `status`/`version` в `details`. Deadlock/serialization failure backend повторяет до двух раз с jitter под тем же idempotency key; после этого возвращает `409 RETRYABLE_CONFLICT`.

## 4. Pagination, sorting и filtering

Списки с потенциально неограниченным размером используют opaque cursor. Общие query: `limit` (default `20`, `1..100`) и `cursor`. Ответ:

```json
{
  "items": [],
  "page": { "nextCursor": "opaque-or-null", "hasMore": false }
}
```

Cursor подписан сервером, включает sort key, tie-breaker ID, filter hash и срок жизни. Изменение фильтров/sort требует начать без cursor; несовместимый, изменённый или истёкший cursor даёт `400 INVALID_CURSOR`. Повтор страницы может отразить конкурентные вставки/удаления, но не должен дублировать элементы в одном последовательном проходе. Все sort имеют стабильный UUID tie-breaker.

Query arrays кодируются повторением (`tagId=a&tagId=b`). Теги по умолчанию сопоставляются как `any`; `tagMode=all` включает пересечение всех. Строки trim/Unicode-normalize; пустая строка эквивалентна отсутствию фильтра. Неизвестные filter/sort отклоняются.

## 5. Единый формат ошибок

Content-Type ошибки — `application/problem+json`. Envelope сохраняет совместимый корневой ключ `error`:

```json
{
  "error": {
    "code": "VERSION_MISMATCH",
    "message": "Объект уже изменён. Обновите данные и повторите действие.",
    "requestId": "0198...",
    "retryable": false,
    "details": { "currentVersion": 8 },
    "fieldErrors": [
      { "path": "projects[0].title", "code": "TOO_LONG", "message": "Не более 200 символов." }
    ]
  }
}
```

`code` стабилен и определяет обработку; русское `message` можно улучшать без изменения контракта. `details` — объект с документированными безопасными значениями; `fieldErrors` присутствует для field validation. В ошибке запрещены email, tokens, password/hash, message body, media URL, полное resume и stack trace.

| HTTP | Общие codes | Когда используется |
|---:|---|---|
| 400 | `MALFORMED_JSON`, `INVALID_QUERY`, `INVALID_CURSOR` | Невозможно интерпретировать request/query. |
| 401 | `AUTH_REQUIRED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS`, `TOKEN_INVALID_OR_EXPIRED` | Нет действующей аутентификации; login/reset не раскрывают наличие email. |
| 403 | `CSRF_FAILED`, `ACCOUNT_UNVERIFIED`, `ACCOUNT_DELETING`, `CONSENT_REQUIRED`, `FORBIDDEN` | Сессия распознана, но глобальный guard или известное отношение не разрешает действие. |
| 404 | `RESOURCE_NOT_FOUND`, `EVIDENCE_UNAVAILABLE` | Объект отсутствует/скрыт либо evidence удалено вместе с источником. |
| 409 | `STATE_CONFLICT`, `RETRYABLE_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS` | Конфликт business state, повтора или транзакции. |
| 412/428 | `VERSION_MISMATCH`, `PRECONDITION_REQUIRED` | Optimistic concurrency. |
| 413/415/422 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `VALIDATION_FAILED` | Размер, MIME или семантическая/field validation. |
| 429 | `RATE_LIMITED` | Rate limit; обязательный `Retry-After`. |
| 500/502/503/504 | `INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `UPSTREAM_TIMEOUT` | Безопасная server/provider ошибка; возможен retry только при `retryable=true`. |

Ниже `HTTP` перечисляет специфические успешные/ошибочные статусы; общие `400/401/403/404/409/412/428/429/5xx` применимы согласно этому разделу и не дублируются в каждой строке.

## 6. Endpoint catalog

В колонке `I/C/P/S/F`: `I:req|opt|—` — idempotency key; `C:yes|—` — `If-Match`; `P` — pagination; `S/F` — сортировка/фильтры. `—` означает отсутствие соответствующей возможности.

### 6.1 Identity и session

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `GET /auth/csrf` | `Session`; любая незавершённая сессия | Нет body. | `200 CsrfToken`; `Cache-Control: no-store`. | `AUTH_REQUIRED`. | `—` |
| `POST /auth/registrations` | `Public`; rate limit IP+email | `RegistrationRequest`: unique normalized email, password 12..128, role; student/teacher требуют `@mpei.ru`; role-shaped profile; четыре отдельных `accepted=true` и актуальные document versions. | `201 RegistrationResult` с `accountState=unverified`; verification email асинхронен. | `EMAIL_ALREADY_REGISTERED`, `EMAIL_DOMAIN_NOT_ALLOWED`, `AGE_CONFIRMATION_REQUIRED`, `CONSENT_REQUIRED`, `CONSENT_VERSION_OUTDATED`. | `I:req` |
| `POST /auth/email-verifications` | `Public`; одноразовый token | `token` 32..2048. | `200 SessionView`, cookie обновлена; active только после всех consent guards. | `TOKEN_INVALID_OR_EXPIRED`, `CONSENT_EVIDENCE_UNAVAILABLE`. | `I:req` |
| `POST /auth/email-verifications/resend` | `Session` (`unverified`) или public email flow; rate limit | Optional `email`; одинаковый внешний результат независимо от существования аккаунта. | `202 OperationAccepted`. | `ALREADY_VERIFIED`; rate limit. | `I:req` |
| `POST /auth/sessions` | `Public`; rate limit IP+email | Email ≤320, password 1..128. | `200 SessionView`, session+CSRF cookies; `Cache-Control: no-store`. | `INVALID_CREDENTIALS`, `ACCOUNT_DELETED`. | `I:opt` |
| `DELETE /auth/session` | `Session`, включая `deleting` | CSRF; body отсутствует. | `204`; повторный logout также `204`. | — | `I:—` (HTTP-idempotent) |
| `POST /auth/password-resets` | `Public`; rate limit | Email ≤320; ответ не перечисляет аккаунт. | `202 OperationAccepted`. | Только generic/rate-limit. | `I:req` |
| `POST /auth/password-resets/confirm` | `Public` | One-time token; новый password 12..128. | `204`, все старые sessions отзываются. | `TOKEN_INVALID_OR_EXPIRED`, `PASSWORD_REUSED`. | `I:req` |
| `GET /me` | `Session`, включая `unverified/deleting` | Нет body. | `200 CurrentAccount`; `Cache-Control: no-store`. | — | `—` |

### 6.2 Profiles, resumes, catalog и search

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `GET /me/profile` | `Session`; владелец, включая draft | — | `200 Profile`; `ETag`. | — | `—` |
| `PATCH /me/profile` | `Active`; владелец | `ProfileInput`; fullName/specialization ≤200; student institute+course 1..6, teacher department, employer company; media ready/approved. Новая immutable version уходит на moderation. | `202 Profile` с `publicationState`; `ETag`. | `CONTENT_EDIT_LOCKED`, `MEDIA_NOT_READY`, `ROLE_FIELDS_INVALID`. | `I:req, C:yes` |
| `GET /profiles/{accountId}` | `Active`; видимый approved профиль | UUID path. | `200 PublicProfile` с primary и visible additional resumes; view не раскрывает email. | — | `—` |
| `GET /me/resumes` | `Active`; владелец | — | `200 ResumeList` (максимум 6, slot order). | — | `—` |
| `POST /me/resumes` | `Active`; владелец | `ResumeInput`; только additional; about ≤1024, projects ≤10, tags ≤20, URL/length validation. | `202 Resume`; moderation pending; `ETag`. | `RESUME_LIMIT_REACHED`, `TAG_NOT_FOUND`, `MEDIA_NOT_READY`. | `I:req` |
| `GET /me/resumes/{resumeId}` | `Active`; владелец, включая hidden/draft | UUID path. | `200 Resume`; `ETag`. | — | `—` |
| `PATCH /me/resumes/{resumeId}` | `Active`; владелец | `ResumeInput`; primary нельзя скрыть; те же limits. | `202 Resume`; `ETag`. | `PRIMARY_RESUME_MUST_BE_VISIBLE`, `CONTENT_EDIT_LOCKED`, limits. | `I:req, C:yes` |
| `DELETE /me/resumes/{resumeId}` | `Active`; владелец additional resume | — | `204`; snapshot уже отправленного resume сохраняется с application. | `PRIMARY_RESUME_CANNOT_BE_DELETED`. | `I:req, C:yes` |
| `GET /catalog/tags` | `Active` | `If-None-Match` optional. | `200 TagCatalog` или `304`; стабильный `sortOrder`. | — | bounded; `S:sortOrder`, `F:category` |
| `GET /search/people` | `Active` | `q` ≤200 ищет только ФИО; `tagId` ≤20; `tagMode`; `role`, `institute`, `department`; sort `activity_desc` default или `activity_asc`. | `200 PeopleSearchPage`; activity value скрыт. | `TAG_NOT_FOUND`. | `P; S/F` как слева |
| `GET /search/opportunities` | `Active` | `q` ≤200 ищет title; `tagId` ≤10; `authorKind`, только для personal: `authorRole/institute/department`; sort `popularity_desc|popularity_asc|newest` (`popularity_desc` default). | `200 OpportunitySearchPage`; popularity value скрыт. | `FILTER_NOT_APPLICABLE`, `TAG_NOT_FOUND`. | `P; S/F` как слева |

### 6.3 Uploads и media

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /uploads` | `Active`; owner contract проверяет объект | `UploadCreate`: JPEG/PNG/WebP, size ≤5 MiB, `contentScope`, allowlisted ownerType/ownerId; Messaging может запросить только `private_message`. | `201 UploadSession` с short-lived scoped PUT URL. | `UPLOAD_SCOPE_MISMATCH`, `UPLOAD_LIMIT_EXCEEDED`, `OWNER_NOT_FOUND`. | `I:req` |
| `POST /uploads/{uploadId}/complete` | `Active`; uploader | Uploaded object должен соответствовать session. | `202 UploadSession`; processing асинхронен. | `UPLOAD_NOT_FOUND`, `UPLOAD_EXPIRED`, `UPLOAD_OBJECT_MISMATCH`. | `I:req` |
| `GET /uploads/{uploadId}` | `Active`; uploader | — | `200 UploadSession`: `processing|ready|moderation_pending|approved|rejected|failed`. | — | `—` |
| `GET /media/{mediaId}/download-url` | `Active`; текущая object-level permission | Нет body; signed URL нельзя кешировать. | `200 DownloadUrl`, TTL ≤5 минут; `Cache-Control: no-store`. | `MEDIA_NOT_READY`, `MEDIA_NO_LONGER_STORED`. | `—` |

### 6.4 Opportunities и applications

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /opportunities` | `Active`; personal author=self либо team author=current leader | `OpportunityInput`: 23 type codes; customTypeName required only for `other` ≤80; title ≤200, description ≤5000, contact ≤500, exactly one approved cover, tags 1..10. | `202 Opportunity`; moderation pending; `ETag`. | `NOT_TEAM_LEADER`, `CUSTOM_TYPE_REQUIRED`, `MEDIA_NOT_READY`, limits. | `I:req` |
| `GET /opportunities/{opportunityId}` | `Active`; published viewer либо author/leader для own state | — | `200 Opportunity`; view fact idempotently учитывается, без absolute popularity; `ETag` владельцу. | — | `—` |
| `GET /me/opportunities` | `Active`; personal author и led-team author resources | `authorKind`, `state`. | `200 OpportunityPage`. | — | `P; S:created_desc; F` |
| `PATCH /opportunities/{opportunityId}` | `Active`; personal author или team leader | Полный `OpportunityInput`; новая version, last approved остаётся public до решения. | `202 Opportunity`; `ETag`. | `CONTENT_EDIT_LOCKED`, `OPPORTUNITY_DELETING`, media/tag errors. | `I:req, C:yes` |
| `POST /opportunities/{opportunityId}/deactivation` | `Active`; author/leader | Empty body. | `200 Opportunity(state=inactive)`; `ETag`. | `STATE_CONFLICT`. | `I:req, C:yes` |
| `DELETE /opportunities/{opportunityId}` | `Active`; author/leader | — | `202 DeletionStatus`; immediately hidden, cascade restartable. | `DELETION_ALREADY_IRREVERSIBLE`. | `I:req, C:yes` |
| `POST /opportunities/{opportunityId}/applications` | `Active`; candidate | `resumeId`; visible или собственное hidden resume допустимо; snapshot создаётся atomically. | `201 Application`; новая/повторная pending application. | `OWN_OPPORTUNITY`, `TEAM_MEMBER_CANNOT_APPLY`, `INTERACTION_BLOCKED`, `APPLICATION_COOLDOWN` (`eligibleAt`), `APPLICATION_ALREADY_ACCEPTED`. | `I:req` |
| `GET /opportunities/{opportunityId}/applications` | `Active`; personal author/team leader | Только current `pending`; `cursor/limit`. | `200 ApplicationPage` со snapshot и актуальным public profile link. | — | `P; S:created_asc|created_desc; F:pending only` |
| `GET /applications/{applicationId}` | `Active`; candidate или recipient side | Только текущий record; завершённая очищенная история может дать 404. | `200 Application`. | — | `—` |
| `POST /applications/{applicationId}/decision` | `Active`; author/team leader | `{decision: accepted|rejected}`; только `pending`. | `200 Application`; acceptance может вернуть `conversationStatus=pending|failed`. | `APPLICATION_ALREADY_DECIDED`, `INTERACTION_BLOCKED`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `POST /applications/{applicationId}/conversation-retry` | `Active`; accepted candidate или recipient | Только accepted и chat `failed|pending`; empty body. | `202 Application(conversationStatus=pending|ready)`. | `APPLICATION_NOT_ACCEPTED`, `CONVERSATION_ALREADY_READY`. | `I:req` |

### 6.5 Teams, membership, subscriptions и team blocks

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /teams` | `Active` | `TeamInput`: name ≤200, about ≤3000, projects bounded by payload, product tag IDs, optional approved avatar. Creator becomes immutable leader. | `202 Team`; moderation pending; `ETag`. | media/tag/size errors. | `I:req` |
| `GET /teams/{teamId}` | `Active`; active team viewer либо leader for draft | — | `200 Team`; `ETag` лидеру. | — | `—` |
| `GET /me/teams` | `Active` | Optional `relation=leader|member`. | `200 TeamPage`. | — | `P; S:created_desc; F:relation` |
| `PATCH /teams/{teamId}` | `Active`; leader | `TeamInput`; новая moderated version. | `202 Team`; `ETag`. | `CONTENT_EDIT_LOCKED`, `TEAM_DELETING`. | `I:req, C:yes` |
| `DELETE /teams/{teamId}` | `Active`; leader | — | `202 DeletionStatus`; team immediately hidden. | `TEAM_DELETING`. | `I:req, C:yes` |
| `GET /teams/{teamId}/members` | `Active`; видимая team | — | `200 TeamMemberPage`. | — | `P; S:joined_asc` |
| `DELETE /teams/{teamId}/members/{accountId}` | `Active`; leader; target member | — | `204`; notification via outbox. | `LEADER_CANNOT_REMOVE_SELF`, `MEMBERSHIP_NOT_FOUND`, `STATE_CONFLICT`. | `I:req, C:yes(team)` |
| `POST /teams/{teamId}/leave` | `Active`; member, не leader | Empty body. | `204`. | `LEADER_CANNOT_LEAVE`, `MEMBERSHIP_NOT_FOUND`, `STATE_CONFLICT`. | `I:req` |
| `POST /teams/{teamId}/join-requests` | `Active`; applicant | `resumeId`, `contribution` 1..1000; immutable snapshot. | `201 JoinRequest`. | `ALREADY_MEMBER`, `INTERACTION_BLOCKED`, `JOIN_REQUEST_EXISTS`, `JOIN_REQUEST_COOLDOWN` (`eligibleAt`). | `I:req` |
| `GET /teams/{teamId}/join-requests/me` | `Active`; applicant | — | `200 JoinRequest` для current pending/rejected cooldown record. | — | `—` |
| `DELETE /teams/{teamId}/join-requests/me` | `Active`; applicant, pending request | — | `204`; immediate reapply allowed. | `JOIN_REQUEST_NOT_PENDING`. | `I:req, C:yes` |
| `GET /teams/{teamId}/join-requests` | `Active`; leader | Pending only. | `200 JoinRequestPage`. | — | `P; S:created_asc|created_desc` |
| `POST /join-requests/{requestId}/decision` | `Active`; team leader | `{decision: approved|rejected}`; approved atomically creates membership. | `200 JoinRequest`. | `JOIN_REQUEST_ALREADY_DECIDED`, `INTERACTION_BLOCKED`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `POST /teams/{teamId}/invitations` | `Active`; leader | `accountId`; user must not be leader/member/blocked/already invited. | `201 TeamInvitation`. | `ALREADY_MEMBER`, `INTERACTION_BLOCKED`, `INVITATION_EXISTS`. | `I:req` |
| `GET /teams/{teamId}/invitations` | `Active`; leader | Pending only. | `200 TeamInvitationPage`. | — | `P; S:created_desc` |
| `GET /me/team-invitations` | `Active`; invitee | Pending only. | `200 TeamInvitationPage`. | — | `P; S:created_desc` |
| `POST /team-invitations/{invitationId}/decision` | `Active`; invitee | `{decision: accepted|rejected}`; acceptance atomically creates membership. | `200 TeamInvitation`. | `INVITATION_ALREADY_DECIDED`, `INTERACTION_BLOCKED`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `DELETE /team-invitations/{invitationId}` | `Active`; leader of source team | Revokes pending invitation. | `204`. | `INVITATION_NOT_PENDING`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `PUT /teams/{teamId}/subscription` | `Active`; any viewer | Empty body. | `204`; duplicate is `204`. | `TEAM_NOT_ACTIVE`. | HTTP-idempotent |
| `DELETE /teams/{teamId}/subscription` | `Active`; subscriber | — | `204`; duplicate is `204`, events disappear from calendar. | — | HTTP-idempotent |
| `GET /teams/{teamId}/subscribers` | `Active`; leader | Search-volume public profile projection only. | `200 SubscriberPage`. | — | `P; S:created_desc` |
| `PUT /teams/{teamId}/blocks/{accountId}` | `Active`; leader | Optional allowlisted `reasonCode`; atomically rejects request/revokes invitation. | `204`; history remains. | `LEADER_CANNOT_BLOCK_SELF`, `MEMBER_MUST_BE_REMOVED_FIRST`. | HTTP-idempotent; `C:yes(team)` |
| `DELETE /teams/{teamId}/blocks/{accountId}` | `Active`; leader | — | `204`. | — | HTTP-idempotent; `C:yes(team)` |
| `GET /teams/{teamId}/blocks` | `Active`; leader | — | `200 BlockedAccountPage`. | — | `P; S:created_desc` |

### 6.6 Events и calendar

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /teams/{teamId}/events` | `Active`; leader | `EventInput`: title ≤200, description ≤5000 contains place/format, approved cover, tags, `startsAt`+valid IANA `timezone`; no recurrence. | `202 TeamEvent`; moderation pending; `ETag`. | `INVALID_EVENT_TIME`, `MEDIA_NOT_READY`, `NOT_TEAM_LEADER`. | `I:req` |
| `GET /teams/{teamId}/events` | `Active`; leader | Optional state; management view includes draft/pending/cancelled. | `200 CalendarEventPage`. | — | `P; S:starts_at_asc; F:state` |
| `GET /events/{eventId}` | `Active`; subscriber/leader while visible | — | `200 TeamEvent`; cancelled state explicit. | — | `—` |
| `PATCH /events/{eventId}` | `Active`; leader | `EventInput`; new moderated version; schedule fields update transactionally. | `202 TeamEvent`; `ETag`. | `CONTENT_EDIT_LOCKED`, `EVENT_CANCELLED`, validation. | `I:req, C:yes` |
| `POST /events/{eventId}/cancellation` | `Active`; leader | Empty body. | `200 TeamEvent(state=cancelled)`; followers notified. | `EVENT_ALREADY_CANCELLED`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `DELETE /events/{eventId}` | `Active`; leader | — | `202 DeletionStatus`. | `EVENT_DELETING`. | `I:req, C:yes` |
| `GET /calendar` | `Active`; source teams are current subscriptions | Required `from/to` RFC3339, `from < to`, range ≤366 days; optional `timezone`. | `200 CalendarEventPage`. | `INVALID_DATE_RANGE`, `INVALID_TIMEZONE`. | `P; S:starts_at_asc; F:range` |

### 6.7 Messaging и personal blocks

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /conversations/direct` | `Active`; participant | `otherAccountId`; normalized pair unique. | `200 Conversation` if exists, otherwise `201`. | `CANNOT_MESSAGE_SELF`, `INTERACTION_BLOCKED`. | `I:req` |
| `GET /conversations` | `Active`; participant | Optional `kind`. | `200 ConversationPage`, unread summary. | — | `P; S:sort_at_desc; F:kind` |
| `GET /conversations/{conversationId}` | `Active`; participant/current team leader participant | — | `200 Conversation`; application context included, no message body broadcast cache. | — | `—` |
| `DELETE /conversations/{conversationId}` | `Active`; participant | Query `scope=me|both` required; `both` starts irreversible physical cleanup and blocks writes. | `204` for `me`; `202 DeletionStatus` for `both`. | `CONVERSATION_DELETING`, `DELETE_SCOPE_INVALID`. | `I:req` |
| `GET /conversations/{conversationId}/messages` | `Active`; participant | `cursor`, `limit` default 30 max100, optional `before`; snapshot-like descending cursor. | `200 MessagePage`; deleted media represented by tombstone. | — | `P; S:created_desc` |
| `POST /conversations/{conversationId}/messages` | `Active`; authorized/unblocked sender | `body` optional ≤5000; `mediaIds` ≤10, all own private/ready; body or media required. One transaction binds media and applies 500-photo eviction only after success. | `201 Message`; `ETag`. | `INTERACTION_BLOCKED`, `MEDIA_NOT_READY`, `MEDIA_SCOPE_MISMATCH`, `MESSAGE_EMPTY`. | `I:req` |
| `PATCH /messages/{messageId}` | `Active`; sender | `{body}` 1..5000; attachments unchanged; ordinary history not retained. | `200 Message(edited=true)`; `ETag`. | `MESSAGE_DELETED`, `CONTENT_EDIT_LOCKED`. | `I:req, C:yes` |
| `DELETE /messages/{messageId}` | `Active`; sender | — | `204`; body/bindings cleared, live-chat tombstone allowed. | `MESSAGE_ALREADY_DELETED`. | `I:req, C:yes` |
| `POST /conversations/{conversationId}/read` | `Active`; participant | `{lastReadMessageId}` belonging to conversation; cursor only moves forward. | `204`; duplicate/older cursor is no-op. | `MESSAGE_NOT_IN_CONVERSATION`. | `I:req` |
| `GET /me/blocks` | `Active`; blocker | — | `200 BlockedAccountPage`. | — | `P; S:created_desc` |
| `PUT /me/blocks/{accountId}` | `Active`; blocker | Empty body; atomically prevents/ends pending cross-user interactions; chat history stays. | `204`. | `CANNOT_BLOCK_SELF`, `STATE_CONFLICT`. | HTTP-idempotent |
| `DELETE /me/blocks/{accountId}` | `Active`; blocker | — | `204`; existing history remains. | — | HTTP-idempotent |

### 6.8 Notifications

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `GET /notifications` | `Session` для собственного аккаунта; `active` normally | Optional `unreadOnly`, `type`. | `200 NotificationPage`; payload минимален, переход повторно авторизуется. | — | `P; S:created_desc; F` |
| `PATCH /notifications/{notificationId}` | `Session`; recipient | `{read: true}` only. | `200 Notification`; повтор безопасен. | `NOTIFICATION_NOT_FOUND`. | `I:opt, C:yes` |
| `POST /notifications/read-all` | `Session`; recipient | Optional `{before}` timestamp. | `200 {updatedCount}`. | — | `I:req` |

### 6.9 Reports, appeals и moderator API

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /reports` | `Active`; reporter can access target | `targetType`, `targetId`, `kind=content|impersonation`, reason 1..2000. Message revision/evidence captures atomically. | `201 Report(status=accepted, deadlineAt)`. | `OPEN_REPORT_EXISTS`, `TARGET_NOT_REPORTABLE`, `EVIDENCE_CAPTURE_FAILED`. | `I:req` |
| `GET /me/reports` | `Active`; reporter | Optional `status`. | `200 ReportPage`. | — | `P; S:created_desc; F:status` |
| `GET /reports/{reportId}` | `Active`; reporter, target content owner, or assigned moderator with permission; response field-level filtered | — | `200 Report`; reporter identity is not exposed to content owner. | — | `—` |
| `POST /moderation-decisions/{decisionId}/appeals` | `Active`; affected content owner | Reason 1..2000; only return-for-revision; once per decision. | `201 Appeal(status=pending, deadlineAt)`; editing locks. | `APPEAL_ALREADY_EXISTS`, `DECISION_NOT_APPEALABLE`. | `I:req` |
| `GET /me/appeals` | `Active`; appellant | Optional status. | `200 AppealPage`. | — | `P; S:created_desc; F:status` |
| `GET /moderation/reports` | `Moderator(reports.review)` | `status`, `kind`, `priority`, `assignedToMe`. | `200 ReportPage`; SLA sort. | — | `P; S:priority_desc_deadline_asc; F` |
| `POST /moderation/reports/{reportId}/claim` | `Moderator(reports.review)` | Empty body; unassigned/open only. | `200 Report`; `ETag`. | `ALREADY_ASSIGNED`, `REPORT_ALREADY_RESOLVED`. | `I:req, C:yes` |
| `GET /moderation/reports/{reportId}/evidence` | `Moderator(evidence.view)`; assigned open report | — | `200 Evidence`; one-time attachment URLs; `Cache-Control: no-store`; access audited. | `EVIDENCE_UNAVAILABLE`, `REPORT_NOT_ASSIGNED`. | `—` |
| `POST /moderation/reports/{reportId}/decision` | `Moderator(reports.review)`; assignee | `{decision: confirmed|rejected, reason}`; terminal CAS. | `200 Report`; confirmed returns content for revision, never deletes. | `REPORT_ALREADY_RESOLVED`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `GET /moderation/reviews` | `Moderator(reports.review)` | `status`, `contentType`, `assignedToMe`, `escalated`; escalated requires permission to claim/decide. | `200 ManualReviewPage`. | — | `P; S:priority_desc_deadline_asc; F` |
| `POST /moderation/reviews/{reviewId}/claim` | `Moderator(reports.review)`; escalated item additionally `moderation.escalated_review` | Empty body. | `200 ManualReview`; `ETag`. | `ALREADY_ASSIGNED`, `REVIEW_ALREADY_RESOLVED`. | `I:req, C:yes` |
| `POST /moderation/reviews/{reviewId}/decision` | Same permission; assignee | `{decision: approved|returned, reason}`. | `200 ManualReview`; no fail-open. | `REVIEW_ALREADY_RESOLVED`, `STATE_CONFLICT`. | `I:req, C:yes` |
| `GET /moderation/appeals` | `Moderator(appeals.review)` | `status`, `assignedToMe`, `escalated`. | `200 AppealPage`. | — | `P; S:priority_desc_deadline_asc; F` |
| `POST /moderation/appeals/{appealId}/claim` | `Moderator(appeals.review)`; escalated requires extra permission | Empty body. | `200 Appeal`; `ETag`. | `ALREADY_ASSIGNED`, `APPEAL_ALREADY_RESOLVED`. | `I:req, C:yes` |
| `POST /moderation/appeals/{appealId}/decision` | Same permission; assignee | `{decision: upheld|overturned, reason}`; terminal CAS. | `200 Appeal`; overturned restores last approved version. | `APPEAL_ALREADY_RESOLVED`, `STATE_CONFLICT`. | `I:req, C:yes` |

### 6.10 Privacy requests и account deletion

| Method/path | Authentication / authorization | Request и validation | Response / HTTP | Business errors | I/C/P/S/F |
|---|---|---|---|---|---|
| `POST /privacy-requests` | `Session`; owner; deletion requires recent password confirmation/session re-auth; allowed in `active` | `{type: export|correction|restriction|deletion, description?}`; description required for correction, ≤2000. Deletion immediately hides account and revokes other sessions. | `202 PrivacyRequest`; deletion includes `irreversibleAt` (+7d) and `deadlineAt` (≤30d from request). | `OPEN_DELETION_REQUEST_EXISTS`, `REAUTH_REQUIRED`. | `I:req` |
| `GET /privacy-requests` | `Session`, включая `deleting`; owner | — | `200 PrivacyRequestPage`; result download only through separately authorized short-lived URL. | — | `P; S:requested_desc; F:type,status` |
| `GET /privacy-requests/{requestId}` | `Session`, включая `deleting`; owner | — | `200 PrivacyRequest`; `Cache-Control: no-store`; `ETag`. | — | `—` |
| `GET /privacy-requests/{requestId}/result-url` | `Session`; owner; completed export only | — | `200 DownloadUrl`, one-time TTL ≤5 минут; `Cache-Control: no-store`. | `PRIVACY_RESULT_NOT_READY`, `PRIVACY_RESULT_EXPIRED`. | `—` |
| `POST /privacy-requests/{requestId}/cancel` | `Session` в `deleting`; owner; only deletion before irreversible point | Empty body. | `200 PrivacyRequest(status=cancelled)` и restored active session/account. | `DELETION_ALREADY_IRREVERSIBLE`, `REQUEST_NOT_CANCELLABLE`. | `I:req, C:yes` |

## 7. Realtime contract

Socket.IO работает по WSS и принимает ту же opaque session только с allowlisted same-origin `Origin`. Сервер авторизует connection и каждую room subscription; имена room от клиента не считаются доверенными. Logout/revoke/deleting disconnect-ит sockets через Redis fan-out.

```json
{
  "eventId": "0198...",
  "type": "message.created",
  "occurredAt": "2026-08-19T12:00:00Z",
  "resourceType": "conversation",
  "resourceId": "0198..."
}
```

Разрешённые hints MVP: `notification.created`, `message.created`, `message.updated`, `conversation.updated`, `moderation.updated`, `deletion.updated`. Event не содержит message text, resume snapshot или media URL. Доставка at-least-once, порядок между aggregates не гарантирован; клиент дедуплицирует `eventId`, инвалидирует TanStack Query cache и после reconnect/refetch получает source-of-truth через REST.

## 8. Проверки контракта

- OpenAPI lint/parse, uniqueness `operationId`, generated TypeScript client compile и проверка, что все non-GET operations документируют security, CSRF, idempotency и concurrency.
- Contract tests: cookie/Origin/CSRF; object-level 404 masking; idempotency replay и payload mismatch; stale `If-Match`; двойное решение application/membership/moderation; retry после accepted application при сбое chat; cursor tampering/filter mismatch; unknown response fields.
- Schema compatibility gate блокирует removed/renamed/required fields, narrowed enums/formats и изменённые status codes без новой major version.
- Load/integration tests проверяют cursor access paths и заявленные sort/filter combinations; новый filter не добавляется в контракт без query plan и индекса либо доказанного bounded scan.
