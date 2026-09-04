CREATE SCHEMA IF NOT EXISTS legal;

CREATE TYPE legal.consent_action AS ENUM ('accepted', 'withdrawn');

CREATE TABLE legal.consent_evidence (
  id uuid PRIMARY KEY,
  subject_token bytea NOT NULL,
  document_type varchar(64) NOT NULL,
  document_version varchar(64) NOT NULL,
  action legal.consent_action NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_event_id uuid NOT NULL,
  evidence_hash bytea NOT NULL,
  retention_until timestamptz NOT NULL,
  CONSTRAINT consent_evidence_source_event_key UNIQUE (source_event_id),
  CONSTRAINT consent_evidence_retention_check CHECK (retention_until <= occurred_at + interval '3 years')
);
CREATE INDEX consent_evidence_subject_occurred_idx ON legal.consent_evidence (subject_token, occurred_at DESC, id);
CREATE INDEX consent_evidence_retention_idx ON legal.consent_evidence (retention_until, id);
