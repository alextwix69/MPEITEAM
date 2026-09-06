# Наблюдаемость регистрации

Статус: dashboard/alert contract регистрации. TASK-005 подключил общий OpenTelemetry SDK и private Prometheus exporter для API и worker; существующие registration instruments также экспортируются. Настройка collector и production-адресатов описана в `auth-observability.md`. Этот документ не утверждает наличие применённого registration dashboard в managed tenant.

## Dashboard

- `identity.registration.requests` по `result=created|replayed|failed|rate_limited`;
- `identity.email_verification.requests` по `result=activated|replayed|failed|rate_limited`;
- `identity.email_verification.resends` по `result=accepted|replayed|failed|rate_limited`;
- `identity.email_verification.age` p50/p95/p99 от выпуска token до предъявления;
- `outbox.delivery.attempts` по безопасным `consumer` и `result=completed|retry|dead_letter`;
- `outbox.delivery.duration` p50/p95/p99 по consumer;
- `outbox.oldest_pending.age` и количество deliveries в `dead_letter`; age записывается worker по старейшему событию с delivery в `pending|leased`.

Labels не содержат account ID, email, IP, token, document version или profile data.

## Alerts

- любая новая `dead_letter` delivery — warning немедленно;
- oldest outbox delivery старше 5 минут — warning, старше 30 минут — critical;
- `compliance.consent-evidence` retry более 5 минут либо рост `CONSENT_EVIDENCE_UNAVAILABLE` — warning;
- `identity.verification-email` retry более 5 минут — warning;
- доля failed registration/verification выше 5% за 10 минут при минимум 20 запросах — warning;
- отсутствие successful worker deliveries при ненулевом pending backlog 5 минут — critical.

Каждый alert ведёт в соответствующий раздел `docs/production/runbook.md` и сохраняет только correlation/event/delivery IDs.
