CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS trust;
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TYPE catalog.catalog_version_state AS ENUM ('draft', 'active', 'retired');
CREATE TYPE trust.moderation_content_type AS ENUM ('profile_version', 'resume_version', 'team_version', 'opportunity_version', 'event_version', 'public_media');
CREATE TYPE trust.moderation_request_state AS ENUM ('pending', 'in_progress', 'approved', 'rejected', 'failed');
CREATE TYPE trust.moderation_endpoint AS ENUM ('primary', 'secondary');
CREATE TYPE trust.moderation_outcome AS ENUM ('approved', 'return_for_revision');
CREATE TYPE notifications.email_delivery_state AS ENUM ('pending', 'sending', 'sent', 'failed', 'dead_letter');

CREATE TABLE catalog.versions (
  id uuid PRIMARY KEY,
  version varchar(32) NOT NULL UNIQUE,
  state catalog.catalog_version_state NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX catalog_one_active_version_idx ON catalog.versions ((state)) WHERE state = 'active';

CREATE TABLE catalog.tags (
  id uuid PRIMARY KEY,
  catalog_version_id uuid NOT NULL REFERENCES catalog.versions(id) ON DELETE RESTRICT,
  code varchar(80) NOT NULL,
  name varchar(120) NOT NULL,
  category varchar(120) NOT NULL,
  sort_order smallint NOT NULL CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_version_code_key UNIQUE (catalog_version_id, code),
  CONSTRAINT tags_version_sort_order_key UNIQUE (catalog_version_id, sort_order)
);

CREATE OR REPLACE FUNCTION catalog.prevent_active_catalog_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'versions' THEN
    IF OLD.state IN ('active', 'retired') THEN
      RAISE EXCEPTION 'ACTIVE_CATALOG_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'tags' THEN
    target_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.catalog_version_id ELSE NEW.catalog_version_id END;
    IF EXISTS (SELECT 1 FROM catalog.versions WHERE id = target_version_id AND state <> 'draft') THEN
      RAISE EXCEPTION 'ACTIVE_CATALOG_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_versions_immutable_trigger
BEFORE UPDATE OR DELETE ON catalog.versions
FOR EACH ROW EXECUTE FUNCTION catalog.prevent_active_catalog_mutation();
CREATE TRIGGER catalog_tags_immutable_trigger
BEFORE INSERT OR UPDATE OR DELETE ON catalog.tags
FOR EACH ROW EXECUTE FUNCTION catalog.prevent_active_catalog_mutation();

INSERT INTO catalog.versions (id, version, state)
VALUES ('01991b70-0000-7000-8000-000000000001', '2026-08-17', 'draft');

WITH source(category_order, category, names) AS (
  VALUES
    (1, 'Электроэнергетика', 'Электроэнергетика; Электрические станции; Электроэнергетические системы и сети; Электроснабжение; Кабельные сети; Высоковольтная электроэнергетика; Релейная защита и автоматика; Интеллектуальные энергосистемы; Гидроэнергетика; Возобновляемая энергетика; Распределённая генерация; Накопители энергии'),
    (2, 'Тепловая и атомная энергетика', 'Теплоэнергетика; Теплотехника; Тепловые электрические станции; Промышленная теплоэнергетика; Энергообеспечение предприятий; Энергосбережение; Энергоэффективность и энергоаудит; Ядерная энергетика; Атомные электростанции; Теплофизика; Плазменные и термоядерные установки; Криогеника и техника низких температур'),
    (3, 'Энергомашиностроение и механика', 'Энергетическое машиностроение; Турбинные установки; Газотурбинные установки и двигатели; Паротурбинные установки; Котлы и парогенераторы; Камеры сгорания; Гидравлические и пневматические системы; Машиностроение; Производство энергетического оборудования; Прикладная механика и прочность'),
    (4, 'Электротехника и электроника', 'Электротехника; Электромеханика; Электропривод и автоматика; Электрические и электронные аппараты; Кабельная и электроизоляционная техника; Электротехнологические установки; Электрический транспорт; Электрооборудование транспорта; Силовая электроника; Микроэлектроника и наноэлектроника'),
    (5, 'Радиотехника, связь и фотоника', 'Радиотехника; Радиоэлектронные системы и комплексы; СВЧ-техника; Антенны и радиоволны; Цифровая обработка сигналов; Телекоммуникации; Спутниковая связь; Оптоэлектроника и фотоника; Лазерные и квантово-оптические системы; Светотехника и источники света'),
    (6, 'Автоматизация, приборы и робототехника', 'Автоматизация технологических процессов; Управление в технических системах; Промышленная автоматизация; PLC и SCADA; Приборостроение; Диагностические системы; Метрология и контроль качества; Робототехника; Мехатроника; Встраиваемые системы и IoT'),
    (7, 'Фундаментальные IT-направления', 'Информатика и вычислительная техника; Прикладная математика и информатика; Алгоритмы; Структуры данных; Архитектура вычислительных систем; Операционные системы; Компьютерные сети; Распределённые системы; Базы данных; Информационные системы; Программная инженерия; Системный анализ; Параллельные вычисления; Квантовые вычисления'),
    (8, 'Разработка программного обеспечения', 'Frontend-разработка; Backend-разработка; Fullstack-разработка; Веб-разработка; Разработка для iOS; Разработка для Android; Desktop-разработка; Разработка игр; Разработка встраиваемого ПО; API и интеграции; Ручное тестирование; Автоматизация тестирования; Корпоративные системы и 1С; Low-code и no-code'),
    (9, 'Данные и искусственный интеллект', 'Анализ данных; Data Engineering; Data Science; Машинное обучение; Глубокое обучение; Генеративный искусственный интеллект; Обработка естественного языка; Компьютерное зрение; Распознавание и синтез речи; Рекомендательные системы; Большие данные; Business Intelligence; Визуализация данных; MLOps'),
    (10, 'IT-инфраструктура и безопасность', 'DevOps; Site Reliability Engineering; Облачные технологии; Контейнеризация и оркестрация; CI/CD; Администрирование Linux; Сетевая инженерия; Информационная безопасность; Безопасность приложений; Тестирование на проникновение; SOC и реагирование на инциденты; Компьютерная криминалистика; Криптография; Управление идентификацией и доступом'),
    (11, 'Продукт, дизайн и коммуникации', 'Управление продуктом; Управление проектами; Бизнес-анализ; UX-исследования; UX/UI-дизайн; Графический дизайн; Промышленный дизайн; Веб-дизайн; Медиадизайн; Техническая документация; Связи с общественностью; Реклама и контент-маркетинг'),
    (12, 'Бизнес, экономика и право', 'Экономика; Финансы; Бухгалтерский учёт; Менеджмент; Управление персоналом; Бизнес-информатика; Предпринимательство и стартапы; Продажи; Маркетинг; Логистика; Юриспруденция; Международные отношения'),
    (13, 'Наука и образование', 'Физика; Химия и электрохимия; Материаловедение и наноматериалы; Математическое моделирование; Компьютерное моделирование; Экспериментальные исследования; Исследования и разработки; Научная коммуникация; Преподавание; Образовательные технологии; Академическое письмо; Патенты и интеллектуальная собственность'),
    (14, 'Общество, экология и безопасность', 'Экология; Климатические технологии; Устойчивое развитие; Переработка и циклическая экономика; Охрана труда; Промышленная безопасность; Общественное здоровье; Психология; Волонтёрство; Социальные проекты; Доступность и инклюзия; Урбанистика и умный город'),
    (15, 'Творчество и повседневные интересы', 'Спорт и фитнес; Киберспорт; Музыка; Звук и подкасты; Фотография; Анимация и видеопроизводство; Литература и писательство; Иностранные языки и перевод; Путешествия и туризм; Организация мероприятий; Сообщества и нетворкинг; Карьерное развитие и наставничество')
), expanded AS (
  SELECT category_order, category, tag_name, local_order
  FROM source, LATERAL regexp_split_to_table(names, '; ') WITH ORDINALITY AS tags(tag_name, local_order)
), numbered AS (
  SELECT category, tag_name, row_number() OVER (ORDER BY category_order, local_order)::int AS sort_order
  FROM expanded
)
INSERT INTO catalog.tags (id, catalog_version_id, code, name, category, sort_order)
SELECT (
         substr(md5('komanda-tag-2026-08-17-' || lpad(sort_order::text, 3, '0')), 1, 8) || '-' ||
         substr(md5('komanda-tag-2026-08-17-' || lpad(sort_order::text, 3, '0')), 9, 4) || '-5' ||
         substr(md5('komanda-tag-2026-08-17-' || lpad(sort_order::text, 3, '0')), 14, 3) || '-a' ||
         substr(md5('komanda-tag-2026-08-17-' || lpad(sort_order::text, 3, '0')), 18, 3) || '-' ||
         substr(md5('komanda-tag-2026-08-17-' || lpad(sort_order::text, 3, '0')), 21, 12)
       )::uuid,
       '01991b70-0000-7000-8000-000000000001',
       'tag-' || lpad(sort_order::text, 3, '0'), tag_name, category, sort_order - 1
FROM numbered;

DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.tags WHERE catalog_version_id = '01991b70-0000-7000-8000-000000000001') <> 180 THEN
    RAISE EXCEPTION 'TAG_CATALOG_MUST_CONTAIN_180_ROWS';
  END IF;
