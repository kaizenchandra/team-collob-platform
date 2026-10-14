ALTER TABLE files ADD COLUMN revision_root uuid;
ALTER TABLE files ADD COLUMN revision_number integer NOT NULL DEFAULT 1;
ALTER TABLE files ADD CONSTRAINT files_scoped_identity UNIQUE(id,org_id,channel_id);
ALTER TABLE files ADD CONSTRAINT files_revision_parent FOREIGN KEY(revision_root,org_id,channel_id) REFERENCES files(id,org_id,channel_id);
ALTER TABLE files ADD CONSTRAINT files_revision_shape CHECK((revision_root IS NULL AND revision_number=1) OR (revision_root IS NOT NULL AND revision_root<>id AND revision_number BETWEEN 2 AND 100));
CREATE UNIQUE INDEX files_revision_order ON files((coalesce(revision_root,id)),revision_number);
CREATE INDEX files_revision_root ON files(revision_root) WHERE revision_root IS NOT NULL;
