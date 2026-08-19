# ADR-005: Content moderation boundary and provider failover

Статус: принято.
Дата: 19.08.2026.

## Контекст

Каждая версия публичного контента обязана пройти автомодерацию до публикации. Длительная недоступность единственного endpoint останавливает продуктовую воронку. Приватная переписка не должна передаваться провайдеру.

## Решение

Использовать port `ContentModerator` с основным и резервным независимо отказоустойчивыми endpoints, одобренными для обработки данных в РФ. Timeout, transport error или circuit breaker основного endpoint переключает job на резервный. `ModerationRequest` использует generation/active-endpoint compare-and-set, поэтому запоздалый ответ предыдущей попытки не может изменить решение. Если оба недоступны, версия остаётся `pending`; ручной модератор не может заменить обязательный автоматический gate.

Provider adapter принимает только `public_content` и только sanitized media по short-lived object-scoped URL. `Messaging` создаёт только `private_message`, не импортирует moderation adapter и не выпускает публичные moderation events. Ограничение проверяется runtime guard и архитектурным тестом.

## Альтернативы

- Один endpoint: дешевле, но является критической зависимостью публикации.
- Ручной fallback: противоречит FR-132/NFR-010 без изменения требований.
- Собственная ML-система: несоразмерна MVP.

## Последствия

- Два договора, privacy review и failover tests повышают стоимость.
- Нужны policy version, provider idempotency key, pending-age alerts и нормализованные violation codes.
- До production должны быть зафиксированы SLA, timeout, rate limits и deletion policy обоих endpoints.

## Триггер пересмотра

Юридически допустимый резервный endpoint отсутствует либо стоимость двух providers превышает согласованный риск простоя публикации; тогда требуется изменение требований или собственный автоматический fallback.
