# ADR-014: Observability and correlation model

Status: Accepted

## Context

Система должна доказуемо выполнять latency, availability, moderation, deletion и notification targets. Один пользовательский journey проходит HTTP, PostgreSQL outbox, BullMQ и внешние providers. Без общего correlation model невозможно отличить потерянный side effect от задержки, безопасно выполнить replay или подтвердить SLO.

Telemetry fields и propagation пронизывают API, domain events, jobs и provider adapters. Добавить их после накопления разнородных flows существенно дороже, чем установить contract до реализации.

## Decision

Использовать единую correlation chain `requestId -> correlationId -> eventId` во всех process roles. Писать structured JSON logs с module, operation, result и latency без запрещённых персональных данных. Инструментировать HTTP, Prisma, outbox и jobs через OpenTelemetry.

Метрики и alerts строить вокруг пользовательских journeys и operational queues: endpoint p50/p95/p99, availability/error ratio, DB pool/locks/waits, outbox lag, queue oldest age/retry/DLQ, media/moderation latency, backup status и deletion deadline. Critical alert должен обнаруживаться не позднее 15 минут.

Использовать managed metrics/logs/traces/error backend, соответствующий требованиям размещения; конкретный vendor не является частью решения. Audit trail остаётся business data `Compliance`, а не operational telemetry.

## Alternatives considered

### Alternative A: Только текстовые application logs

Pros:

- минимальная стоимость instrumentation и storage;
- простой первоначальный setup.

Cons:

- нельзя надёжно связать request, event и повторную job;
- SLO и queue age приходится оценивать вручную;
- incident diagnosis и безопасный replay занимают больше времени.

### Alternative B: Собственная self-hosted observability platform

Pros:

- полный контроль retention, data placement и customization;
- меньше vendor lock-in форматов хранения.

Cons:

- отдельная критическая платформа, upgrades и capacity planning;
- отвлекает команду от продукта;
- OpenTelemetry уже сохраняет переносимость instrumentation.

## Consequences

Positive:

- journey прослеживается через sync и async boundaries;
- SLO, backlog и deadlines измеряются автоматически;
- provider backend можно заменить без переписывания instrumentation contract.

Negative:

- telemetry backend и storage имеют постоянную стоимость;
- developers обязаны последовательно распространять identifiers;
- sampling и redaction требуют отдельной настройки и тестов.

## Risks

- PII или message content может попасть в attributes через exception capture.
- Aggressive sampling потеряет редкие failure traces.
- Высокая cardinality user/event labels увеличит стоимость и ухудшит metrics backend.

## Conditions for revisiting this decision

- managed backend не соответствует data residency или cost constraints;
- объём telemetry требует иной sampling/storage architecture;
- OpenTelemetry не поддерживает обязательный runtime или provider;
- SLO и incident analysis показывают, что текущей correlation granularity недостаточно.
