# ADR-015: REST source of truth and realtime hints

Status: Accepted

## Context

Web client должен выполнять обычные CRUD и command scenarios, получать сообщения и уведомления в пределах заданной задержки и восстанавливаться после разрыва связи. Rolling deployment требует проверяемого контракта. Realtime-канал не должен становиться отдельным источником business state или обходить object-level authorization.

Выбор HTTP и realtime protocols определяет public contracts, client libraries, gateways и модель reconnect. Поздняя замена затронет все endpoints и пользовательские journeys.

## Decision

Использовать versioned REST JSON `/api/v1` поверх HTTPS как единственный source of truth для business state. Описывать публичный контракт OpenAPI, использовать stable machine-readable error codes и cursor pagination для растущих списков. Compatibility lifecycle определяется ADR-008.

Использовать Socket.IO поверх authenticated same-origin WSS только для realtime hints: новое сообщение, уведомление или изменение состояния передаётся с `eventId` и инициирует query update/invalidation. После reconnect или пропущенного event клиент восстанавливает состояние через REST. Каждая room авторизуется server-side; Redis adapter обеспечивает fan-out между API instances, но не хранит права.

Upload/download media выполняется через short-lived presigned HTTPS URLs к private object storage после object-level authorization. gRPC, GraphQL subscriptions и public webhooks в MVP не вводятся.

## Alternatives considered

### Alternative A: Только REST polling

Pros:

- один transport и более простой gateway;
- не нужны persistent connections и room authorization.

Cons:

- высокая polling latency либо лишняя нагрузка;
- труднее выполнить сроки доставки сообщений и уведомлений;
- фоновые вкладки и mobile networks создают неравномерное поведение.

### Alternative B: GraphQL с subscriptions как единый API

Pros:

- клиент выбирает форму response;
- queries, mutations и subscriptions имеют общую schema.

Cons:

- сложнее authorization, caching и operational limits;
- subscriptions всё равно требуют reconnect и resynchronization;
- один web client не оправдывает дополнительную platform complexity.

## Consequences

Positive:

- потеря realtime event не приводит к потере business state;
- OpenAPI даёт generated client и compatibility checks;
- realtime latency достигается без дублирования query model.

Negative:

- клиент поддерживает два канала и reconnect logic;
- REST может потребовать агрегирующих endpoints для сложных экранов;
- Socket.IO protocol и Redis fan-out добавляют operational dependencies.

## Risks

- Разработчик может начать передавать через WSS состояние, которого нет в REST.
- Ошибка room authorization способна раскрыть metadata чужого conversation.
- Event storm может вызвать чрезмерный refetch и нагрузку на API.

## Conditions for revisiting this decision

- появляется несколько клиентов с существенно разными query shapes;
- polling или REST aggregation доказанно нарушают SLO после оптимизации;
- требуется публичный streaming API или server-to-server integration;
- Socket.IO ограничивает обязательные throughput, protocol или infrastructure requirements.
