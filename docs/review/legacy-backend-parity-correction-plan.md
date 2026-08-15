# Legacy Backend Parity Correction Plan

> Status: proposed implementation plan; no production change is authorized by this document alone.
>
> Source findings: `docs/review/code-review-report.md` (`REV-001` through `REV-007`).
>
> Reviewed baseline: `main` at `58822cbed706220b98ea60112a87ab898e34b9d9`, including the documented dirty working-tree state.

## 1. Objective

Correct every issue identified by the 2026-08-13 legacy-parity review while preserving these non-negotiable invariants:

- accepted turns remain an immutable recovery ledger;
- corrections are append-only, auditable projections rather than destructive rewrites;
- world-version and campaign ownership remain server-resolved and owner-scoped;
- private mechanics never enter narration, Chronicle fiction, or illustration prompts;
- imports are idempotent and either commit completely or roll back;
- text and image providers and credentials remain independent;
- both the active legacy UI and replacement UI consume the same backend contracts.

This plan does not restore direct browser-held provider credentials or direct browser-to-provider requests. Server mediation is the approved equivalent.

## 2. Planning Decisions and Approval Gates

### Decisions incorporated into the plan

1. **Legacy import normalization becomes one deep module.** Its small interface accepts a validated legacy story plus destination/character options and returns the complete normalized world, campaign, state, turn, Chronicle, and warning projection. Preview, commit, tests, and future format migrations use this same behavior.
2. **Accepted narration remains immutable.** Durable narration editing uses an append-only correction ledger. All read paths consume one effective-narration projection.
3. **Historical state corrections are snapshot-local.** Editing turn 10 changes the effective state displayed at turn 10 only; it does not rewrite accepted turns 11 onward or current campaign state. This matches the historical client behavior.
4. **Legacy memory controls are translated, not emulated.** Supported equivalents are mapped to authoritative columns/settings. Unsupported browser-era modes produce explicit preview/import warnings instead of being silently accepted.
5. **Illustrations are not automatically destroyed or regenerated after a narration correction.** They remain attached, are marked potentially stale in the response, and may be explicitly rebuilt.

### Gate A — Existing-world character mapping

Approve before Slice 2 implementation:

- `preserve_source` creates a campaign-owned snapshot/profile from the source character even when the target world roster has no matching ID.
- `map_to_target` requires a selected character that exists in the target world version and seeds the campaign from that target character.
- Creating a new world always selects and snapshots the deterministic converted source character.

Recommended approval: adopt these semantics; they match the existing request contract and avoid implicit character substitution.

### Gate B — Accepted narration correction policy

Approve before Slice 4 implementation:

- original `turns.narration` is never updated;
- correction rows are append-only and revisioned;
- correction affects Story Player reads, exports, Chronicle rebuilds, future prompt context, search, and later illustration rebuilds;
- original and correction history remain exportable in Campaign Archive;
- existing illustration assets remain intact until the user explicitly rebuilds them.

Recommended approval: adopt this correction-overlay policy.

### Gate C — Share-link exposure

Approve before Slice 6B implementation:

- world share links are revocable, expiring bearer tokens backed by the server;
- only published world versions are shareable;
- tokens are stored hashed and reveal no owner or world identifiers;
- the feature is disabled by default until the trusted-network/authentication policy is accepted;
- the read endpoint returns portable world data only—never campaigns, providers, credentials, or private assets.

Recommended approval: implement the backend capability behind a default-off configuration flag. Continue supporting file and clipboard transfer regardless.

## 3. Delivery Strategy

Use strict RED → GREEN → REFACTOR evidence for every behavior change:

1. Add a failing contract/integration test that demonstrates the reviewed defect.
2. Make the smallest production change at the selected module interface.
3. Run the focused tests and record the passing evidence.
4. Refactor only after GREEN, keeping the external interface stable.
5. Run the full relevant matrix before moving to the next slice.

Keep the slices independently reviewable. Database migrations, import fidelity, narration correction, historical state, and sharing should remain separate commits. Do not mix existing dirty working-tree changes into these commits.

## 4. Slice 0 — Freeze the Parity Contract

### Purpose

Turn the recovered matrix into executable expectations before changing production code. This starts `REV-007` and prevents the fixes from becoming a collection of unconnected patches.

### Work

