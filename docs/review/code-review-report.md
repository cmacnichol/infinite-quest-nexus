# Infinite Quest Nexus Legacy-Parity Code Review Report

## 1. Executive Summary

The new backend covers most substantive historical gameplay: authored/generated worlds, playable characters, campaigns, providers, actions and choices, RPG checks, event triggers, current-state correction, rewind/branch, durable generation recovery, Chronicle memory, images, profiles, assets, and portable exports. It is not yet safe to declare parity.

The most important confirmed defect is in the legacy `.story` import: it creates the legacy character as a world roster entry but creates the campaign without selecting or snapshotting that character. Current prompt construction intentionally excludes the old `world.character` field, so the next generated turn can omit the protagonist's defining guidance. The import also loses legacy fallback per-turn private snapshots and accepts legacy compressed history without seeding it into Chronicle.

There is also a direct contradiction in the active Story Player: “Edit Response” changes only a local JavaScript object and tells the user it was updated, while the backend, refresh, Chronicle, and export remain unchanged. Other historical features—arbitrary historical-state edits, share URLs, and standalone HTML download—are missing or transformed and require product decisions because ADR 0020 previously retired runtime parity while the stakeholder now requires it.

- Confidence: high for the traced compatibility paths; medium for total backend parity because live PostgreSQL/provider/browser E2E was not rerun.
- Safe to continue building upon: yes, but pause cutover and correct the high-priority import defect first.
- Validation gap: no end-to-end legacy-import test generates the next turn and asserts character/private-state continuity.
- Final recommendation: **Pause and address high-priority findings**.

## 2. Repository and Review State

- Path: `C:/Git/InfiniteQuest`
- Identity: `https://github.com/cmacnichol/infinite-quest-nexus.git`
- Branch: `main`
- `HEAD`: `58822cbed706220b98ea60112a87ab898e34b9d9`
- Baseline: historical root `index.html` in the reviewed working tree; no branch/commit baseline supplied.
- Initial working tree: unstaged changes in `AGENTS.md`, `Dockerfile`, `apps/web-next/src/app-shell.ts`, `apps/web/public/story.html`, and four unit-test files; no staged or untracked files.
- Review writes: only these three files under `docs/review/`.
- Scope: backend parity with historical user-visible capabilities and imported state, including both current UI consumers.
- Exclusions: unrelated full-repository security/dependency audit, visual styling, live providers, production deployment, database mutation.
- State commands: `git status --short --branch`, `git rev-parse`, `git log`, `git remote -v`, `git diff`, `git diff --cached`, route/file searches, and `git diff --check`.
- Material limitation: projectmem MCP tools required by `AGENTS.md` were unavailable.

## 3. RepoWise Analysis

- Availability: available.
- Indexed root/repository: `C:/Git/InfiniteQuest`.
- Indexed revision: `58822cbed706`; index age 0 days and aligned with committed `HEAD`.
- Freshness: complete enough for broad committed-code discovery; uncommitted compatibility changes and these reports are not indexed.
- Tools used: overview, answer/context, why/history, and risk discovery.
- Architecture summary: web clients feed a high-centrality Fastify API and PostgreSQL repositories; runtime adapters execute durable provider and background workflows.
- High-centrality/risk components: `services/api/src/server.ts` (many routes/dependents and high churn), `services/runtime/src/generation-executor-adapter.ts` (generation hotspot), and the Story Player script.
- Historical signal: commit `6a240820` described durable import and legacy UI compatibility.
- Knowledge-silo signal: runtime generation adapter had a low bus-factor signal. This prioritizes review but is not a defect.
- Disagreement: RepoWise referenced a removed `services/api/src/generation-service.ts`; live source locates generation execution in runtime adapters. Live source controlled conclusions.
- RepoWise role: it prioritized the import/generation/API seams. All findings below were verified in current source.

## 4. Recovered System Summary

**Documented:** Nexus is a self-hosted PostgreSQL-authoritative world/campaign platform with separate text and image providers. Pre-auth requests bind to one server-resolved initial owner. Worlds are reusable, versions immutable, campaigns mutable, turns append-only, and Chronicle derived.

**Observed:** the API exposes world/campaign/provider/import/generation/state/image/memory workflows; the runtime performs durable generation and independent illustrations; the active legacy UI and replacement UI share this backend.

**Desired:** retain the historical feature outcomes during cutover. **Documented conflict:** ADR 0020 says the root historical runtime receives no parity maintenance, retaining only explicit import compatibility.

## 5. As-Built Behavior Matrix

