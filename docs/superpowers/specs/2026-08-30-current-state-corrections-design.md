# Current-only campaign state corrections

Date: 2026-08-30

Status: Implemented in the isolated worktree following the user's authorization. See the companion plan for delivery and verification status.

Companion: [Implementation plan](../plans/2026-08-30-current-state-corrections.md).

## Purpose and scope

Let the user correct Continuity Summary, Private Scratchpad, Open Threads, and Canonical Facts in the campaign's current state. Make those corrections authoritative for the next generated turn without rewriting accepted turns or allowing edits to earlier states.

Deliver the same capability in:

1. Legacy Story Player at /story/:campaignId.
2. New Story Player at /app/story/:campaignId; verify the exact route through storyPlayerPath when implementing.
3. New campaign editor at /app/campaigns/:campaignId/state.

The legacy source is apps/web/src/story.js and apps/web/public/story.html. The repository-root legacy index.html is not an implementation target.

This specification governs this work where the July editable-state specifications differ: no historical correction targets, no automatic latest-turn regeneration, and no full Chronicle rebuild on ordinary saves. Existing narration correction, explicit rewind, branch, and replacement operations remain separate.

## Behavioral contract

- After accepted turn N, a save creates an append-only correction effective at N.
- The original accepted row and private snapshot for N, and all earlier turns, remain byte-for-byte unchanged.
- The corrected current state is input to append generation N+1.
- Accepting N+1 establishes a new current snapshot. The edit at N remains audit/replay history; it is not a permanent overlay over every later summary, scratchpad, or thread list.
- Active canonical facts retain their validity until explicitly superseded or retired.
- Browsing history never changes the editor's target. Historical state inspection is read-only. A clearly labeled Edit current state action may open current state while the reader is on an earlier turn.
- A save does not regenerate narration, choices, mechanics, illustrations, or an accepted turn.
- Existing explicit replacement generation retains its historical base cutoff. A correction at N must not leak into a replacement whose base is N-1 merely because N is currently active.
- A successful save is atomic. Rejected, stale, unsafe, or incomplete requests change no authority, projections, chains, or jobs.
- A no-op creates no revision, correction, index job, or model-chain invalidation.

Turn zero is current state before the first accepted turn and is editable only while the campaign is still at turn zero.

Historical correction rows already present in a database or imported archive remain readable and preserved. This feature prevents new historical writes; it does not erase old audit history or rewrite archives.

## User experience

Use the same visible field names in all three surfaces:

- Continuity summary: multiline text.
- Private scratchpad: multiline fiction-only private continuity text.
- Open threads: independent multiline rows with Add thread and Remove thread.
- Canonical facts: independent multiline rows with Add fact and Remove fact.

IDs are application-managed row metadata, never an editable text field. Existing facts preserve their IDs on an unchanged save; newly added facts have null IDs until the server returns their assigned IDs. Each row represents one independently correctable fact, not necessarily one sentence.

Keep existing tracker functionality outside the four-field continuity component. Preserve mechanics, triggers, and other state values through the existing complete update contract; this work does not expand mechanics editing.

Display:

> Current state after turn N. Saved corrections apply to future turns. Accepted turns remain unchanged.

After saving, use:

> Current state saved. Future turns use these corrections. Chronicle search updates in the background when enabled.

Do not claim an index is complete from the save response. Existing Chronicle health/progress surfaces remain the detailed status source.

Editing uses a captured campaign ID, active turn, revision, and full base snapshot. Background sync, polling, rerendering, or a late response from another campaign must not overwrite a dirty draft. A 409 preserves the draft and requires the user to reload the newer base before saving again; do not silently refresh the revision and retry stale content.

Save is disabled while loading, saving, or known active/recoverable generation prevents edits. The server remains authoritative against races. Cancel and Escape respect the application's unsaved-change guard; labels, focus, keyboard access, and mobile layouts must work.

## API and authority

Reuse GET/PATCH /api/v1/campaigns/:campaignId/state and the complete CampaignRuntimeStateUpdate shape. Keep effectiveTurnNumber optional for compatible current-state clients; when supplied it must equal the locked current active turn. Omission means the locked current active turn, subject to expectedTurnNumber and expectedRevision.

Use the existing 409 active_turn_changed failure for a target different from current, and the existing state_revision_changed failure for stale revisions. Preserve owner resolution, active-job exclusion, typed limits, and fiction-boundary validation.

Persist the correction in campaign_state_edits and materialize scratchpad/trackers as today. Use a focused transactional Chronicle correction method instead of rebuildCampaignMemories. The method reads the just-persisted edit in the same owner/campaign/world-version scope and uses the same transaction client.

The save transaction must:

1. Lock and validate current campaign/state.
2. Validate and reconcile the complete request and stable fact identities.
3. Detect no-op before mutations.
4. Write the correction and current materialized state.
5. Reconcile only affected structured facts and Chronicle parent records.
6. Invalidate model chains for a real state change.
7. Durably enqueue eligible derived indexing work when memory text changed.
8. Record content-free change metadata and commit.

No embedding-provider network call belongs in this transaction. A disabled or unavailable provider does not prevent correction saves or future text generation. A failure to durably record required database work rolls back the transaction; it is not silently swallowed as a successful, permanently unindexed save.

