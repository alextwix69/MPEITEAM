# ADR-004: Background processing and delivery semantics

Статус: принято.
Дата: 19.08.2026.

## Контекст

Email, уведомления, создание контекстного чата, media, search projection и удаление не должны расширять пользовательскую транзакцию. При этом подтверждённое изменение нельзя потерять при сбое Redis или worker.

## Решение

Предметная транзакция записывает PostgreSQL outbox. Для каждого consumer создаётся delivery record. Dispatcher публикует BullMQ job с `(eventId, consumer)` как job ID; consumer сохраняет inbox marker в одной транзакции с эффектом. Незавершённые deliveries повторно публикуются reconciliation job. Семантика — at-least-once, handlers идемпотентны.

## Альтернативы

- Только BullMQ: создаёт dual-write между PostgreSQL и Redis.
- Kafka/RabbitMQ: избыточны при 30 RPS.
- Синхронные side effects: связывают доступность продукта с внешними провайдерами.

## Последствия

- Нужны outbox/inbox retention, DLQ, lag metrics и manual replay.
- Redis не является источником истины: потерянная job восстанавливается из delivery record.
- Очереди разделяются только при разных retry/resource profiles.

## Триггер пересмотра

Outbox polling становится измеряемым bottleneck либо появляются независимые сервисы с большим event throughput.
