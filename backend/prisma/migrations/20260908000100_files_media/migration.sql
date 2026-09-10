CREATE TYPE files.content_scope AS ENUM ('private_message', 'public_content');
CREATE TYPE files.upload_session_state AS ENUM ('created', 'uploaded', 'processing', 'technically_ready', 'failed', 'expired', 'consumed');
CREATE TYPE files.media_object_state AS ENUM ('uploaded', 'quarantined', 'sanitized', 'technically_ready', 'moderation_pending', 'approved', 'rejected', 'moderation_failed', 'attached', 'deleting', 'deleted');
CREATE TYPE files.media_retention_class AS ENUM ('message_photo', 'profile_asset', 'resume_asset', 'team_asset', 'opportunity_asset', 'event_asset');
CREATE TYPE files.media_binding_owner_type AS ENUM ('profile_version', 'resume_version', 'team_version', 'opportunity_version', 'event_version', 'message');
CREATE TYPE files.media_tombstone_state AS ENUM ('pending', 'in_progress', 'completed', 'failed');

CREATE TABLE files.upload_sessions (
  id uuid PRIMARY KEY,
  owner_account_id uuid NOT NULL,
  content_scope files.content_scope NOT NULL,
  owner_type varchar(64) NOT NULL,
  owner_ref uuid NOT NULL,
  expected_mime varchar(64) NOT NULL,
  expected_size_bytes integer NOT NULL,
  object_key varchar(512) NOT NULL,
  source_etag varchar(128),
  state files.upload_session_state NOT NULL DEFAULT 'created',
  expires_at timestamptz NOT NULL,
  failure_code varchar(100),
  processing_lease_until timestamptz,
  processing_attempt_count integer NOT NULL DEFAULT 0,
  quarantine_deleted_at timestamptz,
  correlation_id uuid NOT NULL,
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT upload_sessions_object_key_key UNIQUE (object_key),
  CONSTRAINT upload_sessions_event_id_key UNIQUE (event_id),
  CONSTRAINT upload_sessions_size_check CHECK (expected_size_bytes BETWEEN 1 AND 5242880),
  CONSTRAINT upload_sessions_object_key_private_check CHECK (object_key !~ '@'),
  CONSTRAINT upload_sessions_mime_check CHECK (expected_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT upload_sessions_owner_type_check CHECK (owner_type IN ('profile', 'resume', 'team', 'opportunity', 'event', 'message_draft')),
  CONSTRAINT upload_sessions_scope_owner_check CHECK (
    (content_scope = 'private_message' AND owner_type = 'message_draft') OR
    (content_scope = 'public_content' AND owner_type IN ('profile', 'resume', 'team', 'opportunity', 'event'))
  ),
  CONSTRAINT upload_sessions_failure_check CHECK (
    (state IN ('failed', 'expired') AND failure_code IS NOT NULL) OR
    (state NOT IN ('failed', 'expired') AND failure_code IS NULL)
  ),
  CONSTRAINT upload_sessions_lease_check CHECK (
    processing_lease_until IS NULL OR state = 'processing'
  ),
  CONSTRAINT upload_sessions_attempt_count_check CHECK (processing_attempt_count >= 0),
  CONSTRAINT upload_sessions_row_version_check CHECK (row_version >= 0)
);
CREATE INDEX upload_sessions_owner_state_idx ON files.upload_sessions (owner_account_id, state, created_at DESC, id);
CREATE INDEX upload_sessions_expiry_idx ON files.upload_sessions (state, expires_at, id)
  WHERE state IN ('created', 'uploaded', 'processing');
CREATE INDEX upload_sessions_processing_lease_idx ON files.upload_sessions (processing_lease_until, id)
  WHERE state = 'processing';
CREATE INDEX upload_sessions_quarantine_cleanup_idx ON files.upload_sessions (updated_at, id)
  WHERE quarantine_deleted_at IS NULL;

CREATE TABLE files.media_objects (
  id uuid PRIMARY KEY,
  upload_session_id uuid NOT NULL,
  uploader_account_id uuid NOT NULL,
  content_scope files.content_scope NOT NULL,
  state files.media_object_state NOT NULL,
  bucket varchar(128) NOT NULL,
  object_key varchar(512) NOT NULL,
  sha256 bytea NOT NULL,
  mime varchar(64) NOT NULL,
  size_bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  retention_class files.media_retention_class NOT NULL,
  attached_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT media_objects_upload_session_key UNIQUE (upload_session_id),
  CONSTRAINT media_objects_bucket_object_key UNIQUE (bucket, object_key),
  CONSTRAINT media_objects_size_check CHECK (size_bytes BETWEEN 1 AND 1048576),
  CONSTRAINT media_objects_dimensions_check CHECK (width BETWEEN 1 AND 1920 AND height BETWEEN 1 AND 1080),
  CONSTRAINT media_objects_object_key_private_check CHECK (object_key !~ '@'),
  CONSTRAINT media_objects_mime_check CHECK (mime = 'image/jpeg'),
  CONSTRAINT media_objects_row_version_check CHECK (row_version >= 0),
  CONSTRAINT media_objects_scope_state_check CHECK (
    (content_scope = 'private_message' AND state NOT IN ('moderation_pending', 'approved', 'rejected', 'moderation_failed')) OR
    (content_scope = 'public_content' AND state <> 'technically_ready')
  )
);
CREATE INDEX media_objects_message_quota_idx ON files.media_objects (uploader_account_id, attached_at, id)
  WHERE retention_class = 'message_photo' AND state = 'attached';
CREATE INDEX media_objects_owner_state_idx ON files.media_objects (uploader_account_id, state, created_at, id);

CREATE TABLE files.media_bindings (
  media_id uuid PRIMARY KEY,
  owner_type files.media_binding_owner_type NOT NULL,
  owner_id uuid NOT NULL,
  slot smallint NOT NULL,
  bound_at timestamptz NOT NULL,
  CONSTRAINT media_bindings_owner_slot_key UNIQUE (owner_type, owner_id, slot),
  CONSTRAINT media_bindings_slot_check CHECK (slot >= 0),
  CONSTRAINT media_bindings_media_fk FOREIGN KEY (media_id) REFERENCES files.media_objects(id) ON DELETE CASCADE
);

CREATE TABLE files.media_deletion_tombstones (
  media_id uuid PRIMARY KEY,
  bucket varchar(128) NOT NULL,
  object_key varchar(512) NOT NULL,
  state files.media_tombstone_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  lease_until timestamptz,
  completed_at timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT media_tombstones_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT media_tombstones_row_version_check CHECK (row_version >= 0),
  CONSTRAINT media_tombstones_state_check CHECK (
    (state = 'in_progress' AND lease_until IS NOT NULL AND completed_at IS NULL) OR
    (state = 'completed' AND lease_until IS NULL AND completed_at IS NOT NULL) OR
    (state IN ('pending', 'failed') AND lease_until IS NULL AND completed_at IS NULL)
  )
);
CREATE INDEX media_tombstones_due_idx ON files.media_deletion_tombstones (available_at, media_id)
  WHERE state IN ('pending', 'failed');
CREATE INDEX media_tombstones_lease_idx ON files.media_deletion_tombstones (lease_until, media_id)
  WHERE state = 'in_progress';

-- upload_session_id and tombstone.media_id deliberately remain durable references rather than
-- foreign keys: upload-session metadata is purged after 7 days and tombstones outlive deleted media.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komanda_api') THEN
    GRANT USAGE ON SCHEMA files TO komanda_api;
    GRANT USAGE ON TYPE
      files.content_scope,
      files.upload_session_state,
      files.media_object_state,
      files.media_retention_class,
      files.media_binding_owner_type,
      files.media_tombstone_state
    TO komanda_api;
    GRANT SELECT, INSERT, UPDATE ON files.upload_sessions TO komanda_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON files.media_bindings TO komanda_api;
    GRANT SELECT, UPDATE, DELETE ON files.media_objects TO komanda_api;
    GRANT SELECT, INSERT, UPDATE ON files.media_deletion_tombstones TO komanda_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komanda_worker') THEN
    GRANT USAGE ON SCHEMA files TO komanda_worker;
    GRANT USAGE ON TYPE
      files.content_scope,
      files.upload_session_state,
      files.media_object_state,
      files.media_retention_class,
      files.media_binding_owner_type,
      files.media_tombstone_state
    TO komanda_worker;
    GRANT SELECT, UPDATE, DELETE ON files.upload_sessions TO komanda_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON files.media_objects TO komanda_worker;
    GRANT SELECT, DELETE ON files.media_bindings TO komanda_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON files.media_deletion_tombstones TO komanda_worker;
  END IF;
END
$$;
