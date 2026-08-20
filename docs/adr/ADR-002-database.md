# ADR-002: Primary database and search storage

Status: Accepted

## Context

Отклики, membership, блокировки, удаление и другие критические переходы требуют ACID-транзакций, уникальных ограничений и конкурентной сериализации. Целевая нагрузка MVP — до 30 RPS и 10 000 аккаунтов. Поиск ограничен ФИО, названием, каноническими тегами и фиксированными фильтрами.

Выбор основного хранилища определяет модель транзакций, миграций, резервного копирования и поиска. Переход на другую модель данных после накопления пользовательских данных потребует сложной миграции и периода двойной записи.

## Decision

Использовать один managed PostgreSQL-кластер в РФ с writer и standby failover как единственную business database MVP. Каждый backend-модуль владеет отдельной PostgreSQL schema и migrations; прямое чтение чужих таблиц из кода запрещено.

PostgreSQL также хранит transactional outbox, поисковую read model и инкрементальные 30-дневные агрегаты. Для поиска применяются `pg_trgm`, full-text search и целевые GIN/B-tree indexes. Prisma является основной ORM; сложные конкурентные операции могут использовать проверенный parameterized SQL внутри owning module.

Минимальные юридические доказательства размещаются в отдельной PostgreSQL database с отдельными credentials и без внешних foreign keys. Elasticsearch/OpenSearch, read replicas, partitioning и sharding не вводятся без измеряемого триггера.

## Alternatives considered

### Alternative A: PostgreSQL плюс Elasticsearch/OpenSearch

Pros:

- более гибкий полнотекстовый поиск и ranking;
- независимое масштабирование поисковых чтений.

Cons:

- второй stateful cluster, отдельные backup/monitoring и eventual projection;
- сложнее обеспечивать удаление данных и согласованность индекса;
- текущий объём и поисковые возможности не оправдывают стоимость.

### Alternative B: Отдельная database на модуль или document database

Pros:

- сильнее физическая изоляция модулей;
- отдельные bounded contexts можно масштабировать независимо.

Cons:

- усложняются строгие межмодульные инварианты и восстановление;
- document model хуже выражает реляционные ограничения продукта;
- появляется необходимость в распределённых workflows раньше фактической потребности.

## Consequences

Positive:

- критические инварианты обеспечиваются транзакциями и constraints одного движка;
- backup, restore и эксплуатация остаются простыми;
- search projection можно перестроить из основной модели без отдельной платформы.

Negative:

- PostgreSQL остаётся общей точкой capacity и отказа;
- поиск менее гибок, чем специализированный движок;
- логические границы schemas нужно защищать тестами и review, поскольку физически кластер общий.

## Risks

- Смешанная OLTP, search и background нагрузка может создать lock или I/O contention.
- Prisma может не выразить критический конкурентный запрос достаточно точно.
- Неограниченный рост messages, audit или outbox способен потребовать partitioning.

## Conditions for revisiting this decision

- два последовательных mixed load tests нарушают p95 после query/index/pool tuning;
- DB CPU, connections или read latency превышают 70% согласованного capacity budget не менее 15 минут;
- поиск требует morphology, ranking или объёма, которые PostgreSQL не обеспечивает в пределах SLO;
- отдельный модуль получает независимый профиль нагрузки и доказанный операционный выигрыш от выделения хранилища.
