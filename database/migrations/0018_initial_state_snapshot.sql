-- 0018: Store the initial turn-zero state snapshot so rewind can restore
-- a campaign to its creation state, before any turns were accepted.
--
-- Online migration: safe for automatic startup application.

ALTER TABLE campaign_state
  ADD COLUMN IF NOT EXISTS initial_state_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill existing campaigns whose initial snapshot has not been captured.
-- Uses the seed columns (default_triggers for trackers, event_triggers, rpg_stats)
-- as the best available reconstruction of the campaign's creation state.
UPDATE campaign_state
SET initial_state_snapshot = jsonb_build_object(
  'scratchpad', '',
  'trackers', default_triggers,
  'eventTriggers', event_triggers,
  'pendingEventTriggers', '[]'::jsonb,
  'rpgStats', rpg_stats
)
WHERE initial_state_snapshot = '{}'::jsonb;
