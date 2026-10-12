ALTER TABLE messages ADD COLUMN format text NOT NULL DEFAULT 'plain' CHECK (format IN ('plain','markdown-v1'));