1. Add sanitized fixtures representing legacy format versions 1, 2, and 3, including:
   - source character identity/profile/text;
   - world trigger suppression;
   - RPG enablement and statistics;
   - before/after event triggers;
   - fallback-only `scratchpadSnapshot`/`trackersSnapshot`;
   - structured `worldStateSnapshot`;
   - roll and model metadata;
   - input mode and source;
   - current scratchpad/trackers/pending events;
   - `fullHistory` and compressed-through turn;
   - story length and browser-era memory settings;
   - inline, external, and absent images.
2. Create a data-driven parity matrix test that asserts import preview, commit, historical reads, next-generation context, export, and reimport outcomes.
3. Add negative fixtures for malformed private state, mechanic leakage in legacy summary text, unknown character mapping, oversize values, and duplicate replay.
4. Record which historical capabilities are exact, transformed, or intentionally retired.

### Likely files

- `tests/fixtures/legacy-story*.json`
- `tests/unit/legacy-import.test.ts`
- `tests/integration/task-14e3f-production-composed-parity.integration.test.ts`
- new `tests/integration/legacy-backend-parity.integration.test.ts`
- `docs/ui/FEATURE_IMPLEMENTATION_MATRIX.md`

### RED evidence

At minimum, tests must initially demonstrate:

- imported campaign character fields are null;
- fallback snapshots are absent from historical state;
- story length remains `standard` when the source requests another supported profile;
- legacy summary is absent from current context;
- response editing disappears after reload.

### Exit criteria

- Every `REV-*` finding has at least one failing or explicitly decision-blocked test row.
- Fixtures contain no private user content or credentials.
- PostgreSQL tests prove owner and campaign isolation.

## 5. Slice 1 — Introduce the Legacy Import Normalization Module

### Purpose

Create one in-process module with enough depth to hide legacy-format precedence, defaulting, sanitization, and destination mapping from preview and persistence callers.

### Proposed interface

```ts
normalizeLegacyCampaign(input: {
  story: LegacyStory;
  destination: LegacyImportDestination;
  selectedCharacterId?: string;
  characterStrategy?: "preserve_source" | "map_to_target";
}): NormalizedLegacyCampaign
```

`NormalizedLegacyCampaign` should expose only durable concepts:

- `worldContent` or target-world reference;
- `campaignSeed` including title, selected character, snapshot/profile, story length, turn-control style, and translated settings;
- `initialState` and `currentState`;
- ordered normalized turns;
- sanitized Chronicle seed;
- provenance and user-visible warnings.

Do not expose parsing helpers through the interface. They are internal implementation details and are tested through the normalization interface.

### Normalization rules

1. Preserve source turn numbers only when strictly increasing and valid; otherwise use stable ordinal numbering and issue a warning.
2. Construct each private turn snapshot using historical precedence:
   - validated fields from `worldStateSnapshot`;
   - `scratchpadSnapshot` fallback when snapshot scratchpad is absent;
   - `trackersSnapshot` fallback when snapshot trackers are absent;
   - normalized RPG/event/pending-event values when present.
3. Preserve validated `roll` in `mechanics_private`, `llmModelInfo` in model metadata, input mode/source, source turn ID, accepted timestamp, choices, action, custom suggestion, image prompt, and safe image reference.
4. Map current settings:
   - `settings.storyLength` → `campaigns.story_length_profile`;
   - `settings.turnControlStyle` → authoritative turn-control style;
   - legacy `useRpgStats` → `legacy_settings.useRpgStats`;
   - `world.suppressTriggers` or compatible alias → `legacy_settings.suppressEventTriggers`;
   - provider credentials and caller-supplied identity are stripped.
5. Convert `fullHistory` with the existing legacy-summary formatter, sanitize fiction, reject mechanic leakage, and seed `continuitySummary` at `fullHistoryCompressedThroughTurn` without treating the summary as canonical source data.
6. Unsupported `memoryManagementMode`, history compression mode, or exact token-limit behavior is retained only as provenance and returned as an explicit warning describing Chronicle's replacement behavior.

### Likely files

- new `packages/domain/src/legacy-campaign-normalization.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/legacy-story-world.ts`
- `packages/contracts/src/imports.ts`
- `packages/application/src/imports/private-portable-composition.ts`
- `services/runtime/src/portable-import-export-composition.ts`
- `tests/unit/legacy-import.test.ts`

### Tests

