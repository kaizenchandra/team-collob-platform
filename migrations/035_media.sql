CREATE TABLE media_calls (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, channel_id uuid NOT NULL,
  host_user_id uuid NOT NULL REFERENCES users, client_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  FOREIGN KEY(org_id,channel_id) REFERENCES channels(org_id,id),
  UNIQUE(channel_id,client_id)
);
CREATE UNIQUE INDEX media_one_active_call ON media_calls(channel_id) WHERE ended_at IS NULL;
CREATE TABLE media_rooms (
  id uuid PRIMARY KEY, call_id uuid NOT NULL REFERENCES media_calls,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), client_id uuid NOT NULL,
  provider_room uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  is_main boolean NOT NULL DEFAULT false, closed_at timestamptz,
  UNIQUE(call_id,client_id), UNIQUE(call_id,id)
);
CREATE UNIQUE INDEX media_one_main_room ON media_rooms(call_id) WHERE is_main;
CREATE TABLE media_grants (
  id uuid PRIMARY KEY, call_id uuid NOT NULL REFERENCES media_calls, room_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users, client_id uuid NOT NULL,
  session_hash text NOT NULL, recording_consent boolean NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(call_id,room_id) REFERENCES media_rooms(call_id,id)
);
CREATE UNIQUE INDEX media_active_device ON media_grants(call_id,user_id,client_id) WHERE revoked_at IS NULL;
CREATE INDEX media_current_grants ON media_grants(room_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE media_bans (call_id uuid NOT NULL REFERENCES media_calls,user_id uuid NOT NULL REFERENCES users,PRIMARY KEY(call_id,user_id));
CREATE TABLE media_recordings (
  id uuid PRIMARY KEY, call_id uuid NOT NULL REFERENCES media_calls, room_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users, client_id uuid NOT NULL,
  provider_room uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('starting','active','stopping','complete','failed','uncertain')),
  egress_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  bytes bigint, error_code text,
  FOREIGN KEY(call_id,room_id) REFERENCES media_rooms(call_id,id), UNIQUE(call_id,client_id)
);
CREATE UNIQUE INDEX media_one_recording ON media_recordings(room_id) WHERE status IN ('starting','active','stopping','uncertain');
