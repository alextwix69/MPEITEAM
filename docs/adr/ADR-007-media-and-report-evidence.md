# ADR-007: Media boundary and report evidence

Статус: принято.
Дата: 19.08.2026.

## Контекст

Медиа должно пройти техническую sanitization, публичное изображение — дополнительную автомодерацию. Модератор должен рассмотреть жалобу на сообщение, но текст и media запрещено помещать в audit/logs. Чат может быть физически удалён в любой момент.

## Решение

Upload session имеет неизменяемый scope `private_message` или `public_content`. Оба проходят quarantine, MIME/magic-byte validation, malware scan, EXIF removal и resize. Только `public_content` переходит к `ContentModerator`; провайдер получает short-lived scoped URL на sanitized object.

При создании жалобы `Messaging` атомарно фиксирует immutable revision текущего текста только для оспариваемого сообщения; обычные редактирования историю не создают. `ReportEvidence` ссылается на эту revision и attachment, существовавшие в момент жалобы, а не копирует содержимое в audit. `evidence.view` выдаёт назначенному модератору доступ только из открытой жалобы; audit содержит metadata доступа. После физического удаления message/chat reported revision и attachments удаляются, evidence становится `unavailable`; извлечение из backup запрещено.

## Альтернативы

- Копировать snapshot в audit: нарушает требования к журналам.
- Хранить отдельный encrypted snapshot после удаления: улучшает рассмотрение, но меняет FR-124 и требует явного правового основания/retention.
- Не давать модератору содержимое: делает жалобу на сообщение практически нерассматриваемой.

## Последствия

- Жалоба может остаться без содержимого, если чат удалён до рассмотрения.
- Любой будущий snapshot требует предварительного изменения product-spec, политики обработки и этого ADR.
- Архитектурные и security tests подтверждают отсутствие пути private media к provider.

## Триггер пересмотра

Product/legal review утверждает основание и срок хранения snapshot evidence после удаления либо практика показывает неприемлемую долю `unavailable` жалоб.
