CREATE TABLE message_reports(
 id uuid PRIMARY KEY,
 org_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 message_id uuid NOT NULL,
 reporter_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('spam','harassment','unsafe','other')),
 details text NOT NULL DEFAULT '' CHECK(length(details)<=1000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','dismissed','removed')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_by uuid REFERENCES users,
 resolved_at timestamptz,
 resolution_note text NOT NULL DEFAULT '' CHECK(length(resolution_note)<=1000),
 UNIQUE(message_id,reporter_id),
 FOREIGN KEY(org_id,channel_id,message_id) REFERENCES messages(org_id,channel_id,id),
 FOREIGN KEY(org_id,reporter_id) REFERENCES memberships(org_id,user_id),
 CHECK((status='open' AND resolved_by IS NULL AND resolved_at IS NULL) OR (status<>'open' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX message_reports_queue ON message_reports(org_id,status,created_at DESC,id DESC);
CREATE INDEX message_reports_quota ON message_reports(channel_id,reporter_id,created_at);