| Area or Workflow | Current Behavior | Evidence Classification | Evidence | Confidence | Unknowns |
|---|---|---|---|---|---|
| World create/generate/edit/publish | Durable versioned backend support | Observed | API routes `server.ts:720-853`; world repository | High | None material |
| Playable character selection | Normal campaign creation snapshots selected roster character | Observed | `world-repository.ts:1149-1225` | High | None |
| Legacy `.story` import | Imports world/campaign/turn/state, but campaign character binding is omitted | Observed + Desired violation | `portable-import-family-repository.ts:1544-1618` | Confirmed | Mapping policy for existing target world |
| Historical turn snapshots | Reads snapshots; edits only effective current state | Observed | `server.ts:962-981`; `story.html:352-362` | High | Whether arbitrary historical editing is still required |
| Accepted narration editing | UI edits local memory only; no backend route | Observed | `story.js:2711-2732`; route inventory | Confirmed | Whether accepted narration may be mutable |
| RPG/event mechanics | Backend assesses RPG outcome and before/after triggers | Observed | generation adapter; mechanics module | High | Live provider behavior untested |
| Incomplete generation | Durable resume/retry/cancel/discard; LM Studio response continuation used in recovery | Observed | `story.js:1069-1164`; generation adapter `987-1061` | High | Exact UX equivalence |
| Memory controls | Chronicle chooses compression and supports reindex; exact legacy knobs ignored | Observed/Unknown | Chronicle/API routes; no consumers of legacy knob names | High | Approved translation policy |
| Images | Independent durable image configuration, jobs, retry, prompt edit/regeneration | Observed | `server.ts:1197-1399`; Story Player image controls | High | Live providers untested |
| World/campaign portability | World JSON and campaign ZIP plus legacy import | Observed | export/import routes and management UI | High | Share-link requirement |
| Story-readable export | Markdown and print-to-PDF; no standalone HTML download | Observed | `story.js:2242-2319` | High | Whether PDF substitutes for HTML |
| Activity diagnostics | Session-memory activity log and clipboard copy | Observed | `story.js:215-249` | High | Whether historical filters/preview capture remain required |

## 6. Architecture and Trust-Boundary Assessment

Strengths include shared schemas, server-owned provider secrets, owner-scoped repositories, immutable world versions, append-only accepted turns, durable jobs, idempotent import authority, independent image failure, and explicit state revisions. These are suitable foundations for parity.

Risks are concentrated at compatibility conversions: the legacy format combines world, character, settings, current state, historical snapshots, and derived summary in one document, while the backend splits them across immutable world content, campaign identity, state, turns, and Chronicle. The current converter does not fully populate those separate authorities. `server.ts` and the generation executor are high-centrality; a contract change has broad UI/runtime/test blast radius.

Trust boundaries are browser→API, import bytes→staging/parser, API/runtime→database, runtime→provider, and asset metadata→filesystem/object delivery. Direct historical browser credential/provider calls should not return; server mediation is the safer equivalent.

## 7. Findings

### Critical

None.

### High

#### REV-001 — Legacy import drops the campaign's playable-character authority

- Severity: High
- Confidence: Confirmed
- Category: Compatibility / Data integrity
- Location: `packages/domain/src/legacy-story-world.ts:14-48`; `packages/database/src/portable-import-family-repository.ts:1544-1557`; `packages/database/src/chronicle-repository.ts:837-860`
- Issue: create-world import converts the legacy protagonist into a playable character, but campaign insert does not set `selected_character_id`, `character_snapshot`, or `character_profile`.
- Evidence: normal campaign creation sets those fields (`packages/database/src/world-repository.ts:1149-1225`). The legacy insert includes only ID, owner, world version, title, active turn, and settings. Prompt construction strips `world.character` and includes player character only from campaign profile/snapshot.
- Evidence classification: Observed defect against Desired parity and the documented compatibility boundary.
- Failure scenario: import a `.story` whose protagonist has identity, abilities, and appearance; continue the campaign; the next prompt contains world and story history but no authoritative player-character description, allowing identity/appearance/role drift.
- Blast radius: every legacy `.story` imported through the production portable path; future text generation and illustration character matching.
- Recommended correction: during commit, resolve the converted/preserved selected character and populate the same campaign seed fields normal creation uses. For imports into an existing world version, require/validate explicit mapping or preserve a campaign-owned snapshot.
- Validation: PostgreSQL integration test imports a fixture, asserts campaign character fields, previews generation context, and generates one next turn with character details present. Add create-world and existing-world mapping cases.
- RepoWise role: prioritized import/generation seams; live source proved the defect.

### Medium

#### REV-002 — Legacy fallback per-turn private snapshots are silently discarded

- Severity: Medium
- Confidence: Confirmed
- Category: Compatibility / Data integrity
- Location: `packages/contracts/src/imports.ts:47-49`; `packages/database/src/portable-import-family-repository.ts:1590-1618`; `index.html:2606-2624`, `4251-4279`
- Issue: the contract accepts `scratchpadSnapshot` and `trackersSnapshot`, but commit writes only `worldStateSnapshot ?? {}` to `state_snapshot_private`.
- Evidence: the historical client treats the fallback fields as authoritative when `worldStateSnapshot` is absent. The repository fixture itself contains fallback snapshots (`tests/fixtures/legacy-story.json`).
- Evidence classification: Observed defect against Desired parity.
- Failure scenario: import an older `.story` that predates `worldStateSnapshot`; historical state inspection shows empty private state and rewind/branch reconstruct from incomplete snapshots.
- Blast radius: older legacy exports, historical inspection, branch/rewind, continuity debugging.
- Recommended correction: normalize each turn using the historical precedence rules before persistence: merge world snapshot with scratchpad/tracker fallbacks and validated RPG/event fields.
- Validation: integration fixture with only fallback fields; assert turn snapshots and historical state reads preserve them, while Chronicle fiction excludes private content.
- RepoWise role: none beyond locating import boundaries.

#### REV-003 — Accepted-response editing reports success but is neither durable nor authoritative

