-- Short-lived server-only PKCE secrets. Never expose this table through tenant APIs.
CREATE TABLE oidc_transactions (
  state_hash text PRIMARY KEY,
  verifier text NOT NULL,
  nonce text NOT NULL,
  binding text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE INDEX oidc_transactions_expiry ON oidc_transactions(expires_at);
