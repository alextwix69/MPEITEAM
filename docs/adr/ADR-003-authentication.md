# ADR-003: Authentication

Статус: принято.
Дата: 19.08.2026.

## Контекст

MVP имеет один first-party web client, email/password, подтверждение почты, восстановление доступа и требование немедленного revoke. SSO МЭИ и внешние identity providers не входят в продукт.

## Решение

Credentials хранятся в `Identity`; пароль — Argon2id. Browser получает случайную opaque session ID в `Secure`, `HttpOnly`, `SameSite=Lax` cookie, а PostgreSQL хранит только её хэш и состояние revoke. Unsafe HTTP requests требуют допустимый `Origin` и CSRF token.

Socket.IO принимает только allowlisted same-origin handshake, проверяет текущую opaque session и повторно авторизует каждую room. Logout/revoke отключает активные sockets.

Системные права задаются `user`, `moderator` и узкими permissions. Generic `administrator` не используется; эскалация FR-159 — permission `moderation.escalated_review`.

## Альтернативы

- Self-contained JWT: сложнее немедленно отзывать и безопасно обновлять роли.
- Keycloak/OIDC: добавляет отдельную платформу без нужного MVP identity flow.

## Последствия

- Каждый защищённый запрос выполняет session lookup; на целевой нагрузке это допустимо.
- Auth flows и Socket.IO требуют отдельного security integration suite: CSRF, CSWSH, revoke, чужая room, brute force.
- Переход к OIDC потребует миграционного плана identity links, а не изменения бизнес-профиля.

## Триггер пересмотра

Обязательный SSO, несколько first-party приложений или стоимость поддержки локальных credentials выше эксплуатации OIDC-provider.
