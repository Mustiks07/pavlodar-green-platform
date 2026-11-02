ALTER TABLE chat_messages
ADD COLUMN entity_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
