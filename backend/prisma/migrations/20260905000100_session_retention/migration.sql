CREATE INDEX sessions_revoked_retention_idx ON identity.sessions (revoked_at, id) WHERE revoked_at IS NOT NULL;
CREATE INDEX sessions_expiry_retention_idx ON identity.sessions (expires_at, id);