END
$$;
UPDATE catalog.versions SET state = 'active', published_at = now()
WHERE id = '01991b70-0000-7000-8000-000000000001';

ALTER TABLE profiles.profile_versions
  ADD COLUMN moderation_decision_id uuid,
  ADD COLUMN moderation_policy_version varchar(64),
  ADD COLUMN moderation_violation_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN moderation_reason varchar(2000);

UPDATE profiles.profiles AS profile
SET pending_version_id = version.id
FROM profiles.profile_versions AS version
WHERE profile.pending_version_id IS NULL
  AND version.profile_id = profile.id
  AND version.state = 'draft'
  AND version.version_no = (
    SELECT max(candidate.version_no)
    FROM profiles.profile_versions AS candidate
    WHERE candidate.profile_id = profile.id AND candidate.state = 'draft'
  );

CREATE TABLE profiles.resume_versions (
  id uuid PRIMARY KEY,
  resume_id uuid NOT NULL REFERENCES profiles.resumes(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  state profiles.public_version_state NOT NULL DEFAULT 'draft',
  about varchar(1024) NOT NULL,
  image_media_id uuid,
  submitted_at timestamptz,
  decided_at timestamptz,
  moderation_decision_id uuid,
  moderation_policy_version varchar(64),
  moderation_violation_codes text[] NOT NULL DEFAULT '{}',
  moderation_reason varchar(2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resume_versions_resume_version_key UNIQUE (resume_id, version_no)
);
UPDATE profiles.profiles SET row_version = 1 WHERE row_version = 0;
UPDATE profiles.resumes SET row_version = 1 WHERE row_version = 0;
ALTER TABLE profiles.profiles ALTER COLUMN row_version SET DEFAULT 1;
ALTER TABLE profiles.resumes ALTER COLUMN row_version SET DEFAULT 1;
ALTER TABLE profiles.profiles ADD CONSTRAINT profiles_row_version_check CHECK (row_version >= 1);
ALTER TABLE profiles.resumes ADD CONSTRAINT resumes_row_version_check CHECK (row_version >= 1);
CREATE UNIQUE INDEX resume_versions_id_resume_key ON profiles.resume_versions (id, resume_id);
CREATE UNIQUE INDEX resume_versions_one_pending_idx ON profiles.resume_versions (resume_id) WHERE state = 'pending';

CREATE TABLE profiles.resume_projects (
  resume_version_id uuid NOT NULL REFERENCES profiles.resume_versions(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  title varchar(200) NOT NULL,
  description varchar(2000) NOT NULL,
  url varchar(2048),
  PRIMARY KEY (resume_version_id, position)
);

CREATE TABLE profiles.resume_version_tags (
  resume_version_id uuid NOT NULL REFERENCES profiles.resume_versions(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL,
  PRIMARY KEY (resume_version_id, tag_id)
);

CREATE OR REPLACE FUNCTION profiles.enforce_resume_tag_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM profiles.resume_versions WHERE id = NEW.resume_version_id FOR UPDATE;
  IF (SELECT count(*) FROM profiles.resume_version_tags WHERE resume_version_id = NEW.resume_version_id) >= 20 THEN
    RAISE EXCEPTION 'RESUME_TAG_LIMIT_EXCEEDED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resume_version_tag_limit_trigger
BEFORE INSERT ON profiles.resume_version_tags
FOR EACH ROW EXECUTE FUNCTION profiles.enforce_resume_tag_limit();

CREATE UNIQUE INDEX profile_versions_id_profile_key ON profiles.profile_versions (id, profile_id);
CREATE UNIQUE INDEX profile_versions_one_pending_idx ON profiles.profile_versions (profile_id) WHERE state = 'pending';
ALTER TABLE profiles.profiles DROP CONSTRAINT profiles_published_version_fk;
ALTER TABLE profiles.profiles DROP CONSTRAINT profiles_pending_version_fk;
ALTER TABLE profiles.profiles
  ADD CONSTRAINT profiles_published_version_owner_fk FOREIGN KEY (published_version_id, id) REFERENCES profiles.profile_versions(id, profile_id),
  ADD CONSTRAINT profiles_pending_version_owner_fk FOREIGN KEY (pending_version_id, id) REFERENCES profiles.profile_versions(id, profile_id);
ALTER TABLE profiles.resumes
  ADD CONSTRAINT resumes_published_version_owner_fk FOREIGN KEY (published_version_id, id) REFERENCES profiles.resume_versions(id, resume_id),
  ADD CONSTRAINT resumes_pending_version_owner_fk FOREIGN KEY (pending_version_id, id) REFERENCES profiles.resume_versions(id, resume_id);

CREATE OR REPLACE FUNCTION profiles.prevent_submitted_version_payload_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' AND (
    to_jsonb(OLD) - ARRAY['state','decided_at','moderation_decision_id','moderation_policy_version','moderation_violation_codes','moderation_reason']
      IS DISTINCT FROM
    to_jsonb(NEW) - ARRAY['state','decided_at','moderation_decision_id','moderation_policy_version','moderation_violation_codes','moderation_reason']
  ) THEN
    RAISE EXCEPTION 'PUBLIC_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profile_versions_payload_immutable_trigger
BEFORE UPDATE ON profiles.profile_versions
FOR EACH ROW EXECUTE FUNCTION profiles.prevent_submitted_version_payload_change();
CREATE TRIGGER resume_versions_payload_immutable_trigger
BEFORE UPDATE ON profiles.resume_versions
FOR EACH ROW EXECUTE FUNCTION profiles.prevent_submitted_version_payload_change();

CREATE TABLE profiles.inbox_events (
  event_id uuid PRIMARY KEY,
  consumer varchar(100) NOT NULL,
  event_version smallint NOT NULL,
  processed_at timestamptz NOT NULL,
  result_ref_id uuid
);
CREATE INDEX profiles_inbox_processed_idx ON profiles.inbox_events (processed_at, event_id);

CREATE TABLE trust.moderation_requests (
  id uuid PRIMARY KEY,
  content_type trust.moderation_content_type NOT NULL,
  content_version_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  policy_version varchar(64) NOT NULL,
  state trust.moderation_request_state NOT NULL DEFAULT 'pending',
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  active_endpoint trust.moderation_endpoint NOT NULL DEFAULT 'primary',
  provider_request_key varchar(200) NOT NULL UNIQUE,
  pending_since timestamptz NOT NULL,
  lease_until timestamptz,
  decided_at timestamptz,
  violation_codes text[] NOT NULL DEFAULT '{}',
  failure_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT moderation_request_content_key UNIQUE (content_type, content_version_id, policy_version),
  CONSTRAINT moderation_request_lease_check CHECK (lease_until IS NULL OR state = 'in_progress')
);
CREATE INDEX moderation_requests_pending_idx ON trust.moderation_requests (state, pending_since, id)
WHERE state IN ('pending', 'in_progress');

CREATE TABLE trust.moderation_decisions (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL UNIQUE,
  content_type varchar(32) NOT NULL CHECK (content_type IN ('profile', 'resume', 'public_media')),
  content_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  outcome trust.moderation_outcome NOT NULL,
  policy_version varchar(64) NOT NULL,
  violation_codes text[] NOT NULL DEFAULT '{}',
  reason varchar(2000),
  decided_at timestamptz NOT NULL
);
CREATE INDEX moderation_decisions_content_idx ON trust.moderation_decisions (content_type, content_id, decided_at DESC, id);

CREATE TABLE trust.inbox_events (
  event_id uuid PRIMARY KEY,
  consumer varchar(100) NOT NULL,
  event_version smallint NOT NULL,
  processed_at timestamptz NOT NULL,
  result_ref_id uuid
);
CREATE INDEX trust_inbox_processed_idx ON trust.inbox_events (processed_at, event_id);

CREATE TABLE notifications.notifications (
  id uuid PRIMARY KEY,
  recipient_account_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  type varchar(80) NOT NULL,
  resource_type varchar(64),
  resource_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT notifications_event_recipient_type_key UNIQUE (source_event_id, recipient_account_id, type)
);
CREATE INDEX notifications_recipient_created_idx ON notifications.notifications (recipient_account_id, created_at DESC, id DESC);
CREATE INDEX notifications_recipient_unread_idx ON notifications.notifications (recipient_account_id, created_at DESC, id DESC) WHERE read_at IS NULL;

CREATE TABLE notifications.email_deliveries (
  id uuid PRIMARY KEY,
  source_event_id uuid NOT NULL,
  recipient_account_id uuid NOT NULL,
  template_code varchar(80) NOT NULL,
  provider_message_key varchar(200) NOT NULL UNIQUE,
  state notifications.email_delivery_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX email_deliveries_event_recipient_template_key ON notifications.email_deliveries (source_event_id, recipient_account_id, template_code);
CREATE INDEX email_deliveries_due_idx ON notifications.email_deliveries (available_at, id) WHERE state IN ('pending', 'failed');

CREATE TABLE notifications.inbox_events (
  event_id uuid PRIMARY KEY,
  consumer varchar(100) NOT NULL,
  event_version smallint NOT NULL,
  processed_at timestamptz NOT NULL,
  result_ref_id uuid
);
CREATE INDEX notifications_inbox_processed_idx ON notifications.inbox_events (processed_at, event_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komanda_api') THEN
    GRANT USAGE ON SCHEMA catalog, notifications TO komanda_api;
    GRANT SELECT ON catalog.versions, catalog.tags TO komanda_api;
    GRANT SELECT, INSERT, UPDATE ON notifications.notifications TO komanda_api;
    GRANT SELECT, INSERT, UPDATE ON notifications.email_deliveries, notifications.inbox_events TO komanda_api;
    GRANT SELECT, INSERT, UPDATE ON profiles.resume_versions, profiles.resume_projects, profiles.resume_version_tags, profiles.inbox_events TO komanda_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komanda_worker') THEN
    GRANT USAGE ON SCHEMA catalog, trust, notifications TO komanda_worker;
    GRANT SELECT ON catalog.versions, catalog.tags TO komanda_worker;
    GRANT SELECT, INSERT, UPDATE ON trust.moderation_requests, trust.moderation_decisions, trust.inbox_events TO komanda_worker;
    GRANT SELECT, INSERT, UPDATE ON notifications.notifications, notifications.email_deliveries, notifications.inbox_events TO komanda_worker;
    GRANT SELECT, INSERT, UPDATE ON profiles.profiles, profiles.profile_versions, profiles.resumes, profiles.resume_versions, profiles.resume_projects, profiles.resume_version_tags, profiles.inbox_events TO komanda_worker;
    GRANT INSERT ON platform.outbox_events, platform.outbox_deliveries TO komanda_worker;
  END IF;
END
$$;
