# ADR-006: Availability and disaster recovery

Статус: принято.
Дата: 19.08.2026.

## Контекст

Сервис должен обеспечивать 99,5% доступности, ежедневные backups, RPO не более 24 часов и RTO не более 8 часов при потере основной площадки или невосстановимой порче данных.

## Решение

Обычные отказы закрываются двумя application failure domains и managed PostgreSQL/Redis failover с внутренней целью восстановления до 15 минут. Для потери площадки используется cold DR target в РФ: отдельный backup failure domain, версионированные IaC, зарезервированные quotas, доступ к images/secrets и документированный restore.

Ежеквартальный DR exercise разворачивает систему в cold target и проверяет PostgreSQL, legal evidence DB, media, BullMQ recovery, DNS/TLS и основные journeys. Disaster objectives: RPO ≤24 ч, RTO ≤8 ч. Active-active не используется.

## Альтернативы

- Backups без recovery target: не доказывают RTO при потере площадки.
- Warm/active-active site: быстрее, но дороже и сложнее заданного RTO.

## Последствия

- Нужны отдельные credentials/failure domain, quota reservation и регулярные exercises.
- Месячный SLO и disaster RTO измеряются отдельно: disaster может привести к SLO breach, который разбирается как инцидент.
- Пользовательские backups сохраняются не более 21 дня; legal evidence следует своему сроку.

## Триггер пересмотра

Бизнес требует RPO существенно меньше 24 часов, RTO меньше времени cold restore либо 99,5% должно выдерживаться даже при полной потере площадки.
