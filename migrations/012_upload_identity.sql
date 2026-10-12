ALTER TABLE files ADD COLUMN client_id uuid;
CREATE UNIQUE INDEX files_upload_identity ON files(channel_id,created_by,client_id) WHERE client_id IS NOT NULL;
CREATE INDEX files_storage_key ON files(storage_key);
