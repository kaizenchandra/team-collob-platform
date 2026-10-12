ALTER TABLE messages ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE message_attachments (
  message_id uuid NOT NULL REFERENCES messages(id),
  file_id uuid NOT NULL REFERENCES files(id),
  PRIMARY KEY(message_id,file_id)
);
CREATE INDEX message_attachments_file ON message_attachments(file_id);