- Table-driven pure normalization tests for all precedence/default rules.
- Idempotency: normalizing the same input/options produces the same IDs and payload.
- Limits and mechanic-leakage tests.
- Character-strategy tests for create-world and existing-world destinations.

### Exit criteria

- Preview and commit no longer contain independent legacy interpretation rules.
- The normalized payload is part of the canonical import authority/fingerprint.
- Unknown or ignored settings appear in preview warnings.

## 6. Slice 2 — Persist Complete Legacy Campaign Authority

### Purpose

Fix `REV-001`, `REV-002`, and the import-side portion of `REV-004` by committing the normalized representation atomically.

### Work

1. Pass the normalized campaign seed through the portable authority and target plan.
2. Populate imported campaign fields exactly as normal campaign creation does:
   - `selected_character_id`;
   - `character_snapshot`;
   - `character_profile` and revision;
   - `story_length_profile`;
   - `turn_control_style`;
   - translated safe legacy settings.
3. Persist the complete normalized private turn snapshot and metadata rather than only `worldStateSnapshot`.
4. Seed `campaign_state.initial_state_snapshot`, current state, and revision consistently.
5. Seed the sanitized imported continuity summary into the latest applicable state snapshot so ordinary Chronicle rebuild reproduces it.
6. Keep import publication, assets, turn creation, Chronicle seed, and import completion in the existing transaction.
7. Return truthful statistics: `importedSummary`, warning count, and preserved turn-state count.

### Likely files

- `packages/database/src/portable-import-family-repository.ts`
- `packages/application/src/imports/private-portable-repository.ts`
- `packages/application/src/imports/http-compatibility.ts`
- `services/runtime/src/portable-import-export-composition.ts`
- `tests/integration/legacy-backend-parity.integration.test.ts`
- `tests/integration/import-memory.integration.test.ts`
- `tests/integration/campaign-state-corrections.integration.test.ts`
- `tests/integration/task-14e3d-portable-composition.integration.test.ts`
- `tests/integration/task-14e3f-production-composed-parity.integration.test.ts`

### Required assertions

- A create-world import binds the converted playable character to the campaign.
- `preserve_source` and `map_to_target` behave according to Gate A.
- Generation context contains the selected character but does not expose all world roster characters as the player.
- Historical state reads preserve fallback and structured snapshots.
- Private scratchpad, roll details, and mechanics never enter Chronicle fiction.
- Replaying the same import remains idempotent.
- A failure after any insert leaves no partial world/campaign/asset/import state.

### Exit criteria

- `REV-001` and `REV-002` are GREEN in PostgreSQL integration tests.
- Importing every supported fixture and immediately generating the next turn preserves character and state authority.

## 7. Slice 3 — Support Snapshot-Local Historical State Corrections

### Purpose

Resolve `REV-005` using the existing `campaign_state_edits.effective_turn_number` ledger without changing later accepted state.

### Contract change

Extend the state-correction request with an explicit `effectiveTurnNumber`. Keep `expectedTurnNumber` as the active campaign concurrency fence and `expectedRevision` as the state-ledger fence.

### Repository behavior

1. Lock current campaign/state and reject active generation work as today.
2. Validate `0 <= effectiveTurnNumber <= activeTurnNumber`.
3. Load the accepted/initial snapshot and active canonical facts at the requested turn.
4. Insert a new `campaign_state_edits` revision at that exact turn.
5. If correcting the current turn, update materialized `campaign_state`, rebuild Chronicle, and invalidate model chains as today.
6. If correcting a historical turn, increment the global state revision and append the edit, but do not alter current materialized state, later turn snapshots, Chronicle used for the current campaign, or model chains.
7. Emit an activity event containing target turn, previous/new revision, and changed fields.

### UI behavior

- Historical state editor becomes editable with a clear banner: “Changes apply only to this saved turn. Later turns and current state remain unchanged.”
- Save sends the viewed turn as `effectiveTurnNumber` and refreshes that turn from the server.
- Current-state behavior remains unchanged.

### Likely files

- `packages/contracts/src/generation.ts`
- `packages/contracts/src/client-api.ts`
- `packages/application/src/world-campaign/types.ts`
- `packages/application/src/world-campaign/ports.ts`
- `packages/database/src/campaign-state-repository.ts`
- `apps/web/src/story-state-editor.js`
- `apps/web/src/story.js`
- replacement UI campaign/state page when present
- `tests/unit/story-state-editor.test.ts`
- `tests/integration/campaign-state-corrections.integration.test.ts`
- `tests/integration/campaign-authority-repository.integration.test.ts`

