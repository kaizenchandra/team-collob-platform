CREATE TABLE meeting_series(
 id uuid PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES organizations(id),
 organizer_id uuid NOT NULL REFERENCES users(id),
 client_id uuid NOT NULL,
 request_hash text NOT NULL,
 frequency text NOT NULL CHECK(frequency IN ('daily','weekly')),
 interval integer NOT NULL CHECK(interval BETWEEN 1 AND 12),
 count integer NOT NULL CHECK(count BETWEEN 2 AND 52),
 repeated_time text NOT NULL CHECK(repeated_time IN ('reject','earlier','later')),
 cancelled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,organizer_id,client_id)
);
ALTER TABLE meetings ADD COLUMN series_id uuid, ADD COLUMN series_ordinal integer;
ALTER TABLE meetings ADD CONSTRAINT meetings_series_fk FOREIGN KEY(org_id,series_id) REFERENCES meeting_series(org_id,id);
ALTER TABLE meetings ADD CONSTRAINT meetings_series_ordinal CHECK((series_id IS NULL AND series_ordinal IS NULL) OR (series_id IS NOT NULL AND series_ordinal BETWEEN 1 AND 52));
CREATE UNIQUE INDEX meetings_series_occurrence ON meetings(series_id,series_ordinal) WHERE series_id IS NOT NULL;
