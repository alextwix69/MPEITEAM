# Журнал уточнений требований

## 08.09.2026 — Files state mapping

В `api/openapi.yaml` публичное состояние загрузки называется `ready`, а в `docs/architecture/data-model.md` внутреннее состояние media — `technically_ready`. Для TASK-006 принят additive-compatible mapping: PostgreSQL хранит `technically_ready`; API/ generated client возвращает `ready` для `private_message` и `moderation_pending` для `public_content` до последующего moderation approval. Публичный OpenAPI enum не изменялся.

`public_content` не выдаётся через download URL до состояния `approved`/`attached`. `private_message` не имеет dependency path к moderation adapter. Owner types будущих bounded contexts передаются как opaque delegated references до публикации их public owner contracts; Files не читает их внутренние repositories.