### Exit criteria

- Editing turn 10 changes reads of turn 10 only.
- Turns 11 onward, current prompt context, active state, and accepted ledger remain byte-for-byte unchanged.
- Stale revision, invalid turn, cross-owner, and active-generation requests fail without writes.
- Campaign Archive round-trips the historical correction ledger.

## 8. Slice 4 — Add Durable Accepted-Narration Corrections

### Purpose

Resolve `REV-003` without violating append-only accepted-turn storage.

### Migration

Add the next ordered migration, expected to be `0070_turn_narration_corrections.sql`, with an owner-scoped table containing:

- correction ID;
- owner, campaign, and turn IDs with composite foreign-key protection;
- monotonically increasing per-turn revision;
- corrected narration;
- previous effective narration hash;
- reason/source metadata;
- creator and timestamp;
- uniqueness and lookup indexes.

Do not update `turns.narration`.

### Deep module and interface

Introduce one accepted-turn correction module whose interface supports:

```ts
correctNarration(scope, {
  turnId,
  narration,
  expectedCorrectionRevision,
  expectedActiveTurnNumber
}): AcceptedTurnCorrectionView
```

Its PostgreSQL adapter must perform one transaction that:

1. validates owner/campaign/turn scope and narration fiction safety;
2. rejects correction while conflicting generation work is active;
3. compares the correction revision/hash;
4. appends the correction;
5. rebuilds derived Chronicle memories from effective narration;
6. invalidates campaign model chains;
7. emits an activity event;
8. returns whether existing illustrations may be stale.

### One effective-narration projection

All consumers must resolve the latest correction consistently:

- turn list and sync status;
- generation context and Chronicle rebuild;
- Markdown, HTML, and Campaign Archive exports;
- search/context preview;
- illustration rebuild/backfill inputs;
- active legacy UI and replacement UI.

Use one database/query helper or view rather than copying `COALESCE(latest correction, turns.narration)` independently into each caller.

### API and UI

- Add an owner-scoped correction route under the campaign/turn resource.
- Return correction revision, original/effective narration metadata, and illustration-staleness status.
- Replace the local-only Story Player mutation with this route.
- On success, reload the authoritative turn and display “Saved.”
- On conflict, preserve the editor text and offer reload/compare; never report success.
- Add equivalent correction support to the replacement UI before cutover.

### Likely files

- new `database/migrations/0070_turn_narration_corrections.sql`
- `packages/contracts/src/client-api.ts` and/or a focused turn-correction contract file
- `packages/application/src/world-campaign/ports.ts`
- `packages/application/src/world-campaign/use-cases.ts`
- new `packages/database/src/turn-correction-repository.ts`
- a shared effective-turn projection helper under `packages/database/src`
- `packages/database/src/chronicle-repository.ts`
- `packages/database/src/campaign-archive-export-repository.ts`
- `services/api/src/server.ts`
- `apps/web/src/story.js`
- `packages/client-web/src/api-client.ts`
- replacement UI story/campaign page
- new unit and integration correction tests

### Required tests

- base narration remains unchanged after correction;
- effective reads, exports, Chronicle, context preview, and next generation use the correction;
- correction history survives Campaign Archive export/import;
- cross-owner, cross-campaign, stale revision, mechanic leakage, oversize input, and active-job attempts fail closed;
- correction does not delete or silently regenerate illustrations;
- rebuilding an illustration uses corrected narration;
- concurrent corrections produce one winner and one conflict.

### Rollback

- Code rollback may stop creating/reading new corrections only after confirming no correction rows exist or providing a compatibility read path.
- Migration rollback must not discard correction history. Prefer forward disablement over table deletion.

### Exit criteria

- Refresh, a second browser, export, Chronicle preview, and subsequent generation all show the same effective narration.
- The original accepted ledger remains recoverable and auditable.

## 9. Slice 5 — Make Legacy Summary and Settings Behavior Explicit

### Purpose

Finish `REV-004` and eliminate configuration-accepted-but-ignored behavior discovered during parity planning.

### Work

