# ADR-008: API compatibility and schema evolution

Status: Accepted

## Context

Next.js напрямую зависит от REST DTO. Rolling deployment временно оставляет старые и новые client/API versions одновременно. Prefix `/api/v1` сам по себе не предотвращает breaking changes, а уже применённую data migration часто нельзя безопасно откатить вместе с image.

Compatibility policy влияет на каждый endpoint, generated client, database migration и release pipeline. Ввести её после появления множества несовместимых контрактов существенно дороже.

## Decision

Внутри `/api/v1` разрешать только additive changes. Поля не удаляются, не переименовываются и не становятся обязательными в одном rolling window. Breaking change проходит deprecation и новую major API version.

CI сравнивает OpenAPI с последним release, блокирует несовместимость, компилирует generated client и запускает old-client/new-API и new-client/old-API contract tests.

Database migrations следуют expand/migrate/contract. Contract выполняется отдельным поздним release после исчезновения старых consumers и подтверждения telemetry. Application rollback возвращает предыдущий immutable image без rollback уже подтверждённых business data.

## Alternatives considered

### Alternative A: Координированный мгновенный deploy frontend и API

Pros:

- можно делать breaking changes без периода deprecation;
- меньше временных compatibility fields.

Cons:

- требует downtime или идеально атомарного переключения;
- rollback становится опасным после data migration;
- browser может продолжать выполнять старый client bundle.

### Alternative B: Неформальная backward compatibility без CI gate

Pros:

- проще pipeline;
- разработчик свободнее меняет DTO.

Cons:

- несовместимость обнаруживается только в production или E2E;
- правила зависят от памяти reviewers;
- невозможно доказать безопасный rolling window.

## Consequences

Positive:

- rolling deploy и rollback не требуют синхронного переключения клиентов;
- breaking changes обнаруживаются до release;
- schema evolution имеет предсказуемую последовательность.

Negative:

- deprecated fields временно поддерживаются дольше;
- pipeline хранит предыдущую OpenAPI specification и compatibility fixtures;
- contract migrations требуют дополнительных releases.

## Risks

- Additive change может оставаться семантически несовместимым при изменении значения поля.
- Недостаточная telemetry может преждевременно удалить старый contract.
- Generated client tests не покрывают сторонних consumers, если они появятся без регистрации.

## Conditions for revisiting this decision

- появляются внешние API consumers с формальным lifecycle;
- требуется одновременно поддерживать несколько публичных major versions;
- транспорт меняется с REST/OpenAPI на иной контрактный механизм;
- release platform обеспечивает доказанное атомарное переключение всех consumers и данных.
