ALTER TABLE meeting_series DROP CONSTRAINT meeting_series_frequency_check;
ALTER TABLE meeting_series ADD CONSTRAINT meeting_series_frequency_check CHECK(frequency IN ('daily','weekly','monthly','yearly'));
ALTER TABLE meeting_series ADD COLUMN month_day_policy text NOT NULL DEFAULT 'reject' CHECK(month_day_policy IN ('reject','constrain'));
