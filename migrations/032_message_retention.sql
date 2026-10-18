CREATE TABLE channel_message_retention (
  channel_id uuid PRIMARY KEY REFERENCES channels(id),
  days integer CHECK(days BETWEEN 1 AND 3650),
  revision integer NOT NULL CHECK(revision>0)
);
CREATE INDEX messages_retention_age ON messages(channel_id,created_at,id) WHERE NOT deleted;
