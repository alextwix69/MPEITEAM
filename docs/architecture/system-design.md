# Архитектура системы «Команда.МЭИ» — MVP

Статус: целевой system design MVP.
Дата: 19.08.2026.

## 0. Резюме и границы

Система строится как **модульный монолит**: один backend-кодовый базис, один основной PostgreSQL-кластер, отдельные процессы API и background worker, Redis/BullMQ для надёжного выполнения фоновых задач и S3-совместимое объектное хранилище. Frontend — адаптивное Next.js-приложение. Все production-хранилища персональных данных и резервные копии размещаются на территории РФ.

Архитектура рассчитана на целевой профиль MVP: до 10 000 аккаунтов, 2 000 MAU, 200 одновременно работающих пользователей и 30 RPS. Микросервисы, отдельный поисковый кластер, Kafka, Kubernetes, service mesh, event sourcing и multi-region active-active в MVP не используются.

Источники требований:

- `docs/product/product-spec.md` — функциональные требования и продуктовые NFR;
- `docs/product/requirements.md` — технические NFR;
- `C:/Users/alex/Downloads/CODEX_ARCHITECTURE_SPEC.md` — архитектурный baseline с более низким приоритетом.

Предложенные ADR-001—ADR-003 пока являются заглушками и не содержат принятых решений. Настоящий документ определяет согласованный набор решений для последующего оформления отдельных ADR, если эти решения потребуется менять независимо.

## 1. System context

«Команда.МЭИ» — закрытый для гостей веб-сервис. Пользователи создают профили и резюме, ищут людей и объявления, откликаются, общаются, создают команды и события. Модераторы работают через административную область того же приложения. Снаружи система зависит только от сервиса транзакционной почты и провайдера автомодерации; интеграций с SSO МЭИ, календарями и рекламными рассылками в MVP нет.

```mermaid
flowchart LR
    user["Пользователь<br/>студент, преподаватель,<br/>работодатель"]
    moderator["Администратор-модератор"]
    system["Команда.МЭИ<br/>закрытый веб-сервис"]
    email["Провайдер<br/>транзакционной почты"]
    moderation["Провайдер<br/>автомодерации"]

    user -->|"HTTPS / WSS<br/>профили, поиск, отклики,<br/>команды, чаты, события"| system
    moderator -->|"HTTPS<br/>жалобы, проверки, апелляции"| system
    system -->|"HTTPS API<br/>сервисные письма"| email
    system -->|"HTTPS API<br/>текст и безопасные ссылки на медиа"| moderation
```

### Решение 1 — системная граница

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Единый продуктовый контур и минимальный набор внешних зависимостей | SSO МЭИ, внешние календари, несколько каналов уведомлений | Локальная регистрация и календарь требуют собственной реализации; зато внешние сбои не блокируют основные journeys | Прямо соответствует MVP и исключает интеграции, которых нет в требованиях |

## 2. Основные компоненты

Backend разделён на bounded contexts внутри одного процесса и репозитория. Модуль владеет своими таблицами и публикует только application services, query contracts и доменные события; ORM-модели и прямые SQL-запросы между модулями запрещены.

| Модуль | Ответственность и принадлежащие данные |
|---|---|
| `Identity` | аккаунты, credentials, подтверждение почты, sessions, согласия, системная роль модератора, жизненный цикл аккаунта |
| `Catalog` | утверждённый справочник из 180 канонических тегов и его product-managed версии |
| `Profiles` | профиль, основное и дополнительные резюме, проекты, теги резюме, дневная активность |
| `Opportunities` | личные и командные объявления, версии контента, просмотры, статусы публикации |
| `Recruitment` | отклики, неизменяемые снимки резюме, решения и правила повторного отклика |
| `Teams` | команды, единственный лидер, участники, заявки, приглашения, подписки, командный blacklist |
| `Scheduling` | события команд и представление календаря подписчика |
| `Messaging` | личные и командные conversations, messages, read state и скрытие чата |
| `Trust` | автомодерация, ручные проверки, жалобы, решения, апелляции, личный blacklist и interaction policy |
| `Notifications` | внутренние уведомления и email deliveries |
| `Files` | metadata, upload sessions, карантин, обработка, привязка и удаление объектов |
| `Search` | денормализованная read model для поиска людей и объявлений и расчёт сортировок |
| `Compliance` | audit trail до удаления, задания на выгрузку/удаление и запись минимальных юридических доказательств |

