CREATE TABLE file_scan_jobs (
  file_id uuid PRIMARY KEY REFERENCES files(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','dead','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text,
  scanned_at timestamptz,
  scanner_version text
);
CREATE INDEX file_scan_jobs_pending ON file_scan_jobs(available_at) WHERE status IN ('queued','running');
INSERT INTO file_scan_jobs(file_id) SELECT id FROM files WHERE state='quarantined';
