ALTER TABLE files ADD COLUMN lifecycle_revision integer NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0);
CREATE INDEX files_deleted_uploader ON files(channel_id,created_by,created_at DESC,id DESC) WHERE state='deleted';
