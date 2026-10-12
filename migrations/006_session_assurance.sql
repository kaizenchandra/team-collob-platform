-- Additive schema evolution. Legacy provider sessions have unknown assurance and
-- are rejected whenever the running API requires a specific ACR.
ALTER TABLE oidc_sessions ADD COLUMN acr text;
