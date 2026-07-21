# Choose a Chronicle compression mode

| Mode | Behavior |
| --- | --- |
| Automatic | Uses the least compressed selection that fits the effective budget |
| Full history | Preserves complete selected action and narration memories |
| Balanced | Preserves complete actions with bounded older narration |
| Compact | Uses action and outcome excerpts |
| Summary + recent | Uses the newest summary checkpoint plus recent and relevant turns |

The Story Engine reserves room for prompt overhead and provider output before selecting memory. When the available context is tight, it sheds lower-priority derived material instead of dropping authoritative current-scene requirements.

Semantic relevance, lexical/entity matches, recency, chronology, and open-thread relevance can all influence selection. Inspect a context preview when continuity seems too compressed.
