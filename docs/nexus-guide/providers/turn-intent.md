# Turn intent classification retirement

Turn intent classification was the former Auto-input preflight. It is retired
from active campaign creation, settings, player controls, and provider routing.

New campaigns use the existing **Turn control style**:

- **Actions only** and **Action** use the existing Action workflow.
- **Story Direction** uses the story-only workflow for newly queued jobs.

No classifier profile, endpoint request, or fallback is needed for either
workflow. Story narration continues to use the campaign's Story text provider.

## Upgrade and historical compatibility

Migration 0094 normalizes persisted flexible_auto campaign and profile defaults
to flexible_action. It does not backfill a Story-only policy into historical
jobs or accepted turns.

Historical job records retain their stored resolved input and compatibility
metadata so they can be read or recovered by compatible code. They are not
new Auto submissions and do not restart classification. A stale client that
sends Auto/classification fields is rejected as
turn_input_classification_removed; the retired historical prompt is unavailable
to new prompt reads.

Provider credentials and historical classification records were never portable
campaign authority. Do not delete retained operational audit data merely because
the active workflow is retired.
