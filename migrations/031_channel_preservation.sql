CREATE TABLE channel_preservation (
  channel_id uuid PRIMARY KEY REFERENCES channels(id),
  active boolean NOT NULL,
  reason text NOT NULL CHECK(length(reason)<=500 AND (NOT active OR length(trim(reason))>0)),
  revision integer NOT NULL CHECK(revision>0)
);
