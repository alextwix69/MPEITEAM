# Наблюдаемость входа и восстановления доступа

Сценарий TASK-005 использует существующие OpenTelemetry meter API и vendor-neutral dashboard/alert contract. Экспортёр и адресаты production alerts остаются release prerequisite из `registration-observability.md`.

## Dashboard

- `identity.auth.commands`: `operation=login|logout|reset_request|reset_confirm`, `result=completed|failed|rate_limited`. `completed` включает безопасный replay, а reset request не раскрывает наличие аккаунта.
- `identity.csrf.failures`: количество отказов Origin/CSRF без user/session labels.
- `outbox.delivery.attempts`, `outbox.delivery.duration` с `consumer=identity.password-reset-email`; `outbox.oldest_pending.age` и backlog/dead-letter из существующей outbox диагностики.
- Корреляция HTTP → outbox: `requestId`, `correlationId`, `eventId`/delivery ID. Email, IP, password, token, CSRF, cookie и URL не являются labels или содержимым ошибок.

## Alerts

- Новая reset delivery в dead-letter — warning; перейти к процедуре восстановления доставки в `runbook.md`.
- Возраст незавершённой доставки >5 минут — warning, >30 минут — critical. При истечении reset token просроченное письмо пропускается; пользователь запрашивает новое.
- Доля failed login/reset >5% за 10 минут при ≥20 запросах — warning. Сопоставить с rate limiter и доступностью БД, не искать email в логах.
- Более 20 CSRF failures за 5 минут — warning: проверить точный Origin, proxy/TLS/cookie settings и изменение session; возможен чужой origin или устаревшая вкладка.

## Ограничения

SMTP имеет at-least-once delivery. Стабильный Message-ID помогает диагностике, но не гарантирует отсутствие повторного письма после сбоя между отправкой и commit delivery. Повторная ссылка не меняет пароль после consumption. Не записывать SMTP exception text: worker сохраняет только allowlisted error codes либо `DELIVERY_FAILED`.
