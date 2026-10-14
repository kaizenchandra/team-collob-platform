ALTER TABLE notification_settings ADD COLUMN digest_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE notification_settings ADD COLUMN digest_since timestamptz NOT NULL DEFAULT now();
ALTER TABLE notification_settings ADD COLUMN digest_checked_at timestamptz NOT NULL DEFAULT '-infinity';
CREATE TABLE digest_jobs(
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 org_id uuid NOT NULL REFERENCES organizations(id),
 bucket timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','preparing','sending','sent','cancelled','dead','uncertain')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,lease_until timestamptz,
 last_error text,accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,org_id,bucket),UNIQUE(user_id,id)
);
CREATE TABLE digest_items(
 user_id uuid NOT NULL,
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 job_id uuid NOT NULL,
 PRIMARY KEY(user_id,message_id),
 FOREIGN KEY(user_id,job_id) REFERENCES digest_jobs(user_id,id)
);
CREATE INDEX digest_pending ON digest_jobs(available_at) WHERE state IN ('queued','preparing','sending');
CREATE INDEX digest_job_items ON digest_items(job_id);
