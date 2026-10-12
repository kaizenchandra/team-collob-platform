CREATE TABLE oidc_sessions (
  token_hash text PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
  issuer text NOT NULL, client_id text NOT NULL, subject text NOT NULL,
  sid text, issued_at bigint NOT NULL
);
CREATE INDEX oidc_session_lookup ON oidc_sessions(issuer,client_id,sid);
CREATE INDEX oidc_subject_lookup ON oidc_sessions(issuer,client_id,subject);
CREATE TABLE oidc_logout_events (
  issuer text NOT NULL, client_id text NOT NULL, jti text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  PRIMARY KEY(issuer,client_id,jti)
);
CREATE TABLE oidc_revocations (
  issuer text NOT NULL, client_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('sid','sub')),
  value text NOT NULL, issued_at bigint NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  PRIMARY KEY(issuer,client_id,kind,value)
);
