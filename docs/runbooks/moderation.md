# Runbook автоматической модерации

## Назначение

Воркер принимает `profiles.moderation.requested` через delivery `trust.automated-moderation`, создаёт долговечную запись `trust.moderation_requests` и обрабатывает её независимо от Redis/outbox. Неодобренная или ещё не проверенная версия публично не выдаётся.

## Штатный поток

1. API атомарно сохраняет immutable version и outbox event.
2. `OutboxWorkerService` создаёт inbox marker и moderation request.
3. `ModerationWorkerService` захватывает request с lease и вызывает primary endpoint.
4. При transport error, timeout или открытом circuit выполняется CAS-переход на secondary endpoint с новой generation и новым provider idempotency key.
5. Решение, published pointer, состояние public media и notification outbox event фиксируются одной PostgreSQL-транзакцией.
6. `NotificationsService` создаёт одну in-app notification и одну email delivery. SMTP работает вне business transaction.

## Оба endpoint недоступны

Request возвращается в `pending` с `failure_code = PROVIDERS_UNAVAILABLE`. Версия остаётся скрытой, последняя одобренная версия продолжает выдаваться. После circuit reset воркер снова захватит request и начнёт новую generation с primary endpoint.

Проверить очередь:

```sql
SELECT id, content_type, state, generation, active_endpoint, pending_since, failure_code
FROM trust.moderation_requests
WHERE state IN ('pending', 'in_progress')
ORDER BY pending_since, id;
```

## Безопасный повтор

- Не изменять `generation`, `active_endpoint`, `provider_request_key` и `row_version` вручную.
- Повторная доставка исходного outbox event безопасна благодаря `trust.inbox_events` и unique constraint content/version/policy.
- Поздний provider result не проходит generation/endpoint/row-version CAS.
- Для восстановления достаточно вернуть зависимость в рабочее состояние: pending request будет подобран автоматически.

## Email

SMTP failure не отменяет moderation decision. Delivery повторяется с bounded exponential backoff и после пяти неудачных попыток переходит в `dead_letter`.

```sql
SELECT id, template_code, state, attempt_count, available_at, last_error_code
FROM notifications.email_deliveries
WHERE state IN ('failed', 'dead_letter')
ORDER BY available_at, id;
```

Перед ручным replay устранить причину сбоя и убедиться, что `provider_message_key` сохранён. Повтор должен использовать тот же ключ, чтобы provider мог подавить дубликат.

## Production gate

Production-конфигурация принимает только два различных HTTPS origin. Локальные deterministic endpoints предназначены только для development/test и не заменяют независимое эксплуатационное и юридическое одобрение providers и policy version.
