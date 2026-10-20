CREATE INDEX messages_direct_replies_page ON messages(channel_id,parent_id,created_at DESC,id DESC) WHERE NOT deleted AND parent_id IS NOT NULL;