## Chronicle update policy

| Change | Synchronous work | Background work |
| --- | --- | --- |
| Scratchpad only | Store private correction; invalidate model chain | None |
| Summary | Replace/remove affected summary projection | Embed changed summary chunks |
| Threads | Replace/remove affected thread-list projection | Embed changed list chunks |
| Add/change facts | Reconcile fact identities/validity and affected fact groups | Embed new/changed group chunks |
| Remove facts | Retire affected facts; remove stale retrieval eligibility immediately | Embed remaining content only if a group changed |
| Unchanged accepted fiction | None | None |
| No-op | None | None |

Keep existing grouped canonical-fact memories for this iteration. Individual fact records enable reliable editing and retirement; they do not require one vector per fact. If a group changes, re-embedding that affected group is acceptable. Do not promise token-level or sentence-level vector patching.

Preserve IDs, content hashes, vectors, timestamps, and chunks for unchanged memory parents. Match existing legacy parents before assigning new projection metadata. No blanket delete of campaign turn_fiction, summaries, facts, threads, or summary checkpoints is allowed on a correction save.

Remove obsolete text from current lexical and semantic eligibility immediately, including deleted content while the worker is unavailable. A stale worker cannot commit against an obsolete parent hash, job work version, or provider fingerprint. Reuse the existing job tables, leases, cursor signatures, and content-hash checks.

Queue both supported indexing paths when appropriate: legacy parent embeddings and chunk embeddings. Disabled semantic retrieval requires no embedding calls; shadow chunking may run without vectors. Query-vector caches remain reusable for unchanged query/provider keys; they are not cached retrieved answers. Any cache of result sets or context must include the effective state revision.

A full rebuild remains a maintenance/import/recovery operation. It must replay turn-zero edits, then each accepted turn followed by applicable edits at that turn in revision order. Applying every edit after every turn is incorrect. Explicit rebuilds may recreate derived data; ordinary correction saves may not.

## Prompt authority and privacy

Add a typed optional currentContinuity block to prompt context for a correction effective at the generation's exact base turn. It contains only the four fiction-only fields, with stable fact IDs as needed by structured fact supersession. Load it directly from persisted authority, not by searching Chronicle.

Explicit empty strings and empty lists are meaningful replacements. An empty thread list must not fall back to an older open-thread memory. Filter duplicate/stale summary, thread, and canonical projections while this complete current correction is active.

The prompt states that corrected current continuity takes precedence over conflicting historical narration or provider conversation memory, while mandatory world rules still apply. Accepted historical prose remains historical evidence; do not claim all semantic contradictions can be mechanically erased.

Treat this block as fixed input for budget accounting. Remove optional retrieved history first. If the complete active correction cannot fit the configured provider input budget, return the existing context_budget_exceeded failure; never silently drop a correction to produce a misleading successful generation. Keep the saved correction intact and make the size problem actionable.

Scratchpad stays private, fiction-only, and excluded from Chronicle memory rows, chunk text, embedding calls, illustrations, public streaming, and routine logs. It may enter the private text-generation prompt after validation.

Bump the story prompt protocol for these semantics. Existing saved prompt customizations must remain preserved; enforce the correction rule in the generated user envelope too, so a customized system prompt does not accidentally omit it.

## Replay and portability

Use the same fact reconciliation rules for live saves and replay. Rebuild at N+1 must reproduce the live state at N+1, not restore the older correction at N. Repeated corrections at the same turn remain ordered revisions.

Branch, rewind, campaign transfer, portable campaign import/export, and System Archive import/export must preserve correction meaning and ownership. Remap fact IDs and their references consistently when the destination assigns new turn/edit/campaign IDs. Source histories and exports are not changed in place. Do not store a parallel canonical-state source in a cache.

Existing correction snapshots, fact-source metadata, validity columns, parent metadata, and job tables suffice without new fields or an archive version change. Integration testing found that the canonical-fact checks rejected manual corrections at turn zero. Additive migration `0082_turn_zero_state_correction_facts.sql` permits zero only for manual state-edit facts while retaining negative-value and accepted-turn protections. It requires no data backfill or change to archive classification; do not rewrite applied migrations or clamp zero to a later turn.

## Acceptance evidence

- All three interfaces can save all four fields without raw JSON and preserve stable fact IDs.
- Server rejects historical targets even when sent by a custom client.
- Historical inspector remains read-only; original accepted rows are unchanged.
- Concurrency, owner isolation, fiction validation, no-op, and transaction rollback are exercised.
- A captured next-turn provider request contains the saved correction, including deliberate empty fields, before embedding completion and during provider outage.
- A scratchpad-only change queues zero memory work.
- A single fact/group change leaves unrelated parent rows, vectors, and chunks unchanged.
- Stale indexing cannot resurrect retired text.
- Corrected state survives next acceptance, replay, branch, rewind, and export/import without changing source history.
- Browser tests and screenshots cover desktop/mobile legacy Story, new Story, and new Campaign State.
- Real PostgreSQL, mocked-provider, and rendered-browser evidence are reported separately from source and unit checks.
