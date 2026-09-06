# Наблюдаемость входа и восстановления доступа

Сценарий TASK-005 экспортирует OpenTelemetry metrics через Prometheus endpoint каждого процесса. SDK запускается **до импорта** Identity/worker: их instruments создаются при загрузке модулей. Endpoint закрывается через Nest shutdown hook. Production-хранилище остаётся managed согласно ADR-014; собственная production observability platform не вводится.

## Подключение

- API: `http://127.0.0.1:9464/metrics`, worker: `http://127.0.0.1:9465/metrics`. Настройки `METRICS_HOST` (по умолчанию `127.0.0.1`) и `METRICS_PORT` задаются отдельно для каждого процесса. Занятый порт останавливает запуск с безопасной ошибкой `METRICS_START_FAILED`.
- Docker Compose использует `METRICS_HOST=0.0.0.0` внутри private network; порты метрик не публикуются на host и не проксируются Nginx. Collector должен иметь private доступ к `api:9464` и `worker:9465`. В production endpoint разрешён только collector service identity через сетевые правила.
- [prometheus.yml](../../infra/observability/prometheus.yml) содержит scrape jobs и подключение [auth-alerts.yml](../../infra/observability/auth-alerts.yml), интервал сбора/вычисления — 15 секунд. Для нескольких API/worker instances перечислить все targets либо использовать service discovery; не scrape-ить балансировщик вместо отдельных instances.
- [auth-dashboard.json](../../infra/observability/auth-dashboard.json) импортируется в Grafana с выбором существующего Prometheus datasource. В managed backend импортировать правила и настроить маршрутизацию `severity=warning|critical` к дежурным. Выбор production tenant, credentials и адресатов требует инфраструктуры оператора; они не хранятся в репозитории. Наличие этих файлов не означает, что они уже применены в production.
- Перед выпуском проверить `up=1` для обеих process roles, метрики синтетического login/CSRF/reset и доставку тестового alert адресату. Недоступность коллектора не участвует в auth-транзакциях.

## Регрессионные проверки

`backend/tests/unit/metrics-runtime.test.ts` проверяет HTTP export реальных Identity counters, удаление чувствительных attributes, worker backlog/age, восстановление нулевых значений и закрытие endpoint. `infra/observability/auth-alerts.test.yml` проверяет пороги, minimum traffic, firing/resolution и недоступность scrape. Правила проверяются в CI:

```text
promtool check config prometheus.yml
promtool test rules auth-alerts.test.yml
```

Команды выполняются из `infra/observability` с promtool 3.5.1. HTTP-проверки SDK не требуют PostgreSQL, Redis или Docker.

## Dashboard

- `identity.auth.commands`: `operation=login|logout|reset_request|reset_confirm`, `result=completed|failed|rate_limited`. `completed` включает безопасный replay, а reset request не раскрывает наличие аккаунта.
- `identity.csrf.failures`: количество отказов Origin/CSRF без user/session labels.
- `outbox.delivery.attempts`, `outbox.delivery.duration` с `consumer=identity.password-reset-email`; `outbox.oldest_pending.age` и backlog/dead-letter из существующей outbox диагностики.
- `outbox.delivery.backlog{consumer,state}` и `outbox.delivery.oldest_pending_age{consumer}` — текущие gauges из PostgreSQL, а не сумма измерений. Возраст измеряется в миллисекундах и становится `0`, когда pending/leased deliveries больше нет. DLQ учитывается отдельно. При нескольких workers, читающих одну БД, dashboard/alerts используют `max`, чтобы не умножать общий backlog на число процессов.
- В Prometheus точки в именах заменены на `_`, counters получают `_total`; единицы времени остаются `ms`. Exporter пропускает только `operation`, `result`, `consumer`, `state` и добавляет фиксированные `service`, `process_role`.
- Корреляция HTTP → outbox: `requestId`, `correlationId`, `eventId`/delivery ID. Email, IP, password, token, CSRF, cookie и URL не являются labels или содержимым ошибок.

## Alerts

- Ненулевой reset dead-letter backlog — warning, включая backlog после рестарта; перейти к процедуре восстановления доставки в `runbook.md`.
- Возраст незавершённой доставки >5 минут — warning, >30 минут — critical. При истечении reset token просроченное письмо пропускается; пользователь запрашивает новое.
- Доля failed login/reset >5% за 10 минут при ≥20 запросах — warning. Сопоставить с rate limiter и доступностью БД, не искать email в логах.
- Более 20 CSRF failures за 5 минут — warning: проверить точный Origin, proxy/TLS/cookie settings и изменение session; возможен чужой origin или устаревшая вкладка.
- Scrape API/worker недоступен 2 минуты — warning: проверить процесс, private connectivity и bind/port; отсутствие метрик нельзя трактовать как отсутствие ошибок.

## Ограничения

SMTP имеет at-least-once delivery. Стабильный Message-ID помогает диагностике, но не гарантирует отсутствие повторного письма после сбоя между отправкой и commit delivery. Повторная ссылка не меняет пароль после consumption. Не записывать SMTP exception text: worker сохраняет только allowlisted error codes либо `DELIVERY_FAILED`.
