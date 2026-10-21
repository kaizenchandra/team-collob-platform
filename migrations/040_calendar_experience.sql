-- Date-only holidays and leave remain civil dates, not midnight UTC instants.
CREATE TABLE calendar_schedules (
 org_id uuid NOT NULL,user_id uuid NOT NULL,timezone text NOT NULL,days jsonb NOT NULL,
 holiday_calendar text NOT NULL DEFAULT 'Company',updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id),FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE calendar_holidays (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES organizations,calendar text NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),day date NOT NULL,
 created_by uuid NOT NULL REFERENCES users,UNIQUE(org_id,calendar,day,title)
);
CREATE INDEX calendar_holidays_range ON calendar_holidays(org_id,calendar,day);
CREATE TABLE calendar_leave (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,user_id uuid NOT NULL,
 first_day date,last_day date,starts_at timestamptz,ends_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),reviewed_by uuid REFERENCES users,
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
 CHECK ((first_day IS NOT NULL AND last_day>=first_day AND starts_at IS NULL AND ends_at IS NULL)
 OR (first_day IS NULL AND last_day IS NULL AND starts_at IS NOT NULL AND ends_at>starts_at))
);
CREATE INDEX calendar_leave_range ON calendar_leave(org_id,user_id,status,first_day,starts_at);
ALTER TABLE meetings ADD COLUMN location text NOT NULL DEFAULT '' CHECK(length(location)<=500);
ALTER TABLE meetings ADD COLUMN meeting_type text NOT NULL DEFAULT 'video' CHECK(meeting_type IN('video','audio','in_person'));
ALTER TABLE meetings ADD COLUMN team_id uuid REFERENCES teams;
CREATE TABLE calendar_media (
 meeting_id uuid PRIMARY KEY REFERENCES meetings,call_id uuid NOT NULL UNIQUE REFERENCES media_calls
);
-- Keep scheduled-call eligibility aligned with authoritative invitations, including edits to a series.
CREATE FUNCTION calendar_roster_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; conversation uuid; organization uuid;
BEGIN
 SELECT cm.call_id,x.channel_id,x.org_id INTO target,conversation,organization
 FROM calendar_media cm JOIN media_calls x ON x.id=cm.call_id WHERE cm.meeting_id=coalesce(NEW.meeting_id,OLD.meeting_id);
 IF target IS NULL THEN RETURN coalesce(NEW,OLD); END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO channel_members VALUES(organization,conversation,NEW.user_id) ON CONFLICT DO NOTHING;
  INSERT INTO media_invitations(call_id,user_id,response) VALUES(target,NEW.user_id,'accepted') ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM channel_members WHERE channel_id=conversation AND user_id=OLD.user_id;
  UPDATE media_grants SET revoked_at=now(),hand_raised_at=NULL,hand_order=NULL WHERE call_id=target AND user_id=OLD.user_id AND revoked_at IS NULL;
  UPDATE media_rooms SET provider_room=gen_random_uuid() WHERE call_id=target AND closed_at IS NULL;
 END IF;
 RETURN coalesce(NEW,OLD);
END $$;
CREATE TRIGGER calendar_roster_changed AFTER INSERT OR DELETE ON meeting_attendees FOR EACH ROW EXECUTE FUNCTION calendar_roster_changed();
CREATE FUNCTION calendar_meeting_cancelled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.cancelled AND NOT OLD.cancelled THEN
  UPDATE media_calls SET ended_at=coalesce(ended_at,now()),end_reason=coalesce(end_reason,'cancelled') WHERE id IN(SELECT call_id FROM calendar_media WHERE meeting_id=NEW.id);
  UPDATE media_grants SET revoked_at=now(),hand_raised_at=NULL,hand_order=NULL WHERE call_id IN(SELECT call_id FROM calendar_media WHERE meeting_id=NEW.id) AND revoked_at IS NULL;
  UPDATE media_rooms SET provider_room=gen_random_uuid() WHERE call_id IN(SELECT call_id FROM calendar_media WHERE meeting_id=NEW.id) AND closed_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calendar_meeting_cancelled AFTER UPDATE OF cancelled ON meetings FOR EACH ROW EXECUTE FUNCTION calendar_meeting_cancelled();