`Catalog` остаётся небольшим read-only модулем монолита, а не самостоятельным сервисом; остальные модули хранят только ссылки на его tag IDs и используют публичный contract. Общий код ограничивается техническими primitives: идентификаторы запроса, транзакции, время, ошибки, outbox и telemetry. Универсальные repository/service abstractions не вводятся.

### Решение 2 — модульный монолит

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Один deployable backend с явными границами модулей | Микросервисы; неструктурированный монолит | Нельзя независимо масштабировать предметные области; границы приходится проверять архитектурными тестами. Зато просты транзакции, локальная разработка и выпуск | Нагрузка мала, домены тесно связаны, команда и модель будут уточняться |

## 3. Frontend architecture

- Next.js, React и TypeScript strict; один responsive web client для desktop и mobile.
- App Router отвечает за маршруты, layout, server-rendered shell и code splitting. Основная закрытая часть приложения интерактивна на клиенте; SSR не используется как отдельный backend и не содержит бизнес-правил.
- Структура по пользовательским возможностям: `auth`, `profiles`, `search`, `opportunities`, `applications`, `teams`, `calendar`, `messaging`, `moderation`, `settings`. Общие UI-компоненты отделены от feature-кода.
- TanStack Query хранит server state и выполняет invalidation/refetch; React Hook Form и Zod применяются для форм; Tailwind CSS и shadcn/ui — для UI. Redux и собственный глобальный data store не нужны.
- REST является источником истины. Socket.IO-события только сигнализируют о новом сообщении/уведомлении и инвалидируют query cache; после reconnect клиент синхронизируется через REST.
- UI локализован на русском, поддерживает viewport от 360 px, клавиатурную навигацию, видимый focus, семантическую разметку и базовые ARIA-атрибуты.
- Клиентские проверки улучшают UX, но аутентификация, авторизация и все инварианты повторно проверяются backend.

### Решение 3 — один web client без BFF и глобального store

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Next.js напрямую обращается к versioned REST API через same-origin reverse proxy | Отдельный BFF; GraphQL; Redux | Frontend зависит от API response models; сложные экраны требуют нескольких агрегирующих endpoints. Зато отсутствуют второй backend-слой и дублирование состояния | В MVP один клиент, закрытый контент не нуждается в сложной SEO-архитектуре, REST покрывает сценарии |

## 4. Backend architecture

Backend реализуется на NestJS/TypeScript как два process entrypoint из одного артефакта:

- `api` — stateless REST API и Socket.IO gateway;
- `worker` — outbox dispatch, BullMQ consumers и плановые задания.

Внутри модуля используется короткий поток `controller -> application service -> domain rules / Prisma`. Отдельные domain objects вводятся только для переходов состояний и сложных инвариантов; простой CRUD не оборачивается в искусственные слои. Zod является единственным основным механизмом runtime-валидации входных DTO. OpenAPI генерируется из публичных контрактов, а response DTO не являются Prisma-моделями.

Синхронный вызов другого модуля допустим только через его публичный application/query contract. Когда межмодульный инвариант обязан быть строгим — например, одновременная блокировка пользователя и отправка ему отклика, заявки или сообщения — application orchestrator открывает одну PostgreSQL-транзакцию, берёт стабильный lock на пару субъектов и вызывает публичные команды модулей с общим transaction context; чужие repositories и SQL при этом не раскрываются. Побочные эффекты оформляются доменным событием в transactional outbox. Критическая операция не должна зависеть от доступности email, автомодерации или WebSocket.

### Решение 4 — NestJS, REST и pragmatic layering

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| NestJS modular monolith, REST/OpenAPI, Zod, Prisma; без общего CQRS-framework | Spring/.NET; GraphQL; полный Clean Architecture/CQRS | NestJS decorators и Prisma связывают infrastructure-код с framework; REST требует проектировать агрегирующие endpoints. Зато весь стек TypeScript, невысок порог входа и минимум шаблонного кода | Соответствует baseline и принципу boring technology; требования не оправдывают более сложные стили |

## 5. Data storage

Основное хранилище — один managed PostgreSQL-кластер в РФ с одним writer и standby/автоматическим failover. Это один логический database boundary, а не read-scaling architecture. Каждый модуль владеет отдельной PostgreSQL schema. Межмодульные foreign key допустимы только на стабильные идентификаторы, но прямое чтение чужих таблиц из кода запрещено.

Основные приёмы:

- UUIDv7 как идентификаторы, `timestamptz` в UTC, IANA timezone для события/профиля;
- CHECK, UNIQUE и foreign key constraints для инвариантов; row locks или compare-and-set для конкурентных решений;
- cursor pagination для messages, notifications и audit; явные составные индексы под access paths;
- immutable JSONB snapshot резюме с версией схемы; JSONB не заменяет нормализованную предметную модель;
- `pg_trgm`, PostgreSQL full-text search и GIN/B-tree indexes для `Search` read model;
- ежедневные activity buckets и уникальные view/application facts вместо пересчёта сырых событий за 30 дней;
- без шардирования и партиционирования до подтверждения измерениями.

Минимальные юридические доказательства согласий и уничтожения хранятся без профиля и контента в отдельной PostgreSQL database с отдельными credentials и трёхлетним retention. Из основного приложения доступна только append/read-by-authorized-compliance операция; внешних FK нет.

### Решение 5 — PostgreSQL как единственная бизнес-БД и поисковый движок MVP

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Один PostgreSQL для OLTP, outbox и поисковой read model | Elasticsearch/OpenSearch; отдельная БД на модуль; document DB | Поиск менее гибок, а общий кластер остаётся общей точкой отказа. Зато транзакционные гарантии сильнее, backup/restore проще, а 30 RPS легко покрываются индексами | Требуется поиск только по ФИО/названию и фильтрам; отдельный кластер преждевременен |

## 6. Authentication/authorization

MVP использует локальную email/password-аутентификацию в `Identity`:

- пароль хэшируется Argon2id с версионируемыми параметрами;
- сервер выдаёт случайную opaque session ID в `Secure`, `HttpOnly`, `SameSite=Lax` cookie; в PostgreSQL хранится только хэш session ID, срок и состояние отзыва;
- unsafe-запросы защищаются проверкой `Origin` и CSRF token; login, registration, reset и resend ограничиваются по IP и account key;
- verification/reset tokens одноразовые, короткоживущие и хранятся только в виде хэша;
- неподтверждённый и удаляемый аккаунты имеют явные server-side state guards.

Авторизация сочетает:

- RBAC для `user`/`moderator`/`administrator`;
- формальную роль профиля `student`/`teacher`/`employer` как бизнес-атрибут, а не системное право;
- resource ownership и relationship checks: author, team leader, conversation party, report assignee;
- deny-by-default policy на application-service boundary и повторную фильтрацию результатов чтения.

### Решение 6 — server-side opaque sessions вместо JWT/Keycloak

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Локальные credentials и отзываемые PostgreSQL sessions | Self-contained JWT; Keycloak/OIDC | Свой auth требует security review и поддержки flows; запрос выполняет session lookup. Зато logout/revocation немедленны, нет отдельной identity-платформы и сложной миграции ролей | Один first-party web client и 30 RPS не оправдывают Keycloak; вариант явно разрешён baseline |

## 7. External integrations

Внешних интеграций две:

1. Транзакционная почта: verification, reset, отклики, сообщения, команды, события, модерация. Отправляется worker через HTTPS API; marketing email отсутствует.
2. Автомодерация публичного текста и изображений. Worker передаёт минимально необходимый контент провайдеру, допущенному юридической и security-проверкой. Запрос содержит версию политики, а ответ нормализуется в стабильные violation codes из `appendix-prohibited-content.md`; решение, причина и версия политики доступны для аудита и обжалования. Неодобренная или спорная версия остаётся скрытой и направляется на ручную проверку; при недоступности провайдера — `pending`, а не автоматическое одобрение.

Интеграции имеют по одному узкому port (`EmailSender`, `ContentModerator`) и production/local adapter. Это оправданная граница нестабильности, а не общий abstraction framework. Выбор конкретного поставщика является deployment decision: до запуска должны быть подтверждены размещение/обработка данных в РФ, договорные условия, таймауты и удаление переданных данных.

### Решение 7 — асинхронные provider adapters

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Вызывать email и moderation только из worker через узкие adapters | Вызов в request transaction; собственные SMTP/ML-системы | Пользователь позже видит результат, появляются retries и очередь; зато внешний сбой не повреждает бизнес-транзакцию и поставщик заменяем | NFR разрешают eventual consistency и задают отдельные сроки доставки/проверки |

## 8. Background processing

PostgreSQL outbox фиксируется в одной транзакции с предметным изменением. Для каждого заинтересованного consumer создаётся delivery record. Dispatcher блокирует пакет незавершённых deliveries через `FOR UPDATE SKIP LOCKED` и публикует BullMQ job с `(eventId, consumer)` как `jobId`. Consumer записывает `eventId` в свой inbox/processed table в одной транзакции со своим эффектом, после чего delivery отмечается завершённым. Reconciliation job повторно публикует незавершённые deliveries, поэтому потеря содержимого Redis не делает outbox-событие потерянным.