- Severity: Medium
- Confidence: Confirmed
- Category: Functional correctness / Compatibility
- Location: `apps/web/src/story.js:2711-2732`; `services/api/src/server.ts:941-1195`
- Issue: the active Story Player exposes “Edit Response,” mutates `state.turns[index].narration`, and displays “Response updated locally.” There is no API route to persist accepted narration or reconcile Chronicle/state.
- Evidence: refresh reloads turns from the server; exports use current in-memory state; route inventory has turn reads and illustration operations but no narration mutation.
- Evidence classification: Observed contradiction; historical editing is Historically supported and stakeholder parity is Desired.
- Failure scenario: edit a response, export it, refresh, and see the edit disappear; later generation and Chronicle continue using the original text.
- Blast radius: users relying on correction, readable exports, continuity, and cutover acceptance.
- Recommended correction: make the control explicitly non-authoritative and remove the success implication, or design an auditable accepted-turn correction model that updates derived indexes without overwriting the ledger. Product approval is required before the latter.
- Validation: browser/API test proves either persistence and Chronicle reconciliation or clearly labeled session-only behavior that cannot masquerade as saved state.
- RepoWise role: Story Player hotspot prioritization only.

#### REV-004 — Imported legacy compressed history is accepted but never seeds Chronicle

- Severity: Medium
- Confidence: High
- Category: Compatibility / Migration
- Location: `packages/contracts/src/imports.ts:81-82`; `packages/database/src/portable-import-family-repository.ts:1653-1669`, `1732-1734`
- Issue: import counts `fullHistory` characters/tokens but always reports `importedSummary: false`; only narration-derived turn memories are inserted.
- Evidence: the legacy fixture contains structured `fullHistory`; the contract accepts any value; no commit path formats/sanitizes it into a summary.
- Evidence classification: Observed; whether intentional is Unknown, but silent acceptance conflicts with complete parity.
- Failure scenario: a long legacy campaign had already compressed early details into `fullHistory`; after import, those details are absent from current generation until/unless recoverable from full narration and a reindex, which may not reproduce the authored summary.
- Blast radius: long imported campaigns and continuity quality.
- Recommended correction: either sanitize and import the summary with provenance and `throughTurn`, or warn in preview/commit that it will be discarded and require a Chronicle rebuild. Never copy mechanics/private content into fiction memory.
- Validation: integration tests for structured/string summary, mechanic leakage sanitization, through-turn metadata, and explicit warning when skipped.
- RepoWise role: none.

#### REV-005 — No approved equivalence rule exists for historical-state edits

- Severity: Medium
- Confidence: High
- Category: Human decision required / Architecture
- Location: `apps/web/public/story.html:352-362`; `services/api/src/server.ts:962-1035`; historical behavior `index.html:4251-4356`
- Issue: the historical client allowed editing scratchpad/tracker state at a viewed turn without changing later turns. The backend reads historical state but only corrects effective current state; rewind and branch change campaign lineage.
- Evidence classification: Observed difference, Desired parity, Documented append-only invariant, Unknown target behavior.
- Failure scenario: a user needs to repair a bad turn-10 tracker while preserving turns 11-30 and their current state; no backend operation expresses exactly that request.
- Blast radius: state correction and migration expectations, especially long campaigns.
- Recommended correction: stakeholder must choose: approve prospective correction as equivalent, add effective-turn-number revision semantics with deterministic later-state behavior, or require branch/replay. Document the choice before implementation.
- Validation: acceptance tests for the selected semantics, concurrency revision checks, historical reads, prompt context, rewind, and branch.
- RepoWise role: API/state centrality helped prioritize review.

### Low

#### REV-006 — Legacy share-link and standalone HTML outcomes have no approved replacement

- Severity: Low
- Confidence: Confirmed
- Category: Compatibility / Human decision required
- Location: historical `index.html:9826-10005`, `10382-10406`; current `apps/web/src/story.js:2242-2319`; management export routes/UI
- Issue: current workflows support portable files/clipboard, Markdown, and print-to-PDF, but not compressed `#world` share URLs or downloaded self-contained HTML.
- Evidence classification: Observed difference; Historically supported; Desired parity; intended equivalence Unknown.
- Failure scenario: a user accustomed to sending one URL or offline HTML cannot reproduce that exact workflow during cutover.
- Blast radius: sharing and offline-readable exports; authoritative campaign state is unaffected.
- Recommended correction: approve current substitutes or add a server-mediated share token with expiration/ownership controls and a sanitized downloadable HTML export. Do not restore unbounded world data in URL fragments without an explicit decision.
- Validation: product acceptance plus security/size/XSS tests for any new share/export implementation.
- RepoWise role: none.

#### REV-007 — Parity is not protected by an end-to-end capability matrix

- Severity: Low
- Confidence: Confirmed
- Category: Testing / Documentation
- Location: `tests/unit/legacy-import.test.ts`; import integration suites; `docs/ui/FEATURE_IMPLEMENTATION_MATRIX.md`
- Issue: existing tests validate many individual contracts, but no executable matrix imports representative historical format versions and then exercises continuation, character context, state history, recovery, triggers, images-disabled behavior, and round-trip export.
- Evidence classification: Observed validation gap.
- Failure scenario: schema acceptance tests pass while material campaign authority is omitted, as REV-001 demonstrates.
- Blast radius: every future compatibility refactor and cutover decision.
- Recommended correction: turn the approved matrix in this report into data-driven integration/E2E tests and make it a cutover gate.
- Validation: CI runs all supported legacy fixtures through import→continue→export→reimport with explicit capability assertions.
- RepoWise role: highlighted high-churn compatibility seams.

