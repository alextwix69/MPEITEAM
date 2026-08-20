# ADR-009: Modular monolith and data ownership

Status: Accepted

## Context

MVP объединяет тесно связанные домены профилей, объявлений, откликов, команд, сообщений, модерации и удаления. Целевая нагрузка мала, команда и domain model будут уточняться. При этом неструктурированный монолит быстро создаст прямые обращения к чужим данным, а ранние микросервисы потребуют распределённых транзакций и сложной эксплуатации.

Архитектурный стиль определяет ownership кода и данных, транзакционные границы, deploy и будущую выделяемость модулей. Позднее исправление нарушенных границ требует миграции данных и контрактов.

## Decision

Строить backend как один deployable modular monolith в одном repository и release artifact. API и worker являются отдельными process entrypoints этого артефакта, но не отдельными domain services.

Разделить backend на bounded contexts `Identity`, `Catalog`, `Profiles`, `Opportunities`, `Recruitment`, `Teams`, `Scheduling`, `Messaging`, `Trust`, `Notifications`, `Files`, `Search` и `Compliance`. Каждый модуль владеет своей PostgreSQL schema, migrations и domain rules. Снаружи модуль публикует только application services, query contracts и domain events.

Импорт чужих repositories/ORM models и прямой SQL к чужой schema запрещены. Синхронное взаимодействие выполняется через публичный contract; side effects — через outbox. Архитектурные dependency tests проверяют границы. Общий код ограничивается техническими primitives, а не универсальными business services.

## Alternatives considered

### Alternative A: Микросервисы по bounded context

Pros:

- независимые deploy и scaling;
- сильная runtime-изоляция ownership.

Cons:

- распределённые workflows и eventual consistency для тесно связанных инвариантов;
- больше CI/CD, observability и on-call нагрузки;
- границы придётся зафиксировать до того, как domain model стабилизировалась.

### Alternative B: Неструктурированный монолит с общей data access layer

Pros:

- минимальные начальные conventions;
- любой код может быстро читать любые данные.

Cons:

- ownership и инварианты размываются;
- изменения получают непредсказуемый cross-module impact;
- последующее выделение модуля требует распутывать скрытые зависимости.

## Consequences

Positive:

- просты локальная разработка, единый release и ACID orchestration;
- bounded contexts имеют явное ownership без сетевой сложности;
- модуль можно выделить позже через уже существующий public contract.

Negative:

- domain modules нельзя независимо deploy и масштабировать;
- ошибка процесса может затронуть весь backend;
- соблюдение границ зависит от architecture tests и review.

## Risks

- Общий transaction context может стать обходным путём к чужим repositories.
- `shared` может превратиться в скрытый business module.
- Формальные модули могут остаться связанными через общие таблицы или DTO.

## Conditions for revisiting this decision

- модуль получает устойчиво независимый профиль нагрузки, release cadence и команду-владельца;
- архитектурные метрики показывают, что process-level fault isolation необходима для SLO;
- межмодульный public contract стабилен и позволяет выделение без shared database access;
- operational gain микросервиса доказан и превышает стоимость distributed system.
