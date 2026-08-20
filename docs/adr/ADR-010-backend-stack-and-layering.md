# ADR-010: Backend stack and pragmatic layering

Status: Accepted

## Context

Backend должен реализовать REST API, authenticated realtime, background workers, transactional workflows и строгие module boundaries. Команда использует TypeScript baseline, а масштаб MVP не оправдывает большой framework поверх каждого use case. При этом простой CRUD и сложные state transitions требуют разной степени domain modeling.

Выбор языка, framework, ORM и layering влияет на весь backend-код, тестирование и найм. Поздняя замена означает переписывание controllers, validation, persistence и cross-cutting infrastructure.

## Decision

Использовать NestJS и TypeScript для API и worker entrypoints. Публичные протоколы определяет ADR-015; Zod является основным runtime validation mechanism, Prisma — основной ORM.

Внутри модуля применять pragmatic flow `controller -> application service -> domain rules / Prisma`. Отдельные domain objects вводить для сложных инвариантов и state transitions; простой CRUD не оборачивать в обязательные repository/use-case/entity слои. Response DTO не являются Prisma models.

Синхронный cross-module вызов допускается только через public application/query contract. Общий CQRS framework, generic repository и универсальный `AppService` не вводятся.

## Alternatives considered

### Alternative A: Полный Clean Architecture и CQRS для каждого use case

Pros:

- максимальная изоляция framework и persistence;
- единообразная структура сложных и простых flows.

Cons:

- большое число adapters, commands, handlers и mappings;
- простой CRUD получает несоразмерную ceremony;
- abstractions фиксируются раньше стабилизации domain model.

### Alternative B: Spring Boot или ASP.NET Core modular monolith

Pros:

- зрелые runtime, DI, persistence и observability ecosystems;
- строгая типизация и проверенные enterprise patterns.

Cons:

- второй язык относительно frontend и принятого baseline;
- миграция увеличивает initial delivery cost;
- требования MVP не показывают преимущества, компенсирующего смену стека.

## Consequences

Positive:

- frontend и backend используют один язык и tooling ecosystem;
- сложность слоя соответствует сложности use case;
- public DTO и module contracts отделены от persistence models.

Negative:

- NestJS decorators и Prisma связывают infrastructure code с выбранными frameworks;
- pragmatic layering требует review judgment и может стать неоднородным;
- сложный SQL иногда выходит за удобный Prisma path.

## Risks

- Application services могут превратиться в большие процедурные классы.
- Prisma models могут просочиться в API или cross-module contracts.
- Одновременное использование Zod и framework decorators может создать два источника validation truth.

## Conditions for revisiting this decision

- измеряемые runtime или concurrency ограничения Node.js нарушают SLO после оптимизации;
- команда стандартизует иной backend platform и стоимость миграции оправдана;
- большая доля use cases требует одинакового CQRS/audit pipeline;
- framework препятствует обязательным security или deployment требованиям.