Очереди разделяются только по разным профилям retry/ресурсам:

- `critical-domain` — создание контекстного чата и каскадные workflows;
- `notifications` — внутренние уведомления и email;
- `media` — проверка, удаление EXIF, resize, malware scan;
- `moderation` — автоматическая проверка и ручные SLA/escalation;
- `search` — обновление read model и 30-дневных агрегатов;
- `maintenance` — снятие неактивных объявлений, удаление аккаунтов/команд, retention и exports.

Плановые задачи создаются BullMQ scheduler с детерминированным job key. Worker масштабируется независимо, но использует тот же код и release artifact, что API.

### Решение 8 — outbox + BullMQ, без event broker

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| PostgreSQL transactional outbox и Redis/BullMQ workers | Только cron/DB polling; Kafka/RabbitMQ; синхронные side effects | Два инфраструктурных хранилища и at-least-once semantics требуют дедупликации; зато получаем управляемые retries, задержанные задачи и горизонтальных workers без Kafka | NFR требуют устойчивой очереди и надёжных побочных эффектов, а объём мал для streaming platform |

## 9. Caching

Предметный server-side cache в MVP отсутствует. PostgreSQL с индексами остаётся источником каждого бизнес-чтения. TanStack Query кэширует данные в браузере; tag catalog и другие редко меняющиеся справочники используют HTTP `ETag`/`Cache-Control: private`.

Redis используется для BullMQ, distributed rate limits и Socket.IO adapter при нескольких API-инстансах, но не как источник истины и не как обязательный cache бизнес-объектов. Кэш добавляется только после измерения конкретного hot query с зафиксированной стратегией invalidation.

### Решение 9 — cache on evidence

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Не вводить shared domain cache до измерений | Redis cache-aside; CDN для закрытых API | Больше чтений PostgreSQL; зато нет stale authorization/data и сложной invalidation | 30 RPS и 85:15 покрываются БД; безопасность важнее гипотетической экономии миллисекунд |

## 10. File/object storage

S3-совместимое managed storage в РФ хранит media, а PostgreSQL — metadata и связи. Объекты приватны, имена случайны и не содержат PII.

Upload — двухфазный:

1. API создаёт короткоживущую upload session и presigned PUT в `quarantine`.
2. После загрузки клиент завершает session; `media` worker проверяет размер, magic bytes/MIME, декодирование, malware, удаляет EXIF, уменьшает до Full HD/1 МБ и переносит результат в private `media`.
3. Клиент получает `ready` через REST/Socket.IO и только затем может сослаться на attachment. Сообщение с фото создаётся одной транзакцией только для `ready` attachments, поэтому не считается отправленным до обязательной обработки.

Выдача выполняется короткоживущим signed GET только после проверки прав API. Для аватаров, объявлений и событий возможно CDN/proxy позже, но источник остаётся private.

Удаление объекта оформляется tombstone и idempotent job. Для 501-й фотографии чата транзакция резервирует новое вложение и помечает самые старые attachments отправителя на удаление только после успешной обработки нового. Quarantine имеет lifecycle не более 24 часов. Backup retention основного контура — не более 21 дня, чтобы данные, существовавшие до необратимого удаления на 7-й день, гарантированно исчезли до 30-го дня от исходного запроса.

### Решение 10 — private S3 с quarantine workflow

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Direct upload по presigned URL, карантин и асинхронная обработка | Файлы в PostgreSQL; upload через API; публичный bucket | Workflow сложнее простого upload и требует временных состояний; зато API не передаёт большие тела, опасный файл не доставляется, а масштабирование stateless | Выполняет лимиты, EXIF/безопасность и p95 обработки до 5 секунд |

## 11. Communication protocols

| Связь | Протокол и контракт |
|---|---|
| Browser ↔ web/API | HTTPS, same origin; REST JSON `/api/v1`; OpenAPI; ISO 8601; UTF-8 |
| Realtime | Socket.IO поверх WSS; только hints/events с `eventId`, без статуса source-of-truth |
| Upload/download | HTTPS presigned S3 URL; private objects |
| API/worker ↔ PostgreSQL | PostgreSQL wire protocol с TLS внутри private network |
| API/worker ↔ Redis | RESP с TLS/auth внутри private network |
| Worker ↔ providers | HTTPS API с connect/read timeout и request correlation ID |

