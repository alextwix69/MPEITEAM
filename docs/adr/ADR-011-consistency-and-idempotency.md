# ADR-011: Consistency, concurrency and idempotency

Status: Accepted

## Context

Повтор или конкуренция запросов не должны создавать дубли отклика, решения, сообщения, membership, жалобы, уведомления или контекстного чата. Блокировка пользователя должна быть согласована с одновременной отправкой взаимодействия, а принятое решение по отклику необратимо. Email, search, moderation и другие side effects могут завершаться позже и не должны отменять business commit.

Consistency model определяет transaction boundaries, API semantics и schema constraints. Исправлять её после появления дублей и противоречивых состояний трудно, поскольку требуется очистка данных и изменение всех writers.

## Decision

Использовать strong consistency для business invariants и eventual consistency для projections и side effects.

Критический command выполняется в локальной PostgreSQL-транзакции с CHECK/UNIQUE constraints, row lock или compare-and-set. Повторяемые command endpoints требуют `Idempotency-Key`; PostgreSQL хранит actor, route, key, request hash и result reference в транзакции с командой. Тот же key с другим payload отклоняется. Business uniqueness constraints остаются обязательными и не заменяются API key.

Cross-module interaction command использует canonical lock key `(scope, min(subjectA, subjectB), max(subjectA, subjectB))`; несколько keys блокируются в лексикографическом порядке. Orchestrator передаёт общий transaction context только через public module commands. Deadlock/serialization failures получают ограниченный retry под тем же idempotency key.

Side effects фиксируются в transactional outbox и выполняются at-least-once идемпотентными consumers согласно ADR-004.

## Alternatives considered

### Alternative A: Eventual consistency и saga для всех межмодульных операций

Pros:

- модули меньше разделяют transaction boundary;
- проще будущее физическое выделение services.

Cons:

- пользователь временно видит конфликтующие blocking/membership states;
- нужны compensations для необратимых решений;
- сложнее доказать отсутствие дублей и partial results.

### Alternative B: Distributed transactions или 2PC

Pros:

- единый commit через несколько физических stores/services;
- знакомая strong-consistency семантика.

Cons:

- существенно сложнее отказоустойчивость и эксплуатация;
- нет необходимости при одном PostgreSQL boundary;
- внешние providers всё равно не участвуют безопасно.

## Consequences

Positive:

- критические состояния атомарны и защищены на database level;
- retry клиента и повторная доставка не создают business duplicates;
- внешние сбои не отменяют подтверждённую предметную операцию.

Negative:

- UI должен показывать `pending` для eventual side effects;
- lock ordering, idempotency retention и reconciliation усложняют реализацию;
- некоторые cross-module commands временно разделяют database transaction context.

## Risks

- Пропущенный writer без business constraint создаст дубли несмотря на idempotency layer.
- Непоследовательный lock order приведёт к deadlocks.
- Слишком долгие транзакции увеличат contention и нарушат latency.

## Conditions for revisiting this decision

- bounded context физически выделяется в отдельное хранилище;
- contention canonical locks нарушает p95 в двух последовательных load tests;
- требования разрешают компенсации и временно противоречивые критические состояния;
- появляется инфраструктура с доказанно более подходящими transaction guarantees.
