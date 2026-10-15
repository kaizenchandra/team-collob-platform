ALTER TABLE meeting_series ADD COLUMN anchor_starts_at timestamptz, ADD COLUMN anchor_ends_at timestamptz, ADD COLUMN timezone text;
UPDATE meeting_series s SET anchor_starts_at=m.starts_at,anchor_ends_at=m.ends_at,timezone=m.timezone FROM meetings m WHERE m.series_id=s.id AND m.series_ordinal=1;
ALTER TABLE meeting_series ALTER COLUMN anchor_starts_at SET NOT NULL, ALTER COLUMN anchor_ends_at SET NOT NULL, ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE meeting_series ADD CONSTRAINT series_anchor_interval CHECK(anchor_ends_at>anchor_starts_at);