Ошибки REST имеют стабильные machine-readable `code`, русское `message`, `requestId`, допустимые `details` и подходящий HTTP status. Большие списки используют cursor pagination. gRPC, GraphQL и публичные webhooks не вводятся.

### Решение 11 — REST + WSS hints

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Versioned REST как source of truth, Socket.IO для доставки событий | Только polling; GraphQL subscriptions; gRPC | Два клиентских канала и reconnect logic; зато сообщения доставляются в срок, а потерянное событие восстанавливается обычным REST refetch | Простая и широко поддерживаемая модель для web и realtime требований |

## 12. Failure handling

Применяется fail-safe поведение:

- ошибка до commit откатывает транзакцию и не показывает успех;
- ошибка после commit не отменяет предметное действие: outbox повторяет side effect;
- email: bounded retries с exponential backoff/jitter, затем dead-letter и alert;
- автомодерация: версия остаётся `pending`/скрытой, последняя одобренная версия продолжает показываться;
- media: attachment получает `failed`, объект карантина удаляется, сообщение с ним не создаётся;
- Redis: подтверждённые изменения и outbox сохраняются в PostgreSQL, доставка возобновляется после восстановления; auth endpoints fail closed, если недоступен распределённый rate limit;
- S3: новые media uploads недоступны, текстовые операции продолжаются; недоступный объект не заменяется «успешным» вложением;
- PostgreSQL: readiness снимает instance с балансировщика, изменяющие операции fail closed;
- Socket.IO: клиент показывает reconnect state и восстанавливает данные через REST;
- background jobs имеют max attempts, dead-letter state, причину, метрики и безопасный manual replay.

Для каскадного удаления команды/аккаунта используется restartable workflow с checkpoint на шаге, а не одна долгая транзакция. Сначала объект скрывается и блокируются изменения, затем создаются уведомления, после чего очищаются зависимости и media. Каждый шаг идемпотентен.

### Решение 12 — partial degradation и durable retries

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Критические записи fail closed; вторичные функции деградируют и повторяются | Общий fail-open; распределённая транзакция | Пользователь иногда видит pending/задержку; зато нет ложного успеха и внешние провайдеры не становятся общей точкой отказа | Соответствует TNFR-006 и error scenarios продукта |

## 13. Idempotency

`Idempotency-Key` обязателен для повторяемых command endpoints: создание отклика/сообщения/команды/жалобы, решения, membership actions, завершение upload и запрос удаления. Backend хранит `(actorId, route, key, requestHash, status, responseRef, expiresAt)` в PostgreSQL; тот же key с другим payload отклоняется. Запись создаётся и завершается в транзакции с командой.

Ключ не заменяет предметные ограничения:

- один активный/принятый отклик на business key с атомарной заменой;
- единственный context chat по `(opportunityId, candidateId, ownerPartyId)`;
- один participant/follower/block relation;
- одна открытая жалоба на `(reporterId, targetType, targetId)`;
- optimistic version/conditional update для необратимого решения;
- `eventId` для outbox/BullMQ/inbox и provider deduplication key, если провайдер его поддерживает.

### Решение 13 — два уровня дедупликации

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Idempotency record на API boundary плюс UNIQUE/state constraints в домене | Только client key; только проверки в коде | Нужны дополнительная таблица и очистка TTL; зато повтор сети и конкурентный запрос не создают дубль | NFR-006 прямо требует отсутствие дублей и атомарные переходы |

## 14. Consistency model

Модель — **strong consistency для инвариантов, eventual consistency для проекций и side effects**.

В одной PostgreSQL-транзакции выполняются: создание/замена отклика, необратимое решение, membership transition, блокировка и её влияние на активную заявку/приглашение, создание message после готовности файлов, запись consent, скрытие при deletion request и outbox event. Межмодульные interaction commands сериализуются общим lock и вызывают только публичные module contracts.

Асинхронно и с контролируемой задержкой выполняются: email, internal notification, context chat после принятия, search projection, moderation, media processing, метрики и физическое удаление. Принятый отклик остаётся принят даже при сбое чата; уникальный handler и safe retry создают ровно один чат. Публичная видимость новой версии меняется только после успешной модерации.

Целевые окна: внутреннее уведомление ≤10 с p95, email ≤5 мин p95, message delivery ≤3 с, media processing ≤5 с, search projection — operational target ≤10 с p95. Последнее является архитектурным budget, а не новым продуктовым SLA.

