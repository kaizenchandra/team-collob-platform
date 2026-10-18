-- Bound foreign-key checks when removing identities from retained audit history.
CREATE INDEX audit_actor ON audit(actor_id);
