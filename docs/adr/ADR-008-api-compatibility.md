# ADR-008: API compatibility and schema evolution

Статус: принято.
Дата: 19.08.2026.

## Контекст

Next.js напрямую зависит от REST DTO, а rolling deployment временно оставляет старые и новые client/API versions одновременно. Префикс `/v1` сам по себе не предотвращает breaking changes.

## Решение

Внутри `/api/v1` допускаются только additive changes. Поля не удаляются, не переименовываются и не становятся обязательными в одном rolling window. Breaking change проходит deprecation и новую major API version. CI сравнивает OpenAPI с последним release, блокирует несовместимость, компилирует generated client и запускает old-client/new-API и new-client/old-API contract tests.

Database migrations следуют expand/migrate/contract. Contract выполняется отдельным поздним release после исчезновения старых consumers и подтверждения telemetry.

## Альтернативы

- Координированный мгновенный deploy: создаёт downtime и плохо откатывается.
- GraphQL: не устраняет необходимость schema compatibility.

## Последствия

- Некоторые deprecated поля временно поддерживаются дольше.
- Release pipeline хранит предыдущую OpenAPI specification и compatibility fixtures.
- Rollback приложения не требует rollback уже подтверждённых данных.

## Триггер пересмотра

Появление внешних API consumers с формальным lifecycle либо необходимость поддерживать несколько публичных major versions.
