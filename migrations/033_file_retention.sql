CREATE TABLE channel_file_retention (
  channel_id uuid PRIMARY KEY REFERENCES channels(id),
  days integer CHECK(days BETWEEN 1 AND 3650),
  revision integer NOT NULL CHECK(revision>0)
);
CREATE INDEX files_retention_roots ON files(channel_id,created_at,id) WHERE revision_root IS NULL AND state<>'deleted';
