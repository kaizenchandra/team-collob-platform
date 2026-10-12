ALTER TABLE oidc_sessions ADD COLUMN credential_jwe text;
ALTER TABLE oidc_sessions ADD COLUMN verified_until timestamptz;
ALTER TABLE oidc_sessions ADD COLUMN check_lease_id uuid;
ALTER TABLE oidc_sessions ADD COLUMN check_lease_until timestamptz;
-- No plaintext provider token is stored. Missing credentials require sign-in
-- when reconciliation is enabled; older provider bindings cannot be upgraded silently.