## 8. Human Decisions and Requirement Unknowns

| Decision or Unknown | Why It Matters | Evidence Reviewed | Options | Risk of Wrong Choice | Recommended Default |
|---|---|---|---|---|---|
| Can accepted narration be corrected? | Ledger/Chronicle integrity conflicts with historical editing | root client, active UI, API routes, invariants | immutable; correction overlay; mutable rewrite | silent divergence or destructive history | correction overlay only after design approval |
| Historical snapshot semantics | Current correction is prospective, not arbitrary historical edit | state API/repository/UI | approve replacement; effective-turn revisions; branch/replay | inconsistent derived state | approve prospective correction unless a concrete migration use case requires more |
| Share URL requirement | Security/ownership model differs from browser fragment | root share code, export APIs | retire; signed server share; fragment payload | leakage/unbounded URLs or lost workflow | portable world file/clipboard until secure design approved |
| Standalone HTML | PDF/Markdown may or may not satisfy offline use | both export implementations | approve substitutes; HTML download | cutover surprise | add sanitized HTML only if users require it |
| Legacy memory settings | Imported knobs are stored but ignored | fixture, search, Chronicle design | map; warn/retire; emulate | misleading imports or complexity | warn and document Chronicle replacement |
| `fullHistory` handling | Can contain valuable continuity and private/mechanic text | schema, fixture, import commit | sanitize/import; rebuild; discard with warning | continuity loss or leakage | sanitize/import with provenance after tests |

## 9. Test and Validation Results

| Command | Working Directory | Result | Relevant Output | Interpretation |
|---|---|---|---|---|
| Git state/revision/log/diff inspection | `C:/Git/InfiniteQuest` | Passed | `main`, `HEAD 58822c...`, dirty unstaged tree | Exact review state established |
| RepoWise overview/context/risk/history | repository index | Passed with limitations | indexed `58822cbed706`, age 0; stale removed symbol reference | Useful discovery, live source required |
| Targeted `rg`/PowerShell source tracing | `C:/Git/InfiniteQuest` | Passed | API/import/context/UI paths traced | Primary finding evidence |
| `git diff --check` before report writes | `C:/Git/InfiniteQuest` | Passed | no whitespace errors; global ignore ACL warning | Working-tree patch structurally valid |
| `pnpm check` (immediately preceding same working tree) | Node 25 repository container | Passed | type/repository checks passed | Direct trustworthy output for executable state before docs |
| Full unit suite (immediately preceding same working tree) | Node 25 repository container | Partial | 1,964 passed; one timing-sensitive failure | Broad coverage, not clean green |
| Docker build/runtime compatibility (immediately preceding same working tree) | isolated Docker runtime | Passed | image built; compatibility path passed | Packaging/runtime evidence, not parity proof |

Not run in this review: PostgreSQL integration suite (would mutate a test DB), browser E2E, live providers, Compose/Swarm deployment, backup/restore, or load/concurrency tests. No dependency installation was performed.

## 10. Test and Validation Gaps

- Legacy character binding: missing import→context-preview→next-generation integration test; High priority.
- Legacy per-turn snapshots: missing fallback normalization and historical-state integration test; High priority.
- Legacy full history: missing sanitization/import/warning tests; Medium priority.
- Response editing: missing browser test proving durable or explicitly session-only semantics; High priority.
- Capability matrix: missing versioned fixtures and import→continue→export round trips; High priority.
- Both UIs: missing shared backend-contract conformance suite; Medium priority.
- Live PostgreSQL/provider/browser validation: not executed in this review; required before cutover.

## 11. Coverage Report

| Component or Path | Coverage Level | Review Method | RepoWise Used | Source Verified | Limitations |
|---|---|---|---|---|---|
| Root `index.html` capability baseline | Reviewed in depth | controls/functions/data fields inventory | No | Yes | not browser-executed |
| API route surface | Interface and dependency review | route inventory and targeted bodies | Yes | Yes | not every handler interior |
| Legacy contracts/conversion/commit | Reviewed in depth | end-to-end source trace | Yes | Yes | no live DB run |
| Chronicle prompt construction | Reviewed in depth | campaign/world character flow | Yes | Yes | no live provider call |
| Generation/recovery/mechanics | Interface and dependency review | runtime paths/tests | Yes | Yes | sampled, not line-by-line |
| Active Story Player | Reviewed in depth for parity | targeted workflows | Yes | Yes | no visual/browser E2E |
| Management UI | Interface and dependency review | export/import/config workflows | Limited | Yes | styling/accessibility excluded |
| Replacement UI | Sampled | navigation/page/API boundaries | Limited | Yes | incomplete cutover UI itself |
| Database migrations/repositories | Interface and dependency review | parity-sensitive tables/repos | Yes | Yes | unrelated migrations sampled |
| Provider/image internals | Sampled | contracts and parity paths | Limited | Yes | external systems untested |
| Deployment/security | Excluded except trust boundaries | docs/config sampling | Limited | Partial | separate audits exist; not parity scope |
| Generated/vendored assets | Generated or vendored | excluded | No | No | `jszip.min.js` not reviewed |

