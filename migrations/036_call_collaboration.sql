ALTER TABLE media_calls ADD COLUMN mode text NOT NULL DEFAULT 'video' CHECK(mode IN('audio','video'));
ALTER TABLE media_calls ADD COLUMN caller_user_id uuid REFERENCES users;
UPDATE media_calls SET caller_user_id=host_user_id;
ALTER TABLE media_calls ALTER COLUMN caller_user_id SET NOT NULL;
ALTER TABLE media_calls ADD COLUMN ring_until timestamptz NOT NULL DEFAULT now();
ALTER TABLE media_calls ADD COLUMN end_reason text CHECK(end_reason IN('ended','cancelled','declined','missed','empty','max_duration'));
ALTER TABLE media_grants ADD COLUMN hand_raised_at timestamptz;
CREATE TABLE media_invitations (
 call_id uuid NOT NULL REFERENCES media_calls,user_id uuid NOT NULL REFERENCES users,
 response text NOT NULL CHECK(response IN('pending','accepted','declined','missed','cancelled')),
 invited_at timestamptz NOT NULL DEFAULT now(),responded_at timestamptz,
 PRIMARY KEY(call_id,user_id)
);
CREATE INDEX media_incoming_calls ON media_invitations(user_id,call_id) WHERE response='pending';
CREATE TABLE media_messages (
 id uuid PRIMARY KEY,call_id uuid NOT NULL REFERENCES media_calls,room_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users,client_id uuid NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(call_id,room_id) REFERENCES media_rooms(call_id,id),UNIQUE(call_id,user_id,client_id)
);
CREATE INDEX media_room_messages ON media_messages(room_id,created_at DESC,id DESC);
