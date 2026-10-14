CREATE TABLE calendar_versions(
 org_id uuid NOT NULL,
 user_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(org_id,user_id),
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id) ON DELETE CASCADE
);
