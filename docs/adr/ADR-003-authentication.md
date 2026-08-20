# ADR-003: Authentication and authorization model

Status: Accepted

## Context

MVP имеет один first-party web client, email/password, подтверждение почты, восстановление доступа и требование немедленного revoke. SSO МЭИ и внешние identity providers не входят в продукт. Системная роль модератора, формальная роль профиля и права на конкретные объекты являются разными понятиями.

Identity model пронизывает все API, WebSocket rooms и жизненный цикл аккаунта. Поздний переход между self-contained tokens, server-side sessions и внешним IdP затрагивает credentials, revoke, клиент, аудит и миграцию identity links.

## Decision

Хранить credentials в `Identity`; пароли хэшировать Argon2id с версионируемыми параметрами. Browser получает случайную opaque session ID в `Secure`, `HttpOnly`, `SameSite=Lax` cookie, а PostgreSQL хранит только её хэш, срок и состояние revoke. Unsafe HTTP requests требуют допустимый `Origin` и CSRF token.

Socket.IO принимает только allowlisted same-origin handshake, проверяет текущую session и повторно авторизует каждую room. Logout, revoke и ограничение аккаунта отключают активные sockets.

Авторизация сочетает RBAC `user`/`moderator`, узкие permissions, ownership и relationship checks. `student`/`teacher`/`employer` остаются бизнес-атрибутом профиля. Generic `administrator` не вводится; эскалация задаётся permission `moderation.escalated_review`.

## Alternatives considered

### Alternative A: Self-contained JWT access tokens

Pros:

- не нужен session lookup на каждом запросе;
- удобно для большого числа независимых services.

Cons:

- немедленный revoke и обновление permissions требуют blacklist или коротких TTL;
- сложнее синхронно отключить WebSocket access;
- преимущества несущественны для одного приложения и 30 RPS.

### Alternative B: Внешний OIDC provider или Keycloak

Pros:

- готовые SSO, federation и административные flows;
- credentials отделены от приложения.

Cons:

- отдельная критическая платформа и её эксплуатация;
- миграция и UX сложнее без обязательного SSO;
- появляется зависимость, которой нет в требованиях MVP.

## Consequences

Positive:

- revoke действует сразу для HTTP и WSS;
- security state централизован и аудируем;
- бизнес-роли не становятся системными привилегиями.

Negative:

- каждый защищённый запрос выполняет session lookup;
- приложение отвечает за безопасное хранение credentials и auth flows;
- горизонтальное масштабирование требует общего session store и fan-out отключения sockets.

## Risks

- Ошибка room-level authorization может раскрыть чужие realtime events.
- Смешение profile role и system permission может привести к privilege escalation.
- Неверная CSRF/Origin-конфигурация нарушит защиту cookie-based sessions.

## Conditions for revisiting this decision

- SSO МЭИ или federation становится обязательным требованием;
- появляются несколько first-party приложений или внешние API clients;
- стоимость безопасной поддержки локальных credentials превышает эксплуатацию OIDC provider;
- session lookup становится доказанным bottleneck после оптимизации.