1. Surface normalized import warnings in both management UIs before commit.
2. Report exact translations:
   - story length mapped;
   - RPG/event suppression mapped;
   - Chronicle replaces legacy browser memory mode;
   - provider context window replaces legacy history token-limit behavior.
3. Preserve unsupported source settings in provenance only, stripped of secrets.
4. Make `importedSummary` truthful and show through-turn coverage.
5. Ensure Chronicle reindex retains/reconstructs the imported continuity summary from normalized state rather than deleting it permanently.
6. Update import/export documentation and user-facing copy.

### Likely files

- import response contracts and compatibility mapper
- `apps/web/public/nexus.js`
- replacement UI import flow
- `packages/database/src/chronicle-repository.ts`
- `tests/integration/import-memory.integration.test.ts`
- `tests/unit/management-ui.test.ts`
- `docs/ui/API_UI_CONTRACTS.md`

### Exit criteria

- No recognized legacy setting is silently ignored.
- Reindex produces the same sanitized continuity summary and never imports mechanic/private text into fiction memory.
- Both UIs show the same warnings and translation result.

## 10. Slice 6A — Restore Standalone Readable HTML Export

### Purpose

Resolve the HTML portion of `REV-006` with a complete, sanitized export rather than relying on the currently loaded browser page of turns.

### Work

1. Add a readable-export application module that streams or paginates every effective turn in order.
2. Support `html` and `markdown` renderers behind one small interface.
3. Escape all world, action, narration, caption, and metadata content.
4. Permit only validated application asset URLs; do not embed credentials or private state.
5. Generate script-free standalone HTML with explicit UTF-8, restrictive CSP metadata, and predictable filename/content type.
6. Make both UIs call the same backend export route.

### Likely files

- new application/domain readable-export module
- database effective-turn read port
- `services/api/src/server.ts`
- `apps/web/src/story.js`
- replacement UI export control
- export unit, integration, and XSS regression tests

### Exit criteria

- Export includes all turns, not only the client-side page.
- Corrected narration is used.
- Offline HTML opens without scripts and renders safe text/images.
- Markdown behavior remains compatible.

## 11. Slice 6B — Add Revocable World Share Links

### Purpose

Resolve the share-link portion of `REV-006` after Gate C approval.

### Work

1. Add a migration for revocable, expiring share records scoped to owner/world/version.
2. Generate at least 256 bits of random token material; persist only a hash.
3. Add create/list/revoke endpoints requiring the resolved owner.
4. Add a rate-limited public redemption endpoint returning the existing portable world projection only.
5. Bound expiration, redemption response size, and optional access count.
6. Add `WORLD_SHARING_ENABLED=false` (or equivalent structured runtime setting) with documented trusted-network implications.
7. Add create/copy/revoke UI in both management experiences and a safe import preview for recipients.

### Required security tests

- tokens are unguessable and stored hashed;
- expired/revoked/disabled links fail closed;
- no campaign, provider, credential, owner identity, or private asset data appears;
- owner scoping prevents cross-owner management;
- response limits and rate/admission controls apply;
- world updates do not silently change a link pinned to an immutable version.

### Exit criteria

- One copied link reproduces the published world import/preview outcome.
- Disabling sharing invalidates redemption without deleting records.
- Revoke takes effect immediately.

## 12. Slice 7 — Complete the Cross-UI Parity Gate

### Purpose

Finish `REV-007` and make parity a durable cutover criterion.

### Matrix

For every supported legacy fixture, test:

1. preview without writes;
2. import and idempotent replay;
3. selected character and current state;
4. historical state inspection/correction;
5. next-turn context and generation;
6. RPG and before/after trigger behavior;
7. generation resume/retry/cancel/discard;
8. images disabled, unavailable, failed, retried, and successful;
9. narration correction and Chronicle rebuild;
10. HTML/Markdown/Campaign Archive export;
11. archive reimport and authority equivalence;
12. active legacy UI contract and replacement UI contract.

### Test levels

- Pure normalization unit tests.
- Application interface tests using in-memory adapters only where a real second adapter exists.
- PostgreSQL integration tests for transactions, constraints, ownership, concurrency, and migrations.
- Browser E2E tests for both UIs against the same backend/database.
- Docker smoke test using the production image and health checks.

### Cutover gate

Cutover is blocked until:

- every approved parity row is GREEN in both UI columns;
- no legacy import warning is unacknowledged;
- all migrations pass forward and mixed-version compatibility checks;
- Docker/PostgreSQL runtime verification is recorded, not skipped;
- there are zero Critical/High parity findings and no unresolved Medium data-integrity finding.

## 13. Suggested Commit Sequence

1. `test: codify legacy backend parity matrix`
2. `refactor: centralize legacy campaign normalization`
3. `fix: preserve legacy campaign character and turn state`
4. `feat: support historical state corrections`
5. `schema: add accepted narration correction ledger`
6. `feat: apply effective narration across backend consumers`
7. `fix: persist legacy summary and settings translations`
8. `feat: add complete readable campaign exports`
9. `schema: add revocable world share links` (after Gate C)
10. `feat: expose world sharing in both UIs`
11. `test: enforce cross-UI parity cutover gate`
12. `docs: document compatibility, rollout, and rollback`

Each commit should be independently testable and should not include unrelated pre-existing changes.

## 14. Verification Commands

Run focused tests after each RED/GREEN cycle, then at slice completion:

```powershell
pnpm check
pnpm test:unit
pnpm test:integration
pnpm build
git diff --check
```

Also run:

- the repository's browser E2E command discovered at implementation time;
- migration tests from a clean database and from the previous released schema;
- isolated Docker build/start/readiness checks;
- an explicit legacy fixture import→continue→correct→export→reimport smoke test;
- owner/campaign isolation and concurrent-correction tests.

If `TEST_DATABASE_URL` or Docker/PostgreSQL is unavailable, report those tests as **not run**, never passed.

## 15. Rollout and Compatibility

1. Deploy additive schemas before code that writes them.
2. Keep old readers functional: base narration and existing turn/state columns remain intact.
3. During rolling deployment, new code may read both corrected and uncorrected turns; old code continues to see base narration but must not be used to claim parity.
4. Gate narration correction and share links independently so either can be disabled without disabling story generation.
5. Back up the database before applying production migrations.
6. Verify import, correction, Chronicle rebuild, export, and revoke workflows after deployment.
7. Roll back by disabling new write paths first; preserve additive ledger/share tables for forward recovery.

## 16. Finding-to-Slice Traceability

| Finding | Correction slices | Completion evidence |
|---|---|---|
| `REV-001` character authority lost | 0, 1, 2 | campaign seed + prompt-context integration tests |
| `REV-002` fallback private snapshots lost | 0, 1, 2 | historical state and archive round-trip tests |
| `REV-003` response edits local only | 0, 4, 7 | correction ledger and cross-consumer tests |
| `REV-004` compressed history not seeded | 0, 1, 2, 5 | sanitized summary/reindex tests |
| `REV-005` historical state edit unresolved | 0, 3, 7 | snapshot-local correction tests |
| `REV-006` share/HTML outcomes missing | 6A, 6B, 7 | offline export and secure share-link tests |
| `REV-007` no parity gate | 0 through 7 | required CI matrix and Docker E2E evidence |

## 17. Definition of Done

The correction program is complete only when:

- all seven findings have linked GREEN tests and reviewed code;
- legacy imports preserve character, state, metadata, summary, and supported settings;
- accepted narration correction is durable, auditable, and consistent across every consumer;
- historical state edits preserve later turns/current state;
- readable HTML and the approved sharing outcome work in both UIs;
- the active legacy UI remains fully functional against the new backend;
- the replacement UI passes the same backend capability matrix;
- PostgreSQL, browser, Docker, migration, concurrency, and rollback evidence is recorded;
- compatibility documentation identifies every exact, transformed, and retired behavior;
- the cutover decision is made only after the parity gate passes.

## 18. Planning Limitations

- Projectmem MCP methods required by `AGENTS.md` were unavailable; no `.projectmem` files were read or written directly.
- RepoWise was current for committed `HEAD` but does not include the dirty working tree or these new review documents. Its broad risk output identified the import repository, Chronicle repository, campaign-state repository, API server, and Story Player as high-change seams; live source determined the plan.
- RepoWise semantic synthesis did not retrieve the relevant implementation bodies for this question, so its low-confidence answer was not used as design evidence.
- Migration numbering and replacement-UI page filenames must be rechecked immediately before implementation because the worktree may advance.
- Gate A, Gate B, and Gate C require explicit stakeholder approval before their dependent slices are implemented.
