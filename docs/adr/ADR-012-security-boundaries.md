# ADR-012: Security and data isolation boundaries

Status: Accepted

## Context

Система хранит персональные данные, резюме, переписку, moderation evidence и media. Только web/API должны принимать публичный трафик. Moderator UI не является доверенной зоной, а legal evidence требует более узкого доступа и отдельного retention. Компрометация одного application component не должна автоматически раскрывать все data stores.

Network topology, service identities и data access grants трудно изменить после развёртывания: они пронизывают IaC, secrets, provider contracts и incident response.

## Decision

Использовать три зоны: public edge, private application network и private data network. Только load balancer/reverse proxy имеет public inbound. Web, API и worker находятся в application zone; PostgreSQL, Redis и S3 доступны только через private endpoints. Внешний egress ограничен email и одобренными moderation endpoints.

API является единственной пользовательской границей доступа к business data и signed URLs. Worker использует отдельную service identity с минимальными grants. Moderator actions повторно авторизуются server-side и аудируются.

Legal evidence размещаются в отдельной database с отдельными credentials и без внешних FK. Private messages/media не имеют dependency path к `ContentModerator`. Logs, traces и audit не содержат message text, media, secrets, email или full resume.

## Alternatives considered

### Alternative A: Плоская сеть с общими application credentials

Pros:

- проще настройка connectivity и secrets;
- меньше service identities и firewall rules.

Cons:

- компрометация одного процесса открывает больше stores и операций;
- невозможно доказать least privilege;
- lateral movement сложнее ограничить и расследовать.

### Alternative B: Отдельный account/VPC и database для каждого модуля

Pros:

- максимальная blast-radius и ownership isolation;
- сильные infrastructure-level module boundaries.

Cons:

- высокая стоимость сети, credentials и observability;
- усложняет локальные ACID invariants modular monolith;
- несоразмерно масштабу и одной команде MVP.

## Consequences

Positive:

- data stores не доступны напрямую из Internet;
- service compromise ограничивается network rules и grants;
- legal evidence и moderation access имеют отдельный контролируемый scope.

Negative:

- IaC, firewall rules, private endpoints и secret rotation требуют сопровождения;
- debugging connectivity становится сложнее;
- единая application zone не изолирует каждый bounded context на уровне сети.

## Risks

- Слишком широкая worker identity обойдёт логические module boundaries.
- Ошибка reverse proxy или egress rules может открыть private endpoint.
- PII может попасть в telemetry через несанитизированные exception attributes.

## Conditions for revisiting this decision

- threat model или regulation требует физической изоляции отдельного domain;
- появляется несколько независимо администрируемых команд или tenants;
- provider не поддерживает private endpoints или требуемые network controls;
- security incident показывает недостаточность текущего blast-radius isolation.
