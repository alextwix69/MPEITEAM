# ADR-006: Availability and disaster recovery

Status: Accepted

## Context

Сервис должен обеспечивать 99,5% месячной доступности, ежедневные backups, RPO не более 24 часов и RTO не более 8 часов при потере основной площадки или невосстановимой порче данных. Все production-хранилища и backups персональных данных должны находиться в РФ.

DR topology влияет на выбор provider, backup domains, IaC, secrets и регулярные упражнения. Её нельзя надёжно добавить после инцидента; непроверенная резервная копия не доказывает восстановимость.

## Decision

Обычные отказы закрывать двумя application failure domains и managed PostgreSQL/Redis failover с внутренней целью восстановления до 15 минут.

Для потери площадки использовать cold DR target в РФ: отдельный backup failure domain, версионированные IaC, зарезервированные quotas, доступ к immutable images и процедуру восстановления secrets. Disaster objectives: RPO не более 24 часов, RTO не более 8 часов. Active-active между площадками не использовать.

Ежеквартальный DR exercise разворачивает систему в cold target и проверяет PostgreSQL, legal evidence database, media, BullMQ recovery, DNS/TLS и основные journeys. Пользовательские backups хранятся не более 21 дня; legal evidence следует отдельному обоснованному retention.

## Alternatives considered

### Alternative A: Backups без заранее подготовленного recovery target

Pros:

- минимальная постоянная стоимость;
- меньше IaC и зарезервированных ресурсов.

Cons:

- невозможно доказать RTO при полной потере площадки;
- quotas, images, secrets или DNS могут оказаться недоступны во время аварии;
- восстановление впервые проверяется уже в инциденте.

### Alternative B: Warm standby или active-active site

Pros:

- меньшие RTO и потенциальный RPO;
- быстрее переключение при потере площадки.

Cons:

- существенно выше постоянная стоимость;
- сложнее согласованность данных, deploy и эксплуатация;
- заданные RPO/RTO и масштаб MVP этого не требуют.

## Consequences

Positive:

- восстановимость подтверждается регулярным end-to-end exercise;
- backup и recovery failures изолированы от primary site;
- стоимость ниже постоянно активной второй площадки.

Negative:

- полный site outage допускает простой до 8 часов и потерю до 24 часов данных;
- нужны quota reservation, отдельные credentials и регулярные упражнения;
- cold restore сложнее локального managed failover.

## Risks

- Backup может быть логически повреждён или неполон при формально успешном job.
- IaC, images или secrets могут разойтись с production между exercises.
- Восстановление BullMQ без сверки с outbox может повторить side effects.

## Conditions for revisiting this decision

- бизнес требует RPO существенно меньше 24 часов или RTO меньше времени cold restore;
- 99,5% должно соблюдаться даже при полной потере площадки;
- DR exercises дважды подряд не укладываются в RTO;
- стоимость warm standby становится ниже ожидаемого ущерба от cold recovery.
