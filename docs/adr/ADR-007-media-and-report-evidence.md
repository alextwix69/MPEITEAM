# ADR-007: Media boundary and report evidence

Status: Accepted

## Context

Медиа должно пройти sanitization, а публичное изображение — дополнительную автомодерацию. Модератору нужно рассмотреть жалобу на сообщение, но текст и media запрещено помещать в audit и operational logs. Чат может быть физически удалён в любой момент, после чего его содержимое нельзя восстанавливать из backup ради модерации.

Решение определяет data lifecycle, privacy boundary и доказательную базу жалоб. Позднее изменение retention или создание скрытых копий затронет пользовательские обещания, политику обработки данных и процесс удаления.

## Decision

Хранить media в private S3-compatible storage в РФ, а metadata и связи — в PostgreSQL. Upload session имеет неизменяемый scope `private_message` или `public_content`. Оба scope проходят quarantine, magic-byte/MIME validation, malware scan, EXIF removal и resize. Только `public_content` передаётся `ContentModerator`; provider получает short-lived URL на один sanitized object.

При создании жалобы `Messaging` атомарно фиксирует immutable revision текущего текста только для оспариваемого сообщения. `ReportEvidence` ссылается на эту revision и существовавшие attachments, не копируя содержимое в audit. `evidence.view` доступен назначенному модератору только из открытой жалобы; audit хранит лишь metadata доступа.

После физического удаления message/chat reported revision и attachments удаляются, evidence становится `unavailable`; извлечение из backup запрещено. Отдельный post-deletion snapshot без предварительного product/legal решения не создаётся.

## Alternatives considered

### Alternative A: Копировать evidence snapshot в audit

Pros:

- жалоба остаётся рассматриваемой после удаления чата;
- единое место для истории модерации.

Cons:

- audit начинает хранить текст переписки и media;
- нарушаются privacy и deletion boundaries;
- расширяется круг доступа к чувствительным данным.

### Alternative B: Хранить отдельный encrypted snapshot после удаления

Pros:

- содержимое доступно только узкому moderation workflow;
- можно установить отдельный retention и access audit.

Cons:

- меняется обещание физического удаления;
- требуется отдельное правовое основание, срок и пользовательская политика;
- появляется ещё одно хранилище чувствительных копий.

## Consequences

Positive:

- опасные и несанитизированные файлы не доставляются пользователям;
- private media не имеет пути к moderation provider;
- audit не превращается в архив переписки.

Negative:

- жалоба может остаться без содержимого при удалении чата до рассмотрения;
- upload и public-media state machines сложнее прямой загрузки;
- любой post-deletion evidence retention требует отдельного продуктового решения.

## Risks

- Ошибка `contentScope` или adapter dependency может раскрыть private media provider.
- Signed URL с чрезмерным сроком или scope расширит доступ.
- Tombstone job может оставить orphaned object либо удалить объект раньше фиксации жалобы.

## Conditions for revisiting this decision

- product owner и юрист утверждают основание, точный retention, доступ и пользовательскую политику для post-deletion evidence;
- доля `unavailable` жалоб становится неприемлемой и подтверждена метриками;
- S3 provider не обеспечивает требуемые private endpoints, lifecycle или data residency;
- требования к типам или объёму media существенно меняются.
