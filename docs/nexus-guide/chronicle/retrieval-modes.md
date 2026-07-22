# Choose a Chronicle compression mode

| Mode | Behavior |
| --- | --- |
| Automatic | Uses the least compressed selection that fits the effective budget |
| Full history | Preserves complete selected action and narration memories |
| Balanced | Preserves complete actions with bounded older narration |
| Compact | Uses action and outcome excerpts |
| Summary + recent | Uses the newest validated summary checkpoint at or before the requested turn, plus recent and relevant turns |

The Story Engine reserves room for prompt overhead and provider output before selecting memory. When the available context is tight, it sheds lower-priority derived material instead of dropping authoritative current-scene requirements.

Semantic relevance, lexical/entity matches, recency, chronology, and open-thread relevance can all influence selection. Inspect a context preview when continuity seems too compressed.

Checkpoint selection respects the same owner, campaign, and historical-turn boundaries as other Chronicle retrieval. Chronicle tries eligible checkpoints from newest to oldest. Version 2 checkpoints must match the deterministic integrity hash recomputed from the accepted turn's typed fiction continuity fields. A legacy version 1 checkpoint is used only when its sanitized summary exactly matches that turn's accepted continuity summary. If no checkpoint validates, the Story Engine uses the accepted living summary or ledger replay instead.

After a rewind or latest-turn replacement, checkpoints beyond the retained turn are invalidated and Chronicle rebuilds the derived set. A branch does not copy checkpoints; it recreates them against the branch's accepted ledger. Checkpoints improve recovery speed; they do not replace the accepted-turn ledger as authority.
