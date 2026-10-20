-- Bound retention/recovery work as historical calls and event logs grow.
CREATE INDEX media_message_retention ON media_messages(created_at);
CREATE INDEX media_change_retention ON media_changes(created_at);
CREATE INDEX media_callback_retention ON media_provider_events(created_at);
CREATE INDEX media_stream_expiry ON media_event_streams(expires_at);
CREATE INDEX media_user_live_connections ON media_grants(user_id,expires_at) WHERE revoked_at IS NULL;
CREATE INDEX media_attendance_history ON media_attendance(grant_id,joined_at);
