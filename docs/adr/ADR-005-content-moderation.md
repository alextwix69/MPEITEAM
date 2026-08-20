# ADR-005: Content moderation boundary and provider failover

Status: Accepted

## Context

Каждая новая версия публичного контента обязана пройти автомодерацию до публикации. Приватная переписка не должна передаваться внешнему provider. Недоступность единственного endpoint остановит публикацию и основную продуктовую воронку.

Moderation boundary определяет публичность контента, обработку персональных данных и критическую внешнюю зависимость. Замена модели после запуска затронет state machines контента, договоры с providers, аудит и апелляции.

## Decision

Использовать port `ContentModerator` с основным и резервным независимо отказоустойчивыми endpoints, одобренными для обработки данных в РФ. Worker передаёт только минимально необходимый `public_content` и sanitized media по short-lived object-scoped URL.

Timeout, transport error или открытый circuit breaker основного endpoint переключает job на резервный. `ModerationRequest` хранит generation и active endpoint; только результат активной generation может завершить request. Повтор использует стабильный provider idempotency key, а ответы нормализуются в стабильные violation codes с policy version.

Если оба endpoints недоступны, версия остаётся `pending` и скрытой. Ручной модератор не заменяет обязательный автоматический gate. `Messaging` не импортирует moderation adapter и не выпускает public moderation events.

## Alternatives considered

### Alternative A: Один moderation endpoint

Pros:

- один договор, privacy review и adapter;
- ниже стоимость интеграции.

Cons:

- provider становится single point of failure публикации;
- длительный outage блокирует основную воронку;
- смена provider в аварии не проверена заранее.

### Alternative B: Ручной или fail-open fallback

Pros:

- публикация может продолжаться при полном outage providers;
- меньше стоимость второго provider.

Cons:

- противоречит обязательной автомодерации до публикации;
- повышает риск размещения запрещённого контента;
- ручная очередь не обеспечивает требуемую latency и capacity.

## Consequences

Positive:

- отказ одного provider не останавливает публикацию;
- приватная переписка архитектурно отделена от внешней модерации;
- решения providers приводятся к стабильному внутреннему контракту.

Negative:

- нужны два договора, два security/privacy review и регулярные failover tests;
- пользователи могут видеть длительный `pending` при отказе обоих endpoints;
- generation/CAS state machine сложнее простого вызова API.

## Risks

- Оба endpoints могут зависеть от одного underlying provider или failure domain.
- Запоздалый ответ без корректной generation check способен перезаписать решение.
- Provider может изменить retention, rate limits или трактовку violation codes.

## Conditions for revisiting this decision

- юридически допустимый независимый резервный endpoint отсутствует;
- стоимость двух providers превышает согласованный риск простоя публикации;
- требования разрешают иной автоматический или ручной fallback;
- появляется экономически оправданная собственная moderation capability.
