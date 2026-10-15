ALTER TABLE meeting_series ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
