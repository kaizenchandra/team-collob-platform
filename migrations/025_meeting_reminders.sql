CREATE TABLE meeting_reminders(
 meeting_id uuid NOT NULL,
 user_id uuid NOT NULL,
 minutes integer NOT NULL CHECK(minutes IN (5,15,30,60)),
 dismissed_start timestamptz,
 PRIMARY KEY(meeting_id,user_id),
 FOREIGN KEY(meeting_id,user_id) REFERENCES meeting_attendees(meeting_id,user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_reminders_user ON meeting_reminders(user_id,meeting_id);
