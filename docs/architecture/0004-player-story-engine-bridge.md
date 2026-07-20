# ADR 0004: The legacy player uses a resumable Story Engine bridge

Status: accepted

## Context

The player-facing `index.html` retains mature world setup, story display, choices, saves, and direct-provider workflows. Replacing all of that UI at once would delay the memory goal, but letting the browser continue to own main story generation leaves accepted history vulnerable to reloads, model changes, and provider failures.

Browser-side RPG assessment and event triggers are not yet represented by typed backend jobs. Sending their raw records through a generic bridge would risk contaminating narration and Chronicle memory with rolls or other mechanics.

## Decision

Add an opt-in bridge in Model Settings. On the first eligible story turn, the browser imports its sanitized portable state through the legacy importer and records only the returned campaign ID, synchronized turn count, and pending generation linkage. Subsequent turns use the durable generation API.

Before submission, the browser persists a UUID idempotency key, action, expected local turn count, provider profile, and selected model. After submission it also persists the job ID. Reloading the page resumes that same job or repeats the same idempotent enqueue when the response was lost before the job ID was saved. A completed result is read from the accepted `turns` row through a dedicated result endpoint; rejected or partial model output is never returned as story content.

The bridge checks the authoritative campaign turn count before each new turn. Matching histories reconnect directly. A single additional database turn is accepted only when it corresponds to the browser's recorded pending job. When a player acts from an earlier accepted turn, the default operation transactionally rewinds the same campaign, deletes later turn-owned artifacts, restores the selected state snapshot, invalidates response chains, and rebuilds derived Chronicle memory from the remaining ledger. The player may instead explicitly create a separate campaign branch; that import reuses the source campaign's immutable world version and records branch provenance, so it does not duplicate the world. Unexpected divergence also reuses the last known immutable world version when a replacement campaign snapshot is necessary.

The initial bridge blocked backend mode when browser-side RPG rolls or event triggers were enabled. ADR 0005 replaces that temporary restriction with typed, worker-owned orchestration.

## Consequences

- The existing player experience can use database-authoritative memory without a wholesale UI rewrite.
- Refreshing or closing the browser does not create a second turn or lose an accepted backend result.
- Switching models affects the next generation provider but never removes the campaign snapshot and retrieved Chronicle context.
- Linkage-only browser settings do not affect importer content hashes, so reconnecting the same story remains idempotent.
- Rewinding is destructive to later turns and therefore requires an explicit player choice; creating a separate campaign remains the non-destructive alternative.
- The bridge remains responsible for browser/database synchronization, while ADR 0005 defines the mechanics and event boundary used by every backend turn.