## 12. Recommended Corrections

### Immediate

- REV-001: bind imported campaigns to the converted/mapped playable character and prove the next prompt retains character authority. Benefit: prevents major continuation drift. Dependency: define mapping for imports into an existing world. Risk of delay: every new import may be durably incomplete.

### Near term

- REV-002: normalize legacy per-turn snapshots before persistence.
- REV-003: remove misleading local-only success or approve/design a correction overlay.
- REV-004: preserve or explicitly warn about legacy compressed history.
- REV-005: approve historical-state correction semantics.
- REV-007: add a parity-gate integration/E2E matrix.

### Planned improvement

- REV-006: decide whether portable file/clipboard and PDF/Markdown are accepted replacements; implement only approved missing outcomes.
- Document the translation/retirement policy for legacy memory knobs and diagnostic controls.

## 13. Proposed Specification Recovery Process

1. Review every row in the as-built behavior matrix.
2. Mark it intended, accidental but acceptable, defective, obsolete, or unknown.
3. Resolve character mapping, response correction, historical-state, summary, share, and HTML decisions.
4. Convert approved outcomes into a target-state parity specification.
5. Add explicit acceptance criteria per legacy format version and both UI consumers.
6. Define security, data, migration, rollback, observability, and failure requirements.
7. Approve the target-state specification before implementation planning.

## 14. Proposed Implementation-Planning Process

After approval: map findings to requirements; create small test-first tasks with exact files/contracts/tests; fix High before unrelated cutover work; use an isolated branch/worktree; independently review each task; run PostgreSQL, browser, Docker, and cross-UI contract verification; then perform a final review. This report intentionally does not provide the full implementation plan.

## 15. Unverified Areas

- Live PostgreSQL execution of the identified import cases.
- Real text/image provider continuation after legacy import.
- Browser E2E for both active and replacement UIs.
- Full migration, rollback, backup/restore, Compose, and Swarm behavior.
- Unrelated security/dependency findings.
- Every migration/repository/provider line.
- Projectmem instructions/summary/map due unavailable MCP methods.
- Uncommitted working-tree changes in RepoWise's index.
- Exact business intent where ADR 0020 conflicts with the new parity request.

## 16. Final Recommendation

**Pause and address high-priority findings.** Do not cut over on the current claim of parity. The backend foundation is strong, but REV-001 demonstrably disconnects imported character authority from future generation, and no E2E parity gate would catch it. First: (1) approve the character-mapping and correction semantics, (2) fix and integration-test REV-001 and REV-002, and (3) convert the approved matrix into a cross-UI cutover gate before deciding the remaining Medium/Low equivalence questions.

## 17. Focused Dead-Code Review Addendum — 2026-08-18

### 17.1 Executive result

At revision `49777f37f620f8030eb0bed2716f24c5fb21523b`, no active whole JavaScript/TypeScript source file and no workspace package was proven unreachable. The active legacy and replacement clients are both connected to their build/runtime entry points. The cleanup inventory is:

| Category | Count | Disposition |
|---|---:|---|
| Confirmed unused production declarations/imports/locals/parameters | 34 | Deletion-ready in scoped batches, except the provider transport contract parameter should be narrowed deliberately |
| Confirmed unused test declarations/imports/locals | 34 | Deletion-ready mechanical cleanup |
| Confirmed unused dependency | 1 (`@playwright/test`) | Remove unless browser tests are being added immediately |
| Intentionally unreachable historical application | 1 (`index.html`, 10,057 lines) | Human archival decision, then delete and update guard/docs |
| Orphan standalone tooling | 1 (`scripts/provision-windows-dev-tools.ps1`) | Confirm operational status; document or delete |
| Proven active false positives from graph analysis | 3 files plus multiple exports/internals | Retain |

The active declaration cleanup is approximately 70–90 lines. Removing the historical root application would reclaim a further 10,057 lines and 536,930 bytes. Final recommendation for this focused scope: **continue normal development while executing a low-risk cleanup series; decide the historical artifact and orphan-script policy separately.**

### 17.2 Repository and analysis state

- Repository: `C:/Git/InfiniteQuest`, branch `main`, revision `49777f37f620f8030eb0bed2716f24c5fb21523b`.
- Pre-existing working-tree changes: `.claude/CLAUDE.md` and `AGENTS.md`; excluded from code conclusions and left untouched.
- RepoWise availability: available, indexed at `f2f7a1bfd00c`, behind current `HEAD`.
- RepoWise dead-code summary: 465 raw candidates (21 high-confidence unused exports, 438 medium-confidence internals, three low-confidence files). The index incorrectly marked live-current symbols such as `createWorldShareLink` and treated internal use as deletion-safe; none was accepted without live verification.
- Current-tree reachability inventory: 603 source/test JavaScript and TypeScript files, 286 explicit roots, 590 reachable after executable, package, HTML, Vite, test, script, and migration roots were included. The 13 initially unreachable entries were `.d.ts` declarations, client-boundary fixtures, an integration setup file, or HTML/config-loaded files; all were proven active or intentionally fixture-driven.

