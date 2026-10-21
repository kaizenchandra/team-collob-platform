ALTER TABLE meetings ADD COLUMN schedule_client_id uuid;
ALTER TABLE meetings ADD COLUMN schedule_request_hash text;
ALTER TABLE meetings ADD CONSTRAINT meeting_schedule_request_pair CHECK ((schedule_client_id IS NULL)=(schedule_request_hash IS NULL));
CREATE UNIQUE INDEX meeting_schedule_request ON meetings(org_id,organizer_id,schedule_client_id) WHERE schedule_client_id IS NOT NULL;
