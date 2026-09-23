# Campaign cast operations

## Discovery rollout status

Automatic discovery is still under development. `CAST_DISCOVERY_ENABLED` defaults to `false`, independently of `CAST_EDITING_ENABLED`. The worker and combined runtime roles process durable discovery jobs through a capacity-one optional lane when enabled. The API-only role does not run that lane. Accepted append and replacement commits enqueue discovery atomically using preparation saved outside the commit transaction. If preparation is unavailable, the story still commits with a failed discovery job labeled `admission_unavailable`. Remaining release gates include lifecycle/coverage controls, shared provider capacity, and the total physical-attempt ceiling across preset fallback and retries. Keep the gate off until those gates are complete.

Discovery uses the saved text-provider route and its exact qualified nonstream schema, a 30-second request deadline, and source-linked validated publication. Its physical calls are recorded under operation `cast_discovery`, attributed to the source campaign and turn. Checkpointed responses survive worker interruption and are reused for publication. Disabling discovery prevents new claims and publication without disabling manual editing; it retains jobs and evidence for recovery. No relationship inference is enabled by this gate.

Phases 02–03 provide manual supporting-character APIs, history/backup integration, and the legacy Story cast editor. Automatic discovery, generation-context injection, and optional history backfill remain separate phases. The replacement UI is deferred by the current legacy-first scope. See the [implementation specification](../superpowers/plans/2026-09-22-campaign-cast.md).

## Enable and disable editing

`CAST_EDITING_ENABLED` defaults to `false` in runtime configuration, Compose, and Swarm. After applying migrations through `0103_campaign_cast_lifecycle`, an operator can set it to `true` and restart/redeploy the API through the existing [deployment procedure](deployment.md). `/api/v1/meta` exposes `capabilities.castEditing`; cast read responses also include this capability. No deployment was performed as part of implementation.

Set the flag to `false` to stop new cast mutations. Reads and Campaign/System Archive preservation remain available. Keep stored authority and the additive schema in place; do not narrow historical-provenance constraints or delete tables as a feature rollback. The SQL down section only removes the operational boundary key and intentionally retains the widened provenance constraints. Older application versions without cast-aware archive support must not be used to export these campaigns.

## API contract

The server resolves the owner. Routes under `/api/v1/campaigns/:campaignId/cast` provide GET list, POST create, GET `/:characterId`, and PATCH `/:characterId`. Lists accept `query`, a UUID `cursor`, and `limit` from 1 to 50. Request bodies are limited to 64 KiB.

Writes require `expectedCastRevision`, `expectedBoundary` (turn number and timeline revision), and an `idempotencyKey`; edits also require `expectedCharacterRevision`. Read the current response before writing. Reusing an identical request returns its original receipt, even after another edit; reusing its key with different contents returns a conflict. On a stale-revision conflict, reread and reconcile rather than blindly resubmitting an old edit.

Create accepts a name, aliases, and a sparse profile. Edit supports name/aliases, `setOverrides`, `clearOverrides`, `pinned`, and `ignored`. Setting a field to an empty string deliberately overrides any discovered value; clearing that override restores the supported discovered value, or leaves the field unknown when none exists. Names are not identity keys, so two characters can share a name. There is no public delete operation.

Detail returns observations, current overrides, identity-event evidence, and `unresolvedCandidateIds` (empty until discovery is implemented). Protagonist writes return `cast_protagonist_read_only` and the existing `editorDestination`; its profile authority stays in the existing protagonist system. Pin/ignore flags are persisted now; automatic prompt selection is a later phase.

| Response | Meaning |
| --- | --- |
| 404 `cast_not_found` | Missing or foreign resource |
| 409 `cast_revision_conflict` | Stale cast, character, or timeline boundary |
| 409 `cast_generation_active` | Queued, active, or recoverable generation prevents an authority edit |
| 409 `cast_idempotency_conflict` | Same key used with different input |
| 422 `cast_invalid_request` | Invalid contract or fiction value |
| 422 `cast_protagonist_read_only` | Use the existing protagonist editor |
| 503 `cast_editing_disabled` | Operator gate is off |

## History and portability

`GET /api/v1/campaigns/:campaignId/cast/discovery` reports the independent discovery capability, forward enrollment start, contiguous tracked-through watermark, first gap, and unresolved identity count. The first eligible accepted source records enrollment; earlier history is not implicitly tracked. Missing or failed source revisions stop the watermark even when later sources completed. Correcting a completed source withdraws its coverage until the replacement finishes; rewinding before enrollment clears it. Unresolved identity candidates do not themselves make successfully processed narration incomplete.

Migration `0107_campaign_cast_coverage` adds the enrollment start and backfills existing active discovery jobs. Enrollment and jobs are operational state excluded from archives; restored/branched/transferred authority does not imply discovery coverage. Rollback can disable discovery while retaining editing and recorded evidence. The migration's down direction drops only the enrollment column.

The legacy Characters panel displays this status and provides **Refresh characters**. Tracking-status failures leave saved characters accessible. Candidate resolution and discovery Retry controls are still pending; do not enable automatic discovery as a released feature yet. The old placeholder tracking fields were removed from the cast snapshot/list contract; consumers must read the dedicated status endpoint. No web-next UI was changed in this slice.

Rewind/undo removes cast edits and identities beyond the retained history boundary. Retained source-supported observations and explicit edits remain; discarded future edits cannot return when a new timeline reaches the same turn number. Branching remaps retained character, event, observation, and turn IDs into the destination campaign. Claims retain their speaker identities even when those identities are currently hidden.

Narration correction and accepted-turn replacement invalidate facts whose effective source revision/hash no longer matches. User overrides remain authoritative. Each boundary change advances a timeline revision so stale internal batches cannot recreate discarded state. The same transaction reconciles already-enrolled discovery sources: discarded or changed sources lose their jobs and pending candidates; changed retained narration is queued with its frozen admission. Unchanged retained sources advance to the new timeline while preserving published chunks, parsed checkpoints, retry counts, and failure status. Active leases are revoked. No new source is enrolled by this reconciliation, and disabled workers remain disabled. Branch/transfer discovery enrollment and contiguous coverage remain pending phase-04 work.

Cross-world transfer retains historical origins and effective narration corrections. Campaign imports remap IDs and bind ownership to the server-resolved destination owner. If the source world is absent from a Campaign Archive, `historical_world` stores provenance without claiming that the source entity belongs to the destination world.

Campaign Archives and System Archives embed version 1 cast authority: identities and retained events/evidence, including blanks, flags, and overrides. They omit projection caches, operational receipts, provider payloads, and leases. Import validates bounds, chronology, and references before writing, then rebuilds projections. Old archives without cast remain valid; unknown newer cast versions fail explicitly. Archive preservation does not depend on the editing gate.

## Verification and recovery

See the [phase 02 handoff](../review/campaign-cast/phase-02.md) for verification evidence and remaining gates. Cast projections are rebuilt from retained authority and revalidate source narration on reads. Accepted turns and user edits remain the recovery sources; do not repair a disagreement by rewriting the cached profile directly.