### 17.3 Findings

#### DEAD-001 — The root historical application is unreachable by design

- **Severity:** Medium (maintainability and repository-data risk), **confidence:** Confirmed.
- **Category:** Maintainability / human decision required.
- **Location:** `index.html:1`; controlling evidence in `README.md:123`, `AGENTS.md:104`, `scripts/check-repository-boundaries.mjs:32,115`, and `services/api/src/server.ts:505-506`.
- **Issue:** the repository retains a 10,057-line standalone application that cannot be loaded or shipped. A repository guard exists specifically to prevent runtime use.
- **Evidence classification:** Documented and observed.
- **Impact:** large search/review surface, stale implementation examples, and risk that future work accidentally copies historical logic or embedded data. It has no current runtime blast radius.
- **Correction:** choose either (a) delete it after preserving any required history in Git, updating README/AGENTS and the historical-client allowlist test, or (b) explicitly retain it as an archive and exclude it from all automated code inventories.
- **Validation:** `pnpm check`, `pnpm test:unit`, both web builds, and direct proof that `/` and `/index.html` still redirect to `/nexus/`.

#### DEAD-002 — Thirty-four production declarations have no consumer

- **Severity:** Low, **confidence:** Confirmed.
- **Category:** Maintainability.
- **Evidence:** 30 TypeScript `TS6133`/`TS6196` diagnostics under `--noUnusedLocals --noUnusedParameters`, plus four current-tree exported declarations with exactly one repository occurrence and no importer.
- **Failure scenario:** no current functional failure; the remnants increase cognitive load and make security/data-sensitive adapters look more capable than they are.
- **Blast radius:** concentrated in recently refactored import, filesystem, generation, Chronicle, and illustration adapters. Several files are high-churn/high-centrality, so removals should remain mechanical and split by subsystem.

Compiler-confirmed production inventory:

| File and line | Unused item(s) |
|---|---|
| `packages/client-core/src/generation/workflow.ts:8` | `GenerationSubmissionInput` type import |
| `packages/contracts/src/client-api.ts:3-4,15,22-23` | six imports duplicated by direct re-exports: `campaignBranchSchema`, `campaignRewindSchema`, `turnInputClassificationRequestSchema`, `userProfileUpdateSchema`, `campaignCreateSchema`, `worldCreateSchema` |
| `packages/contracts/src/client-api.ts:26` | `operationKindSchema` |
| `packages/database/src/asset-publication-repository.ts:10` | `PrivatePreparedAssetPublication` type import |
| `packages/database/src/chronicle-chunk-repository.ts:136-140` | `transactionClient` helper |
| `packages/database/src/chronicle-context-repository.ts:39` | `ChronicleQueryKind` type import |
| `packages/database/src/durable-filesystem-repository.ts:16` | `DurableFilesystemReserveRequest` type import |
| `packages/database/src/durable-filesystem-repository.ts:342-347` | `claimClassification` helper |
| `packages/database/src/generation-execution-repository.ts:509` | `entityMetadata` local |
| `packages/database/src/generation-repository.ts:4` | `GenerationRetryLatestRequest` type import |
| `packages/database/src/portable-import-family-repository.ts:902-907` | `portableRecord` helper |
| `packages/story-engine/src/provider-transport.ts:96` | `profile` implementation parameter; the public transport contract still includes it |
| `services/api/src/portable-infinite-worlds-import-route.ts:5` | `convertInfiniteWorldsWorld` import |
| `services/runtime/src/generation-executor-adapter.ts:5,16` | `StreamingIllustrationConfig`, `MemoryContextQuery` type imports |
| `services/runtime/src/illustration-image-job-adapter.ts:9` | `IllustrationImageProviderPort` type import |
| `services/runtime/src/illustration-image-job-adapter.ts:873-882` | `withoutTemporaryUrls` helper |
| `services/runtime/src/illustration-platform-adapter.ts:10` | `IllustrationTransactionContext` type import |
| `services/runtime/src/illustration-platform-adapter.ts:286-288` | `notFound` helper |
| `services/runtime/src/illustration-segment-job-adapter.ts:9` | `logger` import |
| `services/runtime/src/portable-import-export-composition.ts:24,42` | `legacyWorldContent`, `PrivatePortableFamilyMutationPort` imports |
| `services/runtime/src/portable-import-export-composition.ts:965-972` | `isLegacyExternalImageUrl` helper |
| `services/runtime/src/provider-world-generation-adapter.ts:872` | unused private `pool` parameter; two call sites still pass it |
| `services/runtime/src/secure-filesystem-adapter.ts:20` | `ReservedFilesystemOperation` type import |

Additional export/reference-confirmed inventory:

| File and line | Unused exported declaration |
|---|---|
| `packages/application/src/imports/private-portable-composition.ts:73-81` | `canonicalPortableAssetReservationCommand` |
| `services/runtime/src/chronicle-platform-adapter.ts:27-31` | `ChronicleEmbeddingProviderScope` |
| `services/runtime/src/chronicle-platform-adapter.ts:33-37` | `ChronicleEmbeddingProviderSelectionScope` |
| `services/runtime/src/provider-world-generation-adapter.ts:189` | `WorldGenProgress` |

