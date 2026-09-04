CREATE TYPE identity.formal_role AS ENUM ('student', 'teacher', 'employer');
CREATE TYPE identity.system_role AS ENUM ('user', 'moderator');
CREATE TYPE identity.account_state AS ENUM ('unverified', 'active', 'deleting', 'deleted');
CREATE TYPE identity.auth_token_purpose AS ENUM ('email_verification', 'password_reset');
CREATE TYPE identity.consent_document_type AS ENUM ('age_18', 'user_terms', 'personal_data', 'public_profile_distribution');
CREATE TYPE profiles.publication_state AS ENUM ('draft', 'pending', 'published', 'revision_required', 'hidden', 'deleting');
CREATE TYPE profiles.public_version_state AS ENUM ('draft', 'pending', 'approved', 'rejected');
CREATE TYPE platform.idempotency_state AS ENUM ('in_progress', 'completed', 'failed');
CREATE TYPE platform.outbox_delivery_state AS ENUM ('pending', 'leased', 'completed', 'dead_letter');

CREATE TABLE identity.accounts (
  id uuid PRIMARY KEY,
  email_normalized varchar(320) NOT NULL,
  formal_role identity.formal_role NOT NULL,
  system_role identity.system_role NOT NULL DEFAULT 'user',
  state identity.account_state NOT NULL DEFAULT 'unverified',
  email_verified_at timestamptz,
  deletion_requested_at timestamptz,
  deletion_irreversible_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT accounts_email_normalized_key UNIQUE (email_normalized),
  CONSTRAINT accounts_mpei_role_domain_check CHECK (
    formal_role = 'employer' OR email_normalized ~ '^[^@]+@mpei\.ru$'
  ),
  CONSTRAINT accounts_state_time_check CHECK (
    (state = 'unverified' AND email_verified_at IS NULL) OR
    (state = 'active' AND email_verified_at IS NOT NULL) OR
    state IN ('deleting', 'deleted')
  )
);
CREATE INDEX accounts_active_last_login_idx ON identity.accounts (last_login_at, id) WHERE state = 'active';

