-- Sessions issued before provider bindings existed cannot be safely classified.
-- Require one reauthentication; preserve messages, drafts and membership data.
WITH removed AS (
  DELETE FROM sessions s
  WHERE s.created_at < (SELECT applied_at FROM schema_migrations WHERE name='004_provider_sessions.sql')
    AND NOT EXISTS (SELECT 1 FROM oidc_sessions p WHERE p.token_hash=s.token_hash)
  RETURNING token_hash
)
INSERT INTO audit(action,target,metadata)
SELECT 'identity.legacy_sessions_revoked','migration005',jsonb_build_object('revokedSessions',count(*)) FROM removed;
