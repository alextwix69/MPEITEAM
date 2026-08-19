# Rollback

Цель: вернуть предыдущий совместимый application image не более чем за 30 минут без потери подтверждённых данных.

## Когда выполнять rollback

- устойчивое нарушение error/latency SLO после начала rollout;
- security regression в auth, Socket.IO, object authorization или media scope;
- нарушение доменного инварианта или рост неидемпотентных side effects;
- несовместимость API со старым клиентом;
- неконтролируемый DB/queue load, связанный с новым release.

Сбой внешнего provider сам по себе не требует rollback, если primary/secondary failover и documented degraded mode работают.

## Предусловия

- предыдущий image доступен по immutable digest;
- OpenAPI и schema compatibility с предыдущей версией подтверждены;
- миграции выполнены по expand/migrate/contract;
- snapshot/backup status проверен до rollout;
- назначены release owner и incident owner.

## Порядок

1. Остановить дальнейший rollout и зафиксировать текущие image/migration versions.
2. Отключить новые feature flags или producer событий, которых не понимает старая версия.
3. Перевести workers на предыдущий совместимый image раньше либо одновременно с API, сохраняя обработку уже созданных event versions.
4. Последовательно вернуть API/web instances по failure domains и проверить readiness.
5. Не откатывать committed business data и не выполнять destructive down-migration.
6. Проверить login, OpenAPI health, поиск, создание отклика, сообщение, outbox processing, media и moderation failover.
7. Убедиться, что error rate/p95 и queue lag возвращаются в budget; завершить rollback не позднее 30 минут.

## Правила схемы и API

- `expand`: новая nullable/table/index структура совместима со старым приложением.
- `migrate`: backfill выполняется bounded batches и может быть остановлен/продолжен.
- `contract`: удаление старого поля/таблицы выполняется отдельным release только после исчезновения старых consumers и окна rollback.
- Внутри `/api/v1` rollback не должен встречать обязательное новое поле или удалённый response field.
- Outbox event содержит version; consumer либо понимает её, либо безопасно откладывает в DLQ, но не угадывает payload.

## Когда application rollback недостаточен

При необратимой порче данных остановить записи и перейти к процедуре cold DR из `runbook.md`. Restore базы не является обычным rollback и требует отдельного go/no-go, оценки RPO и уведомления владельца данных.

## После rollback

- сохранить correlation IDs и timeline без ПДн;
- проверить reconciliation незавершённых outbox deliveries;
- убедиться, что primary/secondary moderation adapters используют совместимый contract;
- создать corrective action и запретить повторный rollout до прохождения соответствующего readiness gate.
