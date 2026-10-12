CREATE TABLE message_mentions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY(message_id,user_id)
);
CREATE INDEX message_mentions_recipient ON message_mentions(user_id,message_id);