### Решение 14 — локальные ACID-транзакции и eventual side effects

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Strong consistency внутри invariant boundary, outbox между модулями | Eventual consistency для всего; distributed transactions | Некоторое время UI показывает pending, нужны reconciliation jobs; зато критические состояния атомарны без 2PC | Точно повторяет TNFR-006 и допускаемый продуктом частичный сбой чата/уведомления |

## 15. Scalability

Стартовая production-конфигурация: по 2 web/API replicas в разных failure domains и 1–2 worker replicas за балансировщиком, managed PostgreSQL с standby/автоматическим failover и connection pool, persistent managed Redis с failover и S3. API stateless: sessions, jobs и media не находятся в памяти процесса. Sticky sessions не нужны; Socket.IO при нескольких API-инстансах использует Redis adapter.

Путь роста без смены публичных контрактов:

1. измерить slow queries, добавить/исправить индексы и устранить N+1;
2. вертикально масштабировать PostgreSQL и настроить pool limits;
3. независимо увеличить API/worker replicas и concurrency очередей;
4. добавить кэш конкретного доказанного hot read;
5. только затем рассматривать read replica, partitioning messages/audit/outbox или отдельный search engine;
6. выделять модуль в сервис только при независимом профиле нагрузки/команде и измеряемом операционном выигрыше.

### Решение 15 — scale the monolith first

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Горизонтальные stateless instances и вертикальный рост managed data services | Шардинг; микросервисы; autoscaling Kubernetes | Масштабирование модулей API не независимо, PostgreSQL остаётся bottleneck; зато конфигурация многократно превосходит целевые 30 RPS при низкой эксплуатационной цене | TNFR-005 прямо указывает такой путь роста MVP |

## 16. Security boundaries

```text
Internet
  -> public TLS load balancer / reverse proxy
      -> private application network: web, API, worker
          -> private data network: PostgreSQL, Redis, S3 private endpoints
          -> controlled egress: email and moderation providers
```

- Только reverse proxy имеет публичный inbound; PostgreSQL, Redis, worker и S3 buckets недоступны из Internet.
- API — единственная граница доступа к бизнес-данным и signed URLs. Worker использует отдельную service identity с минимальными правами на очереди/buckets.
- Moderator UI не является доверенной зоной: каждое действие авторизуется server-side и пишется в audit.
- Secrets находятся в secret store/CI protected variables, регулярно ротируются и не попадают в image/logs.
- TLS везде, encryption at rest у managed PostgreSQL/Redis/S3/backups, security headers, CSP, dependency/container scanning.
- Logs/traces не содержат пароли, tokens, message text, media, email или полный resume; user IDs псевдонимизируются для telemetry.
- Signed URLs короткоживущие и выдаются после object-level authorization; upload policy ограничивает размер и content type, но не заменяет server-side inspection.
- Legal evidence отделены credentials и role grants от основного пользовательского контура.

### Решение 16 — three-zone boundary и least privilege

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Public edge, private app zone, private data zone; отдельный legal access scope | Плоская сеть; отдельный account/VPC на каждый модуль | Сетевые правила и service identities требуют сопровождения; зато компрометация web/API не даёт прямого публичного доступа к данным, а юридические записи изолированы | Требуется защита ПДн, переписки, moderation data и минимизация прав |

## 17. Observability

Все процессы пишут структурированные JSON logs с `requestId`, `correlationId`, `eventId`, module, operation, result и latency без содержимого ПДн. OpenTelemetry instrumentation связывает HTTP, Prisma, outbox и job execution; errors отправляются в Sentry либо эквивалент, metrics — в managed Prometheus/Grafana либо эквивалентный российский сервис.

Обязательные метрики и alerts:

- RPS, error ratio, availability и p50/p95/p99 по классу endpoint;
- DB pool saturation, slow queries, locks, storage и backup age/result;
- queue depth/oldest age/retry/DLQ, outbox lag и worker duration;
- media p95, moderation backlog/deadline risk, notification/email delivery p95;
- S3 usage и число chat photos на пользователя;
- deletion/export workflow age и приближение 30-дневного срока;
- alert на критический сбой не позднее 15 минут.

Readiness проверяет необходимые зависимости для обслуживания трафика; liveness — только зависание процесса, чтобы временный сбой PostgreSQL не вызвал restart storm. Audit trail — бизнес-данные `Compliance`, а не operational logs. SLO dashboards соответствуют TNFR-003/004/012.

### Решение 17 — единая correlation chain и SLO-first telemetry

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Structured logs + metrics + traces вокруг journeys и очередей | Только текстовые logs; собственная observability platform | Есть стоимость telemetry backend и discipline инструментирования; зато можно доказать p95/p99, найти потерянный side effect и контролировать сроки удаления/модерации | Это минимальный набор для измеряемых NFR и безопасного manual replay |

