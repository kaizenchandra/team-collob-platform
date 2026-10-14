ALTER TABLE files ADD COLUMN storage_backend text NOT NULL DEFAULT 'local' CHECK(storage_backend IN ('local','s3'));
ALTER TABLE files ADD COLUMN object_key text;
ALTER TABLE files ADD COLUMN object_bucket text;
ALTER TABLE files ADD CONSTRAINT files_object_pointer CHECK((storage_backend='local' AND object_key IS NULL AND object_bucket IS NULL) OR (storage_backend='s3' AND object_key IS NOT NULL AND object_bucket IS NOT NULL));
