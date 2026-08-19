# API-контракты

Документ фиксирует общие и security-critical контракты MVP. Feature endpoints добавляются по мере реализации вертикальных сценариев и обязаны соблюдать эти правила.

## Общие правила REST

- Base path: `/api/v1`.
- HTTPS, JSON UTF-8, ISO 8601; timestamps содержат offset либо `Z`.
- Вход валидируется Zod на boundary; ORM-модели наружу не возвращаются.
- Большие списки используют cursor pagination.
- Изменяющие повторяемые команды принимают `Idempotency-Key`.
- Успех возвращается только после commit постоянного состояния.

Формат ошибки:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Понятное сообщение и следующее действие",
    "requestId": "uuid",
    "details": {}
  }
}
```

`details` не содержит secrets, email, message text, media URL или полное resume.

## Authentication и browser security

- Opaque session передаётся только `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
- Unsafe HTTP method требует allowlisted `Origin` и CSRF token.
- Неподтверждённый или удаляемый аккаунт получает только явно разрешённые Identity endpoints.
- Object-level authorization выполняется для каждого resource ID, включая signed URL.

## Socket.IO

Handshake:

1. Только WSS и allowlisted same-origin `Origin`.
2. Server проверяет opaque session и account state до `connection`.
3. Подписка на user/conversation room повторно проверяет permission; имя room от клиента не считается доверенным.
4. Logout/revoke/ограничение аккаунта отключает sockets через Redis fan-out.
5. Cross-origin handshake, чужая room и revoked-session reconnect возвращают отказ без раскрытия существования объекта.

Event envelope:

```json
{
  "eventId": "uuid",
  "type": "notification.created",
  "occurredAt": "2026-08-19T12:00:00Z",
  "resourceId": "uuid"
}
```

Realtime event является hint: после reconnect клиент получает source-of-truth через REST. Message text и private media URL не передаются в broadcast event.

## Media upload

### Создание upload session

`POST /api/v1/uploads`

Request содержит ожидаемые `contentScope`, owner type/ref, MIME и size. Server проверяет, что Messaging создаёт только `private_message`, а публичный feature — только `public_content`.

Response возвращает upload ID, short-lived presigned PUT и expiry. URL ограничен одним object key и максимальным размером.

### Завершение

`POST /api/v1/uploads/{id}/complete` с `Idempotency-Key` запускает техническую обработку. `GET /api/v1/uploads/{id}` возвращает state.

- `private_message`: `ready` после sanitization;
- `public_content`: после sanitization возвращает `moderation_pending`, публикация допустима только после `approved`;
- provider не получает quarantine object или bucket credentials.

## Жалоба и evidence

`POST /api/v1/reports` с `Idempotency-Key` создаёт жалобу. Для message target backend в одной транзакции фиксирует reported revision текущей версии и создаёт `ReportEvidence` reference.

`GET /api/v1/moderation/reports/{id}/evidence` доступен только назначенному модератору с `evidence.view` и только пока жалоба открыта. Ответ для текста имеет `Cache-Control: no-store`; attachment URL одноразовый, object-scoped и короткоживущий. Содержимое не логируется.

Если источник удалён, endpoint возвращает стабильный code `EVIDENCE_UNAVAILABLE`, не обращается к backup и не раскрывает удалённое содержимое.

## Provider contracts

`ContentModerator` принимает только `public_content`, policy version, sanitized text/media reference, request key, generation и callback/poll correlation. Result применяется conditional update только к active generation/endpoint; late result считается stale.

Timeout/transport error primary endpoint запускает secondary adapter. Если оба недоступны, пользовательский API возвращает сохранённый content version со state `moderation_pending`, но не `published`.

## Совместимость

- Внутри `/api/v1` — additive-only.
- Поля не удаляются, не переименовываются и не становятся обязательными в одном rolling window.
- Breaking change требует deprecation и новой major version.
- CI сравнивает OpenAPI с последним release и запускает old-client/new-API и new-client/old-API contract tests.
- Database schema изменяется expand/migrate/contract; contract выполняется после исчезновения старых consumers.

## Внутренние события

Минимальный envelope: `eventId`, `eventType`, `eventVersion`, `aggregateType`, `aggregateId`, `occurredAt`, `correlationId`, `causationId`, `actorId`, `payload`.

Consumer обязан либо понимать `eventVersion`, либо безопасно отложить delivery в DLQ. Неизвестные поля игнорируются, неизвестная major event version не интерпретируется предположительно.
