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
