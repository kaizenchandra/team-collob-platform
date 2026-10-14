ALTER TABLE notification_settings
 ADD COLUMN browser_replies_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN replies_enabled_at timestamptz NOT NULL DEFAULT now();