## 18. Deployment architecture

Production размещается у провайдера в РФ без Kubernetes. Docker images версионируются immutable digest. Reverse proxy/load balancer завершает TLS и направляет `/` в Next.js, `/api` в NestJS и `/socket.io` в realtime gateway. Web/API/worker могут использовать один release, но запускаются отдельными process roles.

```mermaid
flowchart TB
    internet["Пользователи / модераторы"]

    subgraph rf["Production region, РФ"]
        edge["Managed LB / reverse proxy<br/>TLS, rate limits, security headers"]

        subgraph apps["Private application network"]
            subgraph fd1["Failure domain A"]
                web1["Next.js web 1"]
                api1["NestJS API 1"]
                worker1["NestJS worker 1"]
            end
            subgraph fd2["Failure domain B"]
                web2["Next.js web 2"]
                api2["NestJS API 2"]
                worker2["NestJS worker 2"]
            end
        end

        subgraph data["Private data network"]
            pg[("Managed PostgreSQL<br/>writer + standby failover")]
            legal[("Legal evidence DB<br/>separate credentials")]
            redis[("Managed Redis<br/>BullMQ, rate limit, Socket.IO")]
            s3[("Private S3 storage<br/>quarantine, media")]
            backup[("Separate backup storage<br/>encrypted, retention 21 days")]
            obs["Managed observability<br/>logs, metrics, traces, alerts"]
        end
    end

    email["Email provider"]
    moderation["Moderation provider"]
    ci["CI/CD<br/>test, scan, migrate, rollout"]

    internet -->|"HTTPS / WSS"| edge
    edge --> web1
    edge --> web2
    edge --> api1
    edge --> api2
    api1 --> pg
    api2 --> pg
    api1 --> redis
    api2 --> redis
    api1 --> s3
    api2 --> s3
    worker1 --> pg
    worker1 --> legal
    worker1 --> redis
    worker1 --> s3
    worker2 --> pg
    worker2 --> legal
    worker2 --> redis
    worker2 --> s3
    pg -.-> backup
    s3 -.-> backup
    worker1 -->|"HTTPS"| email
    worker1 -->|"HTTPS"| moderation
    worker2 -->|"HTTPS"| email
    worker2 -->|"HTTPS"| moderation
    web1 -.-> obs
    api1 -.-> obs
    api2 -.-> obs
    worker1 -.-> obs
    worker2 -.-> obs
    ci -->|"rolling deploy A"| web1
    ci -->|"rolling deploy B"| web2
```

CI/CD выполняет lint, unit/integration/API/E2E tests, dependency/image scan, build, миграции и rolling deploy. Миграции следуют expand/migrate/contract; destructive contract выполняется отдельным поздним release. Перед rollout проверяется backup и совместимость rollback. При дефекте трафик возвращается на предыдущий image не более чем за 30 минут без отката уже применённых данных.

Ежедневные encrypted backups PostgreSQL и object inventory/copy хранятся отдельно в РФ не более 21 дня; RPO ≤24 ч, RTO ≤8 ч. Restore rehearsal проводится ежеквартально. Наличие двух app replicas устраняет planned downtime приложения, но не заявляет active-active между площадками.

### Решение 18 — Docker и managed stateful services без Kubernetes

| Decision | Alternatives | Trade-offs | Reason |
|---|---|---|---|
| Rolling Docker deployment в двух failure domains, managed PostgreSQL/Redis/S3 в РФ | Kubernetes; один VPS со всем стеком; multi-region active-active | Выше инфраструктурная стоимость и зависимость от managed provider; orchestration проще и менее автоматизировано, чем Kubernetes. Зато локальный failover поддерживает 99,5%, а backups — требуемые RPO/RTO без отдельной platform team | Минимальная эксплуатационная сложность для заданного масштаба и требований размещения |

## 19. Container diagram