CREATE TABLE identity.credentials (
  account_id uuid PRIMARY KEY REFERENCES identity.accounts(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  argon2_parameters jsonb NOT NULL,
  password_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.auth_tokens (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES identity.accounts(id) ON DELETE CASCADE,
  purpose identity.auth_token_purpose NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tokens_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX auth_tokens_open_expiry_idx ON identity.auth_tokens (expires_at, id) WHERE consumed_at IS NULL;
CREATE INDEX auth_tokens_account_purpose_created_idx ON identity.auth_tokens (account_id, purpose, created_at DESC);

CREATE TABLE identity.sessions (
  id uuid PRIMARY KEY,
  session_hash bytea NOT NULL,
  account_id uuid NOT NULL REFERENCES identity.accounts(id) ON DELETE CASCADE,
  csrf_secret_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_session_hash_key UNIQUE (session_hash)
);
CREATE INDEX sessions_account_active_idx ON identity.sessions (account_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_active_expiry_idx ON identity.sessions (expires_at, id) WHERE revoked_at IS NULL;

CREATE TABLE identity.consent_statuses (
  account_id uuid NOT NULL REFERENCES identity.accounts(id) ON DELETE CASCADE,
  document_type identity.consent_document_type NOT NULL,
  document_version varchar(64) NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  source_event_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, document_type),
  CONSTRAINT consent_status_active_check CHECK (accepted_at IS NOT NULL OR revoked_at IS NOT NULL)
);

CREATE TABLE profiles.profiles (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  formal_role identity.formal_role NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'Europe/Moscow',
  publication_state profiles.publication_state NOT NULL DEFAULT 'draft',
  published_version_id uuid,
  pending_version_id uuid,
  edit_locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT profiles_account_id_key UNIQUE (account_id),
  CONSTRAINT profiles_version_pointers_differ CHECK (published_version_id IS NULL OR pending_version_id IS NULL OR published_version_id <> pending_version_id)
);

CREATE TABLE profiles.profile_versions (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles.profiles(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  state profiles.public_version_state NOT NULL DEFAULT 'draft',
  full_name varchar(200) NOT NULL,
  specialization varchar(200) NOT NULL,
  institute varchar(200),
  course smallint,
  department varchar(200),
  company varchar(200),
  position varchar(200),
  avatar_media_id uuid,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_versions_profile_version_key UNIQUE (profile_id, version_no),
  CONSTRAINT profile_versions_course_check CHECK (course IS NULL OR course BETWEEN 1 AND 6)
);

ALTER TABLE profiles.profiles
  ADD CONSTRAINT profiles_published_version_fk FOREIGN KEY (published_version_id) REFERENCES profiles.profile_versions(id),
  ADD CONSTRAINT profiles_pending_version_fk FOREIGN KEY (pending_version_id) REFERENCES profiles.profile_versions(id);

CREATE OR REPLACE FUNCTION profiles.validate_profile_version_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_role identity.formal_role;
BEGIN
  SELECT formal_role INTO parent_role FROM profiles.profiles WHERE id = NEW.profile_id;
  IF parent_role = 'student' AND NOT (
    NEW.institute IS NOT NULL AND NEW.course IS NOT NULL AND
    NEW.department IS NULL AND NEW.company IS NULL AND NEW.position IS NULL
  ) THEN RAISE EXCEPTION 'PROFILE_ROLE_FIELDS_INVALID' USING ERRCODE = '23514';
  ELSIF parent_role = 'teacher' AND NOT (
    NEW.department IS NOT NULL AND NEW.institute IS NULL AND NEW.course IS NULL AND
    NEW.company IS NULL AND NEW.position IS NULL
  ) THEN RAISE EXCEPTION 'PROFILE_ROLE_FIELDS_INVALID' USING ERRCODE = '23514';
  ELSIF parent_role = 'employer' AND NOT (
    NEW.company IS NOT NULL AND NEW.institute IS NULL AND NEW.course IS NULL AND NEW.department IS NULL
  ) THEN RAISE EXCEPTION 'PROFILE_ROLE_FIELDS_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profile_versions_role_fields_trigger
BEFORE INSERT OR UPDATE ON profiles.profile_versions
FOR EACH ROW EXECUTE FUNCTION profiles.validate_profile_version_role();

CREATE TABLE profiles.resumes (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles.profiles(id) ON DELETE CASCADE,
  slot smallint NOT NULL,
  is_search_visible boolean NOT NULL,
  publication_state profiles.publication_state NOT NULL DEFAULT 'draft',
  published_version_id uuid,
  pending_version_id uuid,
  edit_locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT resumes_profile_slot_key UNIQUE (profile_id, slot),
  CONSTRAINT resumes_slot_check CHECK (slot BETWEEN 0 AND 5),
  CONSTRAINT resumes_primary_visible_check CHECK (slot <> 0 OR is_search_visible),
  CONSTRAINT resumes_version_pointers_differ CHECK (published_version_id IS NULL OR pending_version_id IS NULL OR published_version_id <> pending_version_id)
);

CREATE TABLE platform.idempotency_records (
  id uuid PRIMARY KEY,
  actor_account_id uuid,
  public_subject_hash bytea,
  route varchar(160) NOT NULL,
  key varchar(128) NOT NULL,
  request_hash bytea NOT NULL,
  state platform.idempotency_state NOT NULL,
  response_status integer,
  response_ref_type varchar(80),
  response_ref_id uuid,
  response_body jsonb,
  response_secret bytea,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_scope_check CHECK ((actor_account_id IS NULL) <> (public_subject_hash IS NULL))
);
CREATE UNIQUE INDEX idempotency_records_actor_key ON platform.idempotency_records (actor_account_id, route, key) WHERE actor_account_id IS NOT NULL;
CREATE UNIQUE INDEX idempotency_records_public_key ON platform.idempotency_records (public_subject_hash, route, key) WHERE public_subject_hash IS NOT NULL;
CREATE INDEX idempotency_records_expiry_idx ON platform.idempotency_records (expires_at, id);

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  event_type varchar(120) NOT NULL,
  event_version smallint NOT NULL,
  aggregate_type varchar(80) NOT NULL,
  aggregate_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  actor_account_id uuid,
  payload jsonb NOT NULL
);

CREATE TABLE platform.outbox_deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES platform.outbox_events(id) ON DELETE CASCADE,
  consumer varchar(100) NOT NULL,
  state platform.outbox_delivery_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  lease_until timestamptz,
  completed_at timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT outbox_deliveries_event_consumer_key UNIQUE (event_id, consumer)
);
CREATE INDEX outbox_deliveries_due_idx ON platform.outbox_deliveries (available_at, id) WHERE state IN ('pending', 'leased');
CREATE INDEX outbox_deliveries_dead_letter_idx ON platform.outbox_deliveries (state, available_at, id) WHERE state = 'dead_letter';
