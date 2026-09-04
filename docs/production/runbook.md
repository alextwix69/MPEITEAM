# Runbook

Документ задаёт порядок диагностики. Конкретные команды и provider-консоли добавляются после выбора production-платформы; секреты и персональные данные в runbook не записываются.

## Общий порядок инцидента

1. Подтвердить alert по dashboard и определить затронутый journey, время начала и correlation IDs.
2. Назначить incident owner и severity; критический инцидент принять не позднее 15 минут.
3. Остановить только опасный side effect или rollout, не удаляя данные и очереди.
4. Проверить последнюю конфигурацию/release, DB health, queue oldest age, provider status и storage.
5. Применить предусмотренную ниже деградацию или rollback.
6. После восстановления проверить SLO, backlog, reconciliation и пользовательские инварианты.
7. Зафиксировать timeline и follow-up без message text/media/PII.

## Автомодерация недоступна

Сигналы: circuit breaker, transport errors, `moderation_pending_age` 5/30 минут.

1. Проверить основной endpoint и факт переключения jobs на резервный.
2. Убедиться, что `private_message` jobs отсутствуют в moderation queue.
3. Если резервный работает, ограничить retries основного и контролировать backlog.
4. Если оба недоступны, объявить degraded publication mode: новые версии остаются `pending`, одобренные версии не скрываются, ручное одобрение вместо автоматического запрещено.
5. Сообщить пользователям о задержке и привлечь providers по SLA.
6. После восстановления постепенно увеличить concurrency, не создавая всплеск DB/S3; проверить oldest age и отсутствие двойных решений.

## Redis/BullMQ или worker недоступны

1. Подтвердить, что API продолжает фиксировать бизнес-операции и outbox deliveries в PostgreSQL.
2. Не очищать outbox, inbox или Redis вручную.
3. Восстановить Redis/worker; reconciliation должен переиздать незавершённые deliveries.
4. Контролировать DLQ, outbox lag, duplicate-domain constraints и email backlog.
5. Manual replay выполнять только по delivery ID и с идемпотентным handler.

## Письма подтверждения email недоступны

Сигналы: рост `outbox.delivery.attempts{consumer="identity.verification-email",result="retry"}`, DLQ либо жалобы на отсутствие писем.

1. Проверить SMTP provider без вывода адресов получателей, verification URL и token в ticket/log.
2. Убедиться, что account остаётся `unverified`, а email delivery присутствует в PostgreSQL outbox.
3. Восстановить provider и дождаться reconciliation; не создавать token и письмо вручную.
4. Для manual replay использовать delivery ID. Детерминированный `Message-ID` равен event ID, но фактическую provider-side дедупликацию проверить отдельно.
5. Если token истёк, пользователь использует generic resend flow; старый token не восстанавливается.

## Legal evidence database недоступна

Сигналы: retry/DLQ consumer `compliance.consent-evidence`, ошибки `CONSENT_EVIDENCE_UNAVAILABLE`, рост возраста неподтверждённых регистраций.

1. Не активировать account вручную и не помечать delivery завершённой без строки `legal.consent_evidence`.
2. Проверить отдельные legal credentials, migration и доступ worker; API не должен иметь эти credentials.
3. После восстановления replay безопасен по `UNIQUE(source_event_id)`.
4. Проверить четыре completed legal deliveries на account и отсутствие email/profile/account ID в legal rows.
5. Убедиться, что verification token не был consumed при временной ошибке и исходная ссылка снова работает.

## PostgreSQL degradation

1. Проверить managed failover, pool saturation, wait events, deadlocks, long statements и недавние migrations.
2. Ограничить background concurrency; остановить rebuild/maintenance, но не критические deletion deadlines.
3. При отказе writer дождаться managed failover с целью ≤15 минут.
4. Если площадка потеряна или данные невосстановимо повреждены, перейти к cold DR.

## Cold DR

1. Объявить disaster и зафиксировать recovery point; запретить запись в повреждённый primary.
2. Развернуть версионированные IaC в DR target в РФ и получить release images по digest.
3. Восстановить PostgreSQL и legal evidence DB до согласованной точки, затем media inventory/objects.
4. Ротировать credentials, provider keys, cookie/CSRF и encryption secrets; прежние sessions считать отозванными.
5. Поднять Redis/BullMQ пустым или из допустимой копии; восстановление side effects выполнить из PostgreSQL outbox deliveries.
6. Запустить integrity checks и smoke journeys: login, профиль, поиск, отклик, сообщение, moderation, media access.
7. Переключить DNS/TLS/edge только после formal go/no-go.
8. Зафиксировать фактические RPO/RTO. Цели: RPO ≤24 ч, RTO ≤8 ч.

## Media incident

- При malware/sanitization failure объект остаётся в quarantine/failed и не прикрепляется.
- Provider получает только sanitized `public_content` по object-scoped URL.
- При подозрении на утечку URL отозвать provider credentials/URL issuer, закрыть egress и проверить access metadata без скачивания пользовательских объектов в логи.
- Private media не отправлять на ручной анализ вне конкретной жалобы и permission `evidence.view`.

## Жалоба на сообщение

1. Проверить назначение модератора и открытую жалобу.
2. Открыть evidence только через moderation UI; содержимое не копировать в ticket, audit или chat поддержки.
3. Audit фиксирует actor/report/evidence IDs, время и результат доступа.
4. Если источник удалён, отметить evidence `unavailable`; восстановление из backup запрещено.
5. Эскалация FR-159 использует `moderation.escalated_review`, а не глобальные административные права.

## Проверка после восстановления

- API error rate и p95 вернулись в budget;
- outbox/queue oldest age уменьшается;
- нет дублей чатов, уведомлений, сообщений и решений;
- moderation не получила private scope;
- signed URLs и object authorization работают;
- backup/deletion deadlines не пропущены.
