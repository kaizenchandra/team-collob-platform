-- Physical generations fence provider-refreshed tokens after a sharing lease ends.
CREATE TABLE media_retired_rooms (
 provider_room uuid PRIMARY KEY,
 call_id uuid NOT NULL REFERENCES media_calls(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_retired_rooms_created ON media_retired_rooms(created_at);
CREATE FUNCTION media_retire_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.provider_room IS DISTINCT FROM NEW.provider_room THEN
  INSERT INTO media_retired_rooms(provider_room,call_id) VALUES(OLD.provider_room,OLD.call_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_room_retired AFTER UPDATE OF provider_room ON media_rooms
 FOR EACH ROW EXECUTE FUNCTION media_retire_generation();
CREATE FUNCTION media_share_released() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE media_rooms r SET provider_room=gen_random_uuid()
 WHERE r.id=OLD.room_id AND r.closed_at IS NULL
 AND EXISTS(SELECT 1 FROM media_calls x WHERE x.id=r.call_id AND x.ended_at IS NULL);
 RETURN OLD;
END $$;
CREATE TRIGGER media_share_released AFTER DELETE ON media_shares
 FOR EACH ROW EXECUTE FUNCTION media_share_released();