- **Correction:** delete imports/types/locals/helpers; remove the private world-generation `pool` parameter and its two arguments; either keep the public provider-transport profile parameter as `_profile` to preserve the contract or deliberately remove it from `ProviderTransport.fetch` and every adapter/test in a separate contract change.
- **Validation:** enable the strict unused compiler flags for the cleaned programs, run focused unit/integration suites named in the cleanup plan, then the full standard gates.

#### DEAD-003 — Thirty-four test declarations are unused

- **Severity:** Low, **confidence:** Confirmed.
- **Category:** Testing / maintainability.
- **Evidence classification:** Observed compiler diagnostics.
- **Inventory:**

| File | Unused items |
|---|---|
| `tests/helpers/private-storage-lifecycle-fake.ts:20-21` | `PortableArchiveExportRetrieval`, `PortableStagedInput` |
| `tests/helpers/runtime-application-fixtures.ts:44` | `store` |
| `tests/integration/campaign-transfer-character-repository.integration.test.ts:16` | `worldCreateSchema` |
| `tests/integration/durable-filesystem-repository.integration.test.ts:7` | `AttachedFilesystemOperation` |
| `tests/integration/gameplay.integration.test.ts:13,24,131,730` | `runImageJob`, `generationStreamSnapshotSchema`, `imageProviderId`, `worldTitle` |
| `tests/integration/import-memory.integration.test.ts:4,1040` | `JSZip`, `ownerUserId` |
| `tests/integration/import-repository.integration.test.ts:22,181` | `DatabaseClient`, `staged` |
| `tests/integration/task-14e3b4-secure-storage-repository.integration.test.ts:11` | `PrivatePrewriteCleanupPreparation` |
| `tests/integration/task-14e3b5-storage-composition.integration.test.ts:27-31` | four unused storage/publication types |
| `tests/integration/task-14e3e1c-normalized-publication-repository.integration.test.ts:282` | `legacyIdentity` |
| `tests/integration/task-14e3e4-portable-normalized-publication.integration.test.ts:2138` | `row` callback parameter |
| `tests/integration/world-generation.integration.test.ts:568` | `marker` |
| `tests/legacy-api/src/campaign-archive-service.ts:860` | `embedded` |
| `tests/legacy-api/src/infinite-worlds-import-service.ts:388` | `basePrompt` |
| `tests/unit/application/world-campaign-use-cases.test.ts:242` | `owner` callback parameter |
| `tests/unit/asset-archive-service.test.ts:51` | `assetE` |
| `tests/unit/chronicle-runtime-adapter.test.ts:11` | entire unused import declaration |
| `tests/unit/client-web/api-client.test.ts:20` | `GenerationJobSnapshot` |
| `tests/unit/client-web/generation-poll-source.test.ts:9` | `Clock` |
| `tests/unit/runtime-illustration-composition.test.ts:337` | `store` |
| `tests/unit/task-14e2ar-persisted-filesystem.test.ts:19` | `DurableFilesystemJournalPort` |
| `tests/unit/task-14e3b1-contracts.test.ts:1,6` | `vi`, `AttachedFilesystemOperation` |
| `tests/unit/task-14e3b4-secure-filesystem-adapter.test.ts:956` | `closeResolved` |
| `tests/unit/task-14e3e7-maintenance-scheduler.test.ts:82` | `entered` |

- **Correction:** remove the unused test material in a separate mechanical commit. Do not remove client-boundary fixture declarations merely because normal reachability analysis cannot import them; those files are source text consumed by boundary tests.
- **Validation:** strict unused compiler run, `pnpm test:unit`, and the affected integration groups with the isolated PostgreSQL harness.

#### DEAD-004 — `@playwright/test` is installed but unused

- **Severity:** Low, **confidence:** Confirmed.
- **Category:** Dependency maintenance.
- **Location:** `package.json:55`, corresponding `pnpm-lock.yaml` entries.
- **Evidence:** no Playwright config, test file, import, or package/CI command exists outside the manifest and lockfile.
- **Correction:** remove it with the package manager and update the lockfile, unless an immediate approved browser-test task will consume it.
- **Validation:** frozen-lockfile install in CI, `pnpm check`, `pnpm test:unit`, `pnpm build`.

#### DEAD-005 — Windows provisioning script has no discoverable workflow

- **Severity:** Low, **confidence:** Medium.
- **Category:** Human decision required / documentation.
- **Location:** `scripts/provision-windows-dev-tools.ps1:1-155`.
- **Evidence:** introduced by commit `8e96f0d`; no package command, CI job, test, README entry, or current operations/developer guide references its filename. The script installs machine-wide Node, pnpm, Python, and optional review tools and can alter Docker permissions, so manual execution is a plausible intentional entry point.
- **Correction:** ask the maintainer whether it remains supported. If yes, document it with prerequisites and ownership; if no, delete it. Do not infer deletion from zero importers.
- **Validation:** documentation link check if retained; no runtime test required if removed.

### 17.4 Rejected candidates and false positives

