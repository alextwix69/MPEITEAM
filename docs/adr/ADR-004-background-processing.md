# ADR-004: Background processing and delivery semantics

Status: Accepted

## Context

Email, уведомления, создание контекстного чата, media processing, moderation, search projection и удаление не должны расширять пользовательскую транзакцию. При этом подтверждённое изменение нельзя потерять при сбое Redis, worker или внешнего provider. Задачи требуют delayed retries, различных resource profiles и безопасного replay.

Механизм доставки затрагивает все bounded contexts и формирует семантику отказов. Поздняя замена потребует мигрировать pending jobs, deduplication state, monitoring и operational runbooks.

## Decision

Предметная транзакция записывает событие в PostgreSQL transactional outbox. Для каждого consumer создаётся delivery record. Dispatcher публикует BullMQ job с `(eventId, consumer)` как `jobId`; consumer сохраняет inbox marker в одной транзакции со своим эффектом. Reconciliation job повторно публикует незавершённые deliveries.

Семантика доставки — at-least-once, поэтому handlers идемпотентны. Redis/BullMQ отвечает за scheduling, concurrency и retries, но не является источником истины: незавершённая работа восстанавливается из PostgreSQL. Очереди разделяются только при различающихся retry или resource profiles. API и worker запускаются отдельными process roles из одного release artifact.

## Alternatives considered

### Alternative A: Записывать только BullMQ job

Pros:

- меньше таблиц и проще happy path;
- минимальная задержка постановки задачи.

Cons:

- возникает dual-write между PostgreSQL и Redis;
- commit предметного действия может состояться без job;
- потеря Redis способна необратимо потерять side effect.

### Alternative B: Kafka или RabbitMQ как event broker

Pros:

- развитые streaming/routing возможности;
- удобнее независимым сервисам с высоким throughput.

Cons:

- дополнительная сложная stateful платформа;
- transactional boundary с PostgreSQL всё равно требует outbox;
- объём 30 RPS не оправдывает эксплуатационную стоимость.

## Consequences

Positive:

- business commit не зависит от Redis и внешних providers;
- потерянные или повторные jobs восстанавливаются безопасно;
- workers масштабируются независимо от API.

Negative:

- нужно хранить и очищать outbox, delivery и inbox records;
- at-least-once требует идемпотентности каждого consumer;
- reconciliation и manual replay усложняют эксплуатацию.

## Risks

- Ошибка consumer до записи inbox marker может многократно повторить внешний эффект.
- Рост outbox lag или DLQ может быть незаметен без age-based alerts.
- Неправильное разделение очередей может вызвать starvation критических jobs.

## Conditions for revisiting this decision

- outbox polling становится измеряемым bottleneck после batch/index tuning;
- появляются независимо выпускаемые services с большим event throughput;
- BullMQ не обеспечивает обязательные ordering, retention или routing guarantees;
- operational cost reconciliation превышает выгоду текущей схемы.