```mermaid
flowchart LR
    browser["Browser<br/>Next.js/React client"]

    subgraph product["Команда.МЭИ"]
        web["Web<br/>Next.js"]
        api["API + realtime<br/>NestJS modular monolith"]
        worker["Background worker<br/>NestJS + BullMQ"]

        subgraph modules["Backend modules"]
            identity["Identity"]
            core["Catalog · Profiles · Opportunities<br/>Recruitment · Teams · Scheduling"]
            msg["Messaging"]
            trust["Trust · Compliance"]
            support["Files · Notifications · Search"]
        end

        pg[("PostgreSQL")]
        legal[("Legal evidence DB")]
        redis[("Redis / BullMQ")]
        s3[("S3-compatible media storage")]
        backup[("Separate backup storage")]
    end

    email["Email API"]
    moderation["Moderation API"]

    browser -->|"HTTPS"| web
    browser -->|"REST / WSS"| api
    web -->|"same-origin REST"| api
    api --> identity
    api --> core
    api --> msg
    api --> trust
    api --> support
    identity --> pg
    core --> pg
    msg --> pg
    trust --> pg
    support --> pg
    api --> redis
    api --> s3
    pg -->|"outbox"| worker
    worker --> redis
    worker --> pg
    worker --> legal
    worker --> s3
    pg -.-> backup
    s3 -.-> backup
    worker --> email
    worker --> moderation
```

## 20. Major request flow: принятие отклика

Этот flow выбран как главный, потому что связывает авторизацию, необратимый state transition, outbox, идемпотентное создание чата и уведомления.

```mermaid
sequenceDiagram
    autonumber
    actor Author as Автор / лидер
    participant Web as Next.js client
    participant API as NestJS API
    participant Recruitment
    participant DB as PostgreSQL
    participant Worker as Outbox/BullMQ worker
    participant Messaging
    participant Notifications
    participant Email as Email provider
    participant Socket as Socket.IO

    Author->>Web: Принять отклик
    Web->>API: POST /api/v1/applications/{id}/accept<br/>Idempotency-Key, session cookie
    API->>Recruitment: authorize + accept(command)
    Recruitment->>DB: BEGIN; lock application
    Recruitment->>DB: conditional status pending -> accepted
    Recruitment->>DB: insert outbox ApplicationAccepted
    Recruitment->>DB: COMMIT
    Recruitment-->>API: accepted
    API-->>Web: 200 accepted, chatStatus=pending

    Worker->>DB: claim independent outbox deliveries
    par Create context chat
        Worker->>Messaging: ensureContextConversation(eventId)
        Messaging->>DB: INSERT conversation<br/>ON CONFLICT use existing
        Messaging->>DB: mark inbox event processed
    and Notify in app
        Worker->>Notifications: ensure in-app notification
        Notifications->>DB: INSERT notification ON CONFLICT
        Notifications->>Socket: notify eventId
    and Send email
        Worker->>Email: send with provider idempotency key
    end

    alt временный сбой создания чата
        Worker->>Worker: retry with backoff
        Web->>API: POST /applications/{id}/retry-chat
        API->>DB: verify accepted and enqueue same business key
    end

    Web->>API: GET /api/v1/applications/{id}/result
    API-->>Web: accepted + conversationId
```

## 21. Проверка покрытия требований

| Группа требований | Архитектурный механизм |
|---|---|
| FR-001—011, 152—155; TNFR-009 | Local auth, opaque sessions, consent records, email verification, server-side guards |
| FR-012—043 | Нормализованные Profiles/Opportunities, Search projection на PostgreSQL, дневные/30-дневные агрегаты |
| FR-044—084 | Версии контента, moderation gate, immutable resume snapshot, ACID state transitions, context-chat outbox |
| FR-085—114 | Teams/Scheduling ownership, unique membership constraints, transactional transitions, notification events |
| FR-115—130; NFR-009/016/020 | Messaging, REST + WSS, двухфазный media workflow, sender quota и private S3 |
| FR-131—142, 156—159; NFR-024 | Moderation queue, deadline fields, priority escalation, audit |
| FR-143—151, 160; TNFR-008/010/011 | Immediate hide, restartable deletion workflow, ≤21-day backups, isolated legal evidence |
| TNFR-001—005, 012—014 | Stateless replicas, indexed PostgreSQL, observability, rolling Docker deployment, responsive web |
| TNFR-006—007, 013 | ACID + outbox/inbox, daily backups, restore drills, expand/migrate/contract и rollback |

## 22. Явно отложенные решения

До появления измеряемой потребности не вводятся:

- Elasticsearch/OpenSearch, read replicas, partitioning и sharding;
- Keycloak/SSO МЭИ и социальные identity providers;
- отдельные Messaging/Search/Notifications services;
- CDN для приватных media;
- Kafka/RabbitMQ, Kubernetes, service mesh;
- recommendation engine, analytics warehouse, внешние календари и рекламные каналы.

Триггер пересмотра — не прогноз роста, а нарушение SLO после query/index/pool tuning, независимый профиль масштабирования, отдельная команда-владелец или обязательная новая интеграция.
