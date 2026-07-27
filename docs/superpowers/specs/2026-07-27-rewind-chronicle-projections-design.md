# Rewind Chronicle Projection Rebuild

## Goal

Allow Turn Undo Latest and reset-to-earlier-turn operations to complete when a retained turn has both accepted-turn and state-edit Chronicle projections.

## Problem

`rebuildCampaignMemories` removes only accepted-turn-generated campaign summaries, canonical facts, and open threads. It retains state-edit projections, then replays accepted turns and attempts to create a canonical-fact memory with the same `(campaign_id, turn_id, memory_kind)` key. PostgreSQL correctly rejects the duplicate.

## Design

A rewind retains turns 1 through the selected target and deletes later accepted turns. Its Chronicle rebuild will:

1. Delete all derived `campaign_summary`, `canonical_fact`, and `open_thread` Chronicle memories for the campaign.
2. Rebuild projections from every retained accepted turn in chronological order.
3. Reapply surviving campaign state edits in chronological/revision order.

The turn ledger and state-edit ledger remain authoritative. The rebuild touches only derived Chronicle indexes; it does not regenerate narration or model output.

## Rejected Alternative

Incrementally deleting only discarded-turn projections would need to reverse fact supersession, summary replacement, open-thread changes, and later state corrections. Replaying the retained authoritative ledger is deterministic and avoids stale derived state.

## Validation

Add an integration regression test that creates a state edit, rewinds to a retained turn, and verifies the rebuild completes with a single canonical-fact memory for the affected turn. Existing rewind and Chronicle tests must remain green.
