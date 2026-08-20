# ADR-001: Frontend framework

Status: Accepted

## Context

MVP имеет один закрытый адаптивный web client. SEO не является основной ценностью, но нужны маршрутизация, server-rendered shell, code splitting, формы, realtime-подсказки и единая TypeScript-модель контрактов. Второй клиент и отдельная frontend-команда отсутствуют.

Выбор framework и модели состояния влияет на структуру всех пользовательских сценариев, границу frontend/backend и стоимость появления новых клиентов. Поздняя замена потребует переписать маршруты, формы, data fetching и значительную часть тестов.

## Decision

Использовать Next.js App Router, React и TypeScript strict как единый responsive web client. TanStack Query владеет server state, React Hook Form и Zod — формами, Tailwind CSS и shadcn/ui — presentation layer.

Frontend обращается к versioned REST API через same-origin reverse proxy согласно ADR-015. REST остаётся источником истины, а Socket.IO только сообщает об изменениях и инициирует invalidation/refetch. Отдельный BFF, GraphQL и глобальный Redux-store в MVP не вводятся. Server Components не содержат бизнес-правил и не образуют второй backend.

## Alternatives considered

### Alternative A: SPA на Vite

Pros:

- проще runtime и hosting;
- полная явность client-side rendering.

Cons:

- придётся отдельно собирать routing, shell rendering и conventions;
- слабее соответствие принятому TypeScript baseline проекта;
- переход не даёт измеримой продуктовой выгоды для одного клиента.

### Alternative B: BFF или GraphQL с глобальным store

Pros:

- можно агрегировать данные под сложные экраны;
- удобнее обслуживать несколько неодинаковых клиентов.

Cons:

- появляется второй backend-контур и дополнительный контракт;
- возрастает риск двух конкурирующих моделей server state;
- у MVP нет нескольких клиентов, оправдывающих эту стоимость.

## Consequences

Positive:

- один стек и одна модель server state для desktop и mobile;
- realtime не дублирует источник истины и безопасно восстанавливается через REST;
- routing, rendering и code splitting имеют единые conventions.

Negative:

- frontend тесно зависит от REST DTO и compatibility discipline;
- сложные экраны могут потребовать агрегирующих REST endpoints;
- framework-specific App Router conventions увеличивают стоимость будущей миграции.

## Risks

- Бизнес-правила могут незаметно переместиться в Server Components.
- Неконтролируемое локальное состояние может повторно создать глобальный store без явного решения.
- Breaking REST change способен одновременно нарушить несколько feature areas.

## Conditions for revisiting this decision

- появляется второй независимый клиент с существенно иными потребностями;
- измерения показывают систематический request fan-out, который нельзя устранить агрегирующими REST endpoints;
- Next.js ограничивает обязательные требования по безопасности, доступности или эксплуатации;
- стоимость поддержки локального frontend-стека становится выше миграции.
