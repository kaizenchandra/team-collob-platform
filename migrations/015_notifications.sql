CREATE TABLE notification_settings(
 user_id uuid PRIMARY KEY REFERENCES users(id),
 browser_enabled boolean NOT NULL DEFAULT false,
 enabled_at timestamptz NOT NULL DEFAULT now(),
 quiet_enabled boolean NOT NULL DEFAULT false,
 quiet_start text NOT NULL DEFAULT '22:00' CHECK(quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 quiet_end text NOT NULL DEFAULT '08:00' CHECK(quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
CREATE TABLE notification_claims(
 user_id uuid NOT NULL REFERENCES users(id),
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 claimed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,message_id)
);
