-- Migration: add replay_count and is_replaying to webhook_dead_letters

BEGIN;

ALTER TABLE webhook_dead_letters
ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN is_replaying BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
