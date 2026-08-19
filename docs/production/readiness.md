# Готовность к production

Статус: обязательный release gate MVP. Checklist считается пройденным только при приложенных ссылках на результаты проверок и назначенных владельцах отклонений.

## 1. Требования и право

- [ ] Product-spec и технические NFR имеют утверждённые версии; открытые изменения отражены в requirements log/ADR.
- [ ] Выполнены условия BR-023a: оператор ПДн, политика, соглашение, отдельные согласия, необходимые уведомления и заключение профильного юриста.
- [ ] Основной и резервный endpoints автомодерации одобрены для обработки данных в РФ; зафиксированы SLA, timeout, rate limits и deletion policy.
- [ ] Подтверждено, что private messages/media не передаются внешним moderation providers.
- [ ] Решение по snapshot evidence после удаления принято явно; до его принятия snapshots отсутствуют.

## 2. Security gate

- [ ] Dependency/container/secrets scans не содержат неустранённых critical findings.
- [ ] Проверены CSRF, Origin allowlist, Socket.IO CSWSH, session revoke, чужие rooms и object-level authorization.
- [ ] Архитектурный тест запрещает `Messaging -> ContentModerator`; runtime test отклоняет `private_message` scope.
- [ ] Проверены MIME/magic bytes, malware scan, EXIF removal, resize и provider-scoped URLs.
- [ ] Moderation permissions минимальны; `evidence.view` доступен только назначенному модератору и аудируется metadata.
- [ ] Logs/traces не содержат email, tokens, message text, media или полное resume.
- [ ] Проведена ротация production secrets и проверен incident-access process.

## 3. Data and recovery gate

- [ ] Миграции соответствуют expand/migrate/contract и совместимы с предыдущим release.
- [ ] Проверены UNIQUE/CHECK/FK, idempotency keys, outbox/inbox и canonical interaction locks.
- [ ] Automated backups PostgreSQL, legal evidence DB и media успешны; пользовательский retention не превышает 21 день.
- [ ] Квартальный restore выполнен в cold DR target, а не только рядом с production.
- [ ] Подтверждены RPO ≤24 ч, disaster RTO ≤8 ч и local failover objective ≤15 мин.
- [ ] Удаление аккаунта проверено до object storage и истечения backup retention.

## 4. Capacity and resilience gate

- [ ] Mixed test воспроизводит 30 RPS, включая 5 write RPS, и 200 Socket.IO connections.
- [ ] В смесь входят поиск, сообщения, отклики, media processing, notifications, outbox и moderation.
- [ ] Короткий peak test и soak test не нарушают TNFR p50/p95/p99 и не создают неограниченный queue/outbox lag.
- [ ] После теста остаётся не менее 30% запаса DB CPU/connections и worker capacity.
- [ ] Проверены отказы Redis, email, primary moderation endpoint, S3 и одной app failure domain.
- [ ] Полный rebuild агрегатов не запускается в пике; background concurrency/pools ограничены.

## 5. API and release gate

- [ ] OpenAPI compatibility check не обнаруживает breaking changes внутри `/api/v1`.
- [ ] Проходят old-client/new-API и new-client/old-API contract tests.
- [ ] Проходят unit, integration, API и основные Playwright journeys на поддерживаемых desktop/mobile browsers.
- [ ] Release image неизменяем и идентифицирован digest; SBOM сохранён.
- [ ] Предыдущий совместимый image доступен, rollback rehearsal укладывается в 30 минут.

## 6. Observability and operations gate

- [ ] Dashboard показывает availability, error rate, p50/p95/p99, DB pools/waits/locks, queue lag, media и moderation.
- [ ] Alerts проверены тестовым сигналом: backups, outbox/DLQ, moderation pending 5/30 мин, provider circuit breaker, deletion deadline.
- [ ] Correlation ID проходит через HTTP, outbox, BullMQ и provider calls.
- [ ] Назначены on-call owner и escalation contacts; критический alert принимается не позднее 15 минут.
- [ ] Актуальны `runbook.md` и `rollback.md`; ссылки доступны дежурной команде.
