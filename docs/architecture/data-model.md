# Модель данных

Документ фиксирует критические межмодульные сущности и ограничения MVP. Полная физическая Prisma schema уточняется вместе с feature implementation, но не может ослаблять указанные инварианты.

## Общие правила

- Каждый модуль владеет отдельной PostgreSQL schema и своими migrations.
- Идентификаторы — UUIDv7, время — `timestamptz` в UTC, пользовательский timezone — IANA ID.
- Другой модуль использует публичный command/query contract; прямой SQL к чужой schema запрещён.
- Response DTO и события не являются ORM-моделями.
- Критические инварианты дублируются UNIQUE/CHECK/FK или conditional update, а не остаются только в application code.

## Identity

### `identity.accounts`

Ключевые поля: `id`, `email_normalized`, `formal_role`, `state`, `email_verified_at`, `created_at`, `updated_at`.

Ограничения:

- UNIQUE `email_normalized`;
- `state`: `unverified | active | deleting | deleted`;
- formal role не является системным permission.

### `identity.sessions`

Хранит `session_hash`, `account_id`, `expires_at`, `revoked_at`, `last_seen_at`. Исходный session ID в БД не хранится. Индексы: UNIQUE `session_hash`, `(account_id, revoked_at)`.

Системные permissions назначаются отдельно: `reports.review`, `appeals.review`, `evidence.view`, `moderation.escalated_review`.

## Files

### `files.upload_sessions`

Ключевые поля: `id`, `owner_id`, `content_scope`, `owner_type`, `owner_ref`, `state`, `expires_at`.

- `content_scope`: `private_message | public_content`, неизменяем после создания;
- `state`: `created | uploaded | processing | technically_ready | failed | expired`;
- `owner_type/owner_ref` связывают upload только с ожидаемым объектом.

### `files.media_objects`

Ключевые поля: `id`, `uploader_id`, `content_scope`, `state`, `bucket`, `object_key`, `sha256`, `mime`, `size_bytes`, `width`, `height`, `created_at`, `deleted_at`.

Публичный state machine:

```text
uploaded -> quarantined -> sanitized -> technically_ready
         -> moderation_pending -> approved | rejected | moderation_failed
         -> attached_to_published_version
```

Приватный объект завершается на `technically_ready` и не может перейти в `moderation_pending`. CHECK/trigger либо эквивалентный conditional update запрещает такой переход. Object key случаен и не содержит PII.

## Messaging и evidence

### `messaging.messages`

Хранит current text/version, sender, conversation, read state, edited/deleted timestamps. Доступ ограничен сторонами conversation и назначенным модератором по открытой жалобе.

### `messaging.reported_revisions`

Создаётся только при жалобе на сообщение и атомарно фиксирует текущие `message_id`, `message_version`, текст и время. Обычное редактирование историю не создаёт. Revision принадлежит Messaging и физически удаляется вместе с message/chat/account lifecycle.

### `trust.reports`

Ключевые поля: `id`, `reporter_id`, `target_type`, `target_id`, `status`, `kind`, `assignee_id`, `deadline_at`, `created_at`, `resolved_at`.

Partial UNIQUE запрещает более одной открытой жалобы одного пользователя на один объект.

### `trust.report_evidence`

Хранит `report_id`, `message_revision_id`, attachment IDs, `state: available | unavailable`, но не текст и не media. При физическом удалении источника workflow удаляет revision/attachments и переводит evidence в `unavailable`. Восстановление из backup для модерации запрещено.

Audit просмотра содержит только `actor_id`, `report_id`, evidence IDs, время и результат.

## Автомодерация

### `trust.moderation_requests`

Ключевые поля: `id`, `content_type`, `content_version_id`, `policy_version`, `state`, `generation`, `active_endpoint`, `provider_request_key`, `pending_since`, `decided_at`, `violation_codes`.

Ограничения:

- UNIQUE `(content_type, content_version_id, policy_version)`;
- `content_type` допускает только публичные сущности;
- provider result завершает request только conditional update по текущим `generation` и `active_endpoint`;
- failover увеличивает generation, поэтому поздний ответ предыдущего endpoint не меняет решение;
- `approved` является единственным состоянием, разрешающим публикацию соответствующей версии.

## Interaction serialization

`trust.interaction_pairs` имеет ключ `(scope, subject_low, subject_high)`, где `subject_low < subject_high`. Блокировка и новая interaction command берут одну строку `FOR UPDATE`. Несколько пар блокируются лексикографически. Deadlock/serialization failure повторяется ограниченно под тем же idempotency key.

## Delivery и идемпотентность

- `platform.idempotency_records`: UNIQUE `(actor_id, route, key)`, request hash, state, response reference, expiry.
- `platform.outbox_events`: immutable event envelope и occurred time.
- `platform.outbox_deliveries`: UNIQUE `(event_id, consumer)`, attempt/lease/completed state.
- consumer inbox: UNIQUE `event_id` в owning module и эффект в одной транзакции.

## Retention

- Quarantine: не более 24 часов.
- Пользовательские backups: не более 21 дня.
- Messages, reported revisions и attachments удаляются по lifecycle чата/аккаунта и не копируются в legal evidence.
- `trust.report_evidence` после удаления источника хранит только допустимые metadata до удаления пользовательского контура.
- Минимальные юридические доказательства согласий/уничтожения находятся в отдельной database с отдельными credentials и сроком до трёх лет.