| Candidate | Why it is active |
|---|---|
| `apps/web/public/image-library-browser.js` | imported by `apps/web/public/nexus.js:1` using `/nexus/...`, covered by UI and server tests |
| `apps/web-next/public/theme-bootstrap.js` | loaded by `apps/web-next/index.html:8`, covered by theme/build tests |
| `docs/.vitepress/config.ts` | VitePress configuration-discovery entry point |
| `createWorldShareLink` | imported and called by `apps/web-next/src/world-editor-page.ts:6,534`; RepoWise missed the post-index connection |
| `createGenerationExecutionCollaborators` | used locally as a factory binding in its own module (`generation-worker-composition.ts:79`) |
| `createApiPortableTargetReader` | used locally as a factory binding (`api-portable-import-export-composition.ts:215`) |
| exported constants such as `GENERIC_FAILURE_MESSAGE` and `CHRONICLE_GENERIC_CHUNK_SKIP_REASON` | read by active functions in their defining files; only their external export is unused |
| legacy Nexus and Story event handlers | referenced through `addEventListener`/DOM bindings; identifier/call-graph-only scans miss these uses |
| `scripts/*.d.mts` | TypeScript declarations selected for `.mjs` imports, not unused generated output |
| `tests/fixtures/client-boundaries/**` | source-text fixtures consumed by repository boundary tests rather than ordinary module imports |

### 17.5 Cleanup plan

#### Phase 1 — Add a reproducible unused-code gate

1. Add a non-emitting production check using `--noUnusedLocals --noUnusedParameters` for root, client-core, client-web, application, and replacement UI programs.
2. Keep it separate from the existing gate until Phases 2 and 3 are green; then include it in `pnpm check`.
3. Add a small repository-owned dependency/reference check or adopt an approved maintained tool; ensure HTML/config/dynamic roots are allowlisted explicitly.

Acceptance: the gate reproduces the 30 compiler findings without flagging active HTML/config files or boundary fixtures.

#### Phase 2 — Remove active production remnants by subsystem

Use small commits to limit risk:

1. **Contracts/clients/new UI:** remove unused imports and `operationKindSchema`, `CharacterWorkspaceState` import, and `WorldGenProgress` alias. Run client-core/client-web/new-UI checks and their focused unit tests.
2. **Chronicle/generation:** remove the unused Chronicle helpers/types, generation local/type imports, and private world-generation `pool` argument. Run Chronicle, generation-executor, and world-generation unit tests plus their focused integration suites.
3. **Portable import/filesystem:** remove the canonical reservation helper, dead portable helpers/imports, and durable-filesystem helpers/imports. This is the riskiest batch because RepoWise reports 89–99th-percentile churn and broad co-change surfaces. Run portable-composition, durable-filesystem, campaign-transfer, and normalized-publication integration suites against the isolated PostgreSQL database.
4. **Illustration/provider:** remove dead illustration types/helpers/logger import. Treat `ProviderTransport.fetch(profile, ...)` separately: either preserve the contract with `_profile` or remove the parameter end-to-end with provider security tests.

Acceptance per commit: strict unused check, focused tests, `pnpm check`, `pnpm test:unit`, `pnpm build`, and `git diff --check`.

#### Phase 3 — Remove test debris

Delete the 34 compiler-confirmed unused test declarations in one mechanical commit, preserving fixture-only declarations that encode boundary-test scenarios. Run the strict test-program check, all unit tests, and the affected isolated integration groups.

#### Phase 4 — Remove the unused dependency

Remove `@playwright/test` with pnpm so `package.json` and `pnpm-lock.yaml` stay consistent. If browser automation is imminent, replace this phase with the actual Playwright config/test implementation so the dependency becomes genuinely used.

#### Phase 5 — Decide retained artifacts

1. Decide whether Git history is sufficient archival storage for root `index.html`. If yes, delete it and update README, AGENTS, repository-boundary checks, and any docs that describe it as retained. If no, move it to a clearly non-code archival location only if repository policy permits.
2. Decide whether `scripts/provision-windows-dev-tools.ps1` is supported. Document and test its entry conditions, or delete it.

#### Phase 6 — Final cross-surface verification

Run:

```text
pnpm check
pnpm test:unit
pnpm test:integration
pnpm build
git diff --check
```

Inspect both Vite manifests and smoke the legacy Nexus, legacy Story Player, and replacement `/app/` UI. Do not call integration validation passed unless the isolated PostgreSQL harness actually completes.

### 17.6 Validation performed for this review

| Command | Result | Interpretation |
|---|---|---|
| `pnpm check` | Passed | Existing repository/package/web/type/syntax gates are green |
| `tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` | Expected failure: 64 diagnostics | 30 production and 34 test unused-code findings captured above |
| Current-tree module/entry reachability audit | 603 files, 590 reachable from 286 roots | No active whole production module remained unreachable after dynamic roots were resolved |
| Current-tree export/reference audit | Four extra dead production exports | Supplemented compiler diagnostics, which do not reject unused exports |
| Legacy JS declaration/reference audit | No non-exported one-occurrence declaration in active legacy code | DOM-handler false positives excluded |
| `pnpm test:unit` | 187 files passed; 2,131 tests passed; 44 skipped | Source/unit verification passed; skipped tests are not runtime proof |
| `pnpm build` | Passed for both web clients | Legacy and replacement build graphs are intact; four existing font URL notices remain |

Integration tests were not run because their harness provisions and mutates a Docker PostgreSQL test database, which was outside this read-only review. No browser smoke test or live provider test was performed.
