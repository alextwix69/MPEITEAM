# ADR-013: Deployment platform and scaling path

Status: Accepted

## Context

MVP рассчитан на 30 RPS, 200 одновременных пользователей и 99,5% доступности. Приложение должно запускаться в нескольких экземплярах без sticky session и откатываться не более чем за 30 минут. Stateful services требуют failover, но команда не нуждается в orchestration platform уровня Kubernetes.

Deployment platform влияет на IaC, release pipeline, staffing, networking и операционные runbooks. Поздняя миграция orchestration затронет все workloads, хотя immutable containers уменьшают зависимость от provider.

## Decision

Развёртывать immutable Docker images у provider в РФ без Kubernetes. Reverse proxy/load balancer завершает TLS и маршрутизирует web, REST и WSS. Web и API запускаются минимум в двух local failure domains; worker — отдельной process role с независимо настраиваемой concurrency. PostgreSQL, Redis и S3 использовать как managed stateful services.

Приложение остаётся stateless: sessions, jobs и media не хранятся в памяти instance; Socket.IO fan-out использует Redis adapter. Release выполняется rolling deployment с expand/migrate/contract migrations и возвратом трафика на предыдущий image при дефекте. DR topology определяется ADR-006.

Путь роста: сначала query/index/pool tuning, вертикальный рост managed data services и горизонтальное увеличение API/workers; затем доказанный cache/read replica/partitioning; только после измерений — отдельный search engine, service extraction или Kubernetes.

## Alternatives considered

### Alternative A: Kubernetes с autoscaling

Pros:

- стандартизованные orchestration, rollout и autoscaling;
- удобнее при большом числе независимо выпускаемых workloads.

Cons:

- cluster operations, policies и observability сложнее MVP;
- целевая нагрузка не требует динамического autoscaling;
- повышается on-call и platform engineering cost.

### Alternative B: Один VPS с приложением и stateful services

Pros:

- минимальная стоимость и простое первоначальное развёртывание;
- мало provider-specific managed dependencies.

Cons:

- один failure domain и слабая изоляция ресурсов;
- backup/failover и security ложатся на команду;
- не обеспечивает доказуемый путь к 99,5% и безопасному rolling deploy.

## Consequences

Positive:

- минимальная orchestration complexity при наличии horizontal application scaling;
- stateful failover передан managed services;
- immutable images и stateless processes сохраняют путь к будущей миграции.

Negative:

- нет Kubernetes ecosystem и автоматического workload autoscaling;
- масштабирование модулей внутри API process не независимо;
- PostgreSQL остаётся главным capacity bottleneck.

## Risks

- Provider-specific deployment primitives могут создать lock-in.
- Rolling deploy без capacity headroom временно ухудшит SLO.
- Ошибка pool/concurrency limits способна перегрузить managed PostgreSQL.

## Conditions for revisiting this decision

- число независимо выпускаемых workloads делает текущий rollout ненадёжным;
- ручное capacity management регулярно нарушает SLO;
- появляется platform team, для которой Kubernetes снижает общую стоимость;
- provider limitations препятствуют multi-failure-domain deployment или безопасному autoscaling.
