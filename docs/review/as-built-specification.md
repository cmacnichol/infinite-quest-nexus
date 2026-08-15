# Infinite Quest Nexus As-Built Specification

> Status: recovered, not approved. This specification records the backend and compatibility behavior observed for the legacy-parity review. It does not make current behavior intended merely because it exists.

## 1. Review Metadata

- Repository: `C:/Git/InfiniteQuest` (`origin`: `https://github.com/cmacnichol/infinite-quest-nexus.git`)
- Branch: `main`
- Revision: `58822cbed706220b98ea60112a87ab898e34b9d9`
- Working-tree state: not clean; existing edits to `AGENTS.md`, `Dockerfile`, both active UI trees, and associated unit tests were included in the review state. No files were staged or untracked before these reports were created.
- Review scope: current backend parity with the user-visible capabilities and portable data of the isolated root `index.html` client; current legacy UI (`apps/web/public`) and replacement UI (`apps/web-next`) were traced as backend consumers.
- Comparison baseline: the historical root `index.html` at the reviewed working-tree state, not a Git branch or commit.
- RepoWise indexed revision: `58822cbed706` (matches `HEAD`); index age reported as 0 days.
- RepoWise freshness: current for committed `HEAD`, partial for the dirty working tree and these reports.
- Generated: 2026-08-13.

The mandatory projectmem MCP methods named in `AGENTS.md` were not available in this session. No `.projectmem` file was edited directly. The required `precheck_file` and event logging calls therefore could not be performed.

## 2. Evidence Classification

- **Documented:** stated in current documentation, schemas, public contracts, or repository instructions.
- **Observed:** demonstrated by current source, migrations, tests, or executed commands.
- **Historically supported:** demonstrated by historical code or Git history, but not necessarily approved now.
- **Inferred:** strongly suggested but not proven.
- **Desired:** explicitly requested by the stakeholder.
- **Unknown:** requires a product or operational decision.

## 3. System Purpose

**Documented:** Infinite Quest Nexus is a self-hosted system for reusable, versioned story worlds and persistent AI-assisted campaigns. PostgreSQL, rather than the browser or model context, owns authoritative state (`AGENTS.md`; `docs/architecture/repository-overview.md:1-15`).

**Desired:** during cutover, the historical feature set and legacy client workflows must remain compatible with the new backend. This differs from the current retirement decision, which says the root client receives no feature-parity maintenance (`docs/architecture/0020-retire-legacy-player-runtime.md:17-28`).

## 4. Users, Roles, and External Actors

- **Documented:** one server-resolved initial owner is used before authentication; arbitrary browser-supplied identity is not trusted (`AGENTS.md`).
- **Observed:** human users author worlds, configure providers, import/export content, create campaigns, play turns, edit current state, inspect Chronicle context, and manage illustrations through `/nexus/`, `/story`, or `/app/`.
- **Observed:** API and runtime/worker processes call PostgreSQL and separately configured text, embedding, intent, and image providers.
- **Unknown:** multi-user interactive authentication and authorization remain future behavior.

## 5. Architecture Overview

```text
historical index.html (reference/export source)
active legacy UI /nexus + /story ----\
replacement UI /app ------------------+--> Fastify API --> application ports
                                      |                  --> PostgreSQL
                                      \--> runtime worker --> text/image providers
```

**Observed:** `services/api/src/server.ts` exposes browser pages and `/api/v1` routes. Application adapters call repository ports. The runtime claims durable jobs and performs generation, validation, event execution, Chronicle work, and illustration work. PostgreSQL stores worlds, immutable versions, campaigns, accepted turns, state revisions, jobs, memories, providers, assets, and imports.

## 6. Components and Responsibilities

| Component | Responsibility | Evidence classification | Key evidence |
|---|---|---|---|
| Root `index.html` | Historical browser-owned client and parity baseline | Historically supported | `index.html:1080-1694`; ADR 0020 |
| `apps/web/public`, `apps/web/src` | Current management and Story Player UI | Observed | `apps/web/public/index.html`; `apps/web/public/story.html`; `apps/web/src/story.js` |
| `apps/web-next` | Replacement management UI under `/app/` | Observed | `apps/web-next/src/app-shell.ts` and page modules |
| API | Validates HTTP contracts and dispatches application operations | Observed | `services/api/src/server.ts:543-1449` |
| Runtime worker | Executes durable text/image/memory jobs | Observed | `services/runtime/src/generation-executor-adapter.ts` |
| Contracts/application | Shared schemas and use-case boundaries | Observed | `packages/contracts/src`; `packages/application/src` |
| Database repositories | Owner-scoped persistence and transactional state transitions | Observed | `packages/database/src`; `database/migrations` |
| Provider layer | Separates text, image, embedding, and intent profiles and credentials | Documented and observed | `packages/contracts/src/generation.ts`; provider repository/adapters |

## 7. Public Interfaces

**Observed:** major API families include session/profile, prompt library, providers, legacy/world/Infinite Worlds imports, worlds and versions, campaigns and character profiles, turn browsing, current/historical state reads, current-state correction, rewind/branch, durable generation recovery, illustrations/assets, Chronicle diagnostics, and reindex jobs (`services/api/src/server.ts:543-1449`).

**Observed:** no route mutates an accepted turn's narration or a historical turn snapshot. `PATCH /campaigns/:campaignId/state` edits effective current state only (`services/api/src/server.ts:962-981`).

## 8. Primary Workflows

### World authoring and campaign creation

**Observed:** users create/import worlds, edit drafts, generate preview content, publish immutable versions, select a playable character, and create a campaign. Normal campaign creation seeds the selected character into `selected_character_id`, `character_snapshot`, and `character_profile` (`packages/database/src/world-repository.ts:1149-1225`).

### Legacy `.story` import

**Observed:** the schema accepts the legacy world, turns, settings, RPG stats, triggers, scratchpad, current trackers, per-turn snapshots, and compressed-history metadata (`packages/contracts/src/imports.ts:8-84`). A create-world preview converts the legacy character into one playable roster entry (`packages/domain/src/legacy-story-world.ts:14-48`). The commit creates the campaign, current campaign state, accepted turns, and turn-fiction Chronicle memories (`packages/database/src/portable-import-family-repository.ts:1544-1669`).

**Observed defect:** unlike normal campaign creation, the legacy commit does not populate the campaign's selected-character or character snapshot/profile columns (`packages/database/src/portable-import-family-repository.ts:1554-1557`). Generation context removes the stored `world.character` value and adds a player character only from campaign profile/snapshot (`packages/database/src/chronicle-repository.ts:837-860`). This breaks character guidance after import.

**Observed data reduction:** imported turn `state_snapshot_private` receives only `worldStateSnapshot`; the accepted `scratchpadSnapshot` and `trackersSnapshot` fallback fields are not merged (`packages/database/src/portable-import-family-repository.ts:1590-1618`). The root client explicitly stored and restored those fallback snapshots (`index.html:2606-2624`, `4251-4279`).

**Observed data reduction:** `fullHistory` is counted but not imported as a Chronicle summary; result statistics always return `importedSummary: false` (`packages/database/src/portable-import-family-repository.ts:1732-1734`).

### Turn generation

**Observed:** generation is durable, owner/campaign scoped, validates output before commit, separates mechanics from fiction, evaluates before/after event triggers, can append after-event fiction, and independently queues illustrations. LM Studio recovery can continue from a prior provider response ID for schema recovery (`services/runtime/src/generation-executor-adapter.ts:987-1061`, `1240-1260`).

### State correction and history

**Observed:** users can browse historical state and edit only effective current state. The current Story Player labels historical state read-only (`apps/web/public/story.html:352-362`). Rewind and branch are explicit alternatives (`services/api/src/server.ts:1010-1035`).

### Export and sharing

**Observed:** the management UI exports portable world JSON and campaign archives; Story Player exports Markdown and opens print-ready HTML for PDF (`apps/web/public/nexus.js:2239-2243`, `2550-2554`; `apps/web/src/story.js:2242-2319`). The historical client additionally downloaded standalone HTML and generated compressed `#world` share URLs (`index.html:9826-10005`, `10382-10406`). No equivalent share-link or HTML-download backend contract exists.

## 9. Data Model and Persistence

**Documented and observed invariants:** worlds are reusable; world versions are immutable; campaigns pin a version; accepted turns are append-only; campaign state is mutable and revisioned; Chronicle memories and summaries are derived; rows are owner- and campaign-scoped. Relevant tables and constraints are created under `database/migrations`.

**Observed:** the complete campaign archive is the highest-fidelity portability format. Legacy `.story` import is a compatibility conversion and currently loses some legacy-only state described above.

## 10. Authentication and Authorization

**Documented:** pre-auth requests resolve to the credential-free initial owner. This is a trusted-network migration bridge, not authentication (`AGENTS.md`).

**Observed:** API repositories consistently pass `owner_user_id`; the reviewed parity paths do not accept a caller-provided user ID as authorization.

## 11. Trust Boundaries

- Browser input to schema-validated API requests.
- Imported archives/text to bounded staging, parsing, validation, and owner-scoped publication.
- API/runtime to PostgreSQL.
- Runtime to separately configured external providers and credentials.
- Asset storage and retrieval to validated metadata and references.
- Pre-auth network boundary: trusted network controls remain operationally material.

## 12. Configuration and Feature Flags

**Observed:** provider context/output/temperature are provider-profile settings. Story length is an authoritative campaign profile. RPG and event suppression remain campaign settings (`packages/database/src/generation-execution-repository.ts:249-262`).

**Observed:** legacy `memoryManagementMode`, `storyHistoryTokenLimit`, and `storyHistoryCompression` remain in imported `legacy_settings` but are not used by current generation. Current Chronicle automatically chooses compression within the provider/context budget and exposes reindex/configuration endpoints. Whether exact legacy knobs must survive is **Unknown**.

## 13. External Integrations

**Observed:** OpenAI-compatible/LM Studio/OpenRouter-style text profiles, independent image profiles including Sogni, embedding/intent roles, and PostgreSQL. Provider calls are server-side; historical direct browser provider calls are intentionally not preserved.

## 14. Background and Scheduled Processing

**Observed:** durable generation, image, world-generation, import, Chronicle, and embedding jobs are processed asynchronously. There is no general-purpose scheduled job subsystem in parity scope.

## 15. Error Handling and Recovery

**Observed:** generation jobs expose status, stream, result, retry, cancel, and discard routes (`services/api/src/server.ts:1048-1195`). The active Story Player resumes monitoring, retries a durable job, retrieves a temporarily unavailable accepted result, or discards an incomplete job (`apps/web/src/story.js:1069-1164`).

## 16. Concurrency and Idempotency

**Observed:** imports derive authority fingerprints and idempotency keys; durable jobs use leases; campaign mutations use expected turn/state revisions. Full concurrency correctness was not re-executed in this documentation-only review.

## 17. Logging, Metrics, and Observability

**Observed:** server generation diagnostics include correlation/job/campaign context. The active Story Player's Activity Log is session-memory only and copies diagnostics (`apps/web/src/story.js:215-249`), so it does not reproduce the historical filter/preview-capture controls.

## 18. Deployment and Operational Model

**Documented:** Compose/Swarm deploy web/API, runtime worker, PostgreSQL, and optional provider connectivity with health/readiness routes. Runtime migrations and deployment behavior are described in `docs/runbooks/deployment.md`.

## 19. Tests and Validation

**Observed:** the repository defines `pnpm check`, unit, integration, build, and browser-oriented source tests. Import tests cover core conversion but no test asserts that a legacy imported campaign is bound to its converted playable character, nor that fallback per-turn snapshots become `state_snapshot_private`.

Validation in the immediately preceding same-working-tree compatibility task produced: `pnpm check` passed in the repository Node 25 container; unit tests reported 1,964 passed and one timing-sensitive failure; the Docker image built; the isolated runtime compatibility path passed. This parity review itself ran read-only searches, Git/RepoWise inspection, and `git diff --check`; PostgreSQL integration tests and browser E2E were not rerun.

## 20. Known System Invariants

- Only accepted validated fiction mutates campaign state.
- Accepted turns are immutable; correction applies prospectively through state revisions.
- World-version changes require explicit migration/transfer.
- Text and image providers and secrets remain separate.
- Private mechanics must not enter narration or Chronicle fiction.
- Owner and campaign boundaries must not be crossed.
- Portable import must not treat source identity as authorization.

## 21. Documented Requirements

- Portable legacy imports remain supported (`docs/architecture/0020-retire-legacy-player-runtime.md:19-28`).
- JSON import/export remains a portable migration/backup format (`docs/architecture/repository-overview.md:97`).
- Historical root runtime parity was previously not required (`docs/architecture/repository-overview.md:15,48`).

## 22. Observed Behaviors

The current backend covers world authoring/versioning, campaigns, providers, generation, choices/actions, RPG mechanics, event triggers, current-state correction, history browsing, rewind/branch, durable recovery, Chronicle, illustrations, profiles, assets, and portable archive operations. The confirmed exceptions and transformations are recorded in Sections 8 and 25.

## 23. Historically Supported Intent

The root client historically supported arbitrary response edits, historical snapshot edits, `.world` save/load/copy, compressed share URLs, standalone HTML export, manual summary refresh, configurable legacy memory modes, direct provider calls, and detailed client diagnostics (`index.html`). Git history includes `6a240820` (“complete durable import and legacy UI compatibility”), but history alone does not prove current intent.

## 24. Inferred Requirements

- A legacy import should preserve enough character and private-state context that continuing the campaign produces behavior consistent with the imported story.
- Equivalent safer server workflows may replace exact browser implementation details.
- Provider credentials should remain server-owned even if direct browser calls existed historically.

## 25. Unknowns Requiring Human Decisions

1. Must accepted narration become durably editable, despite append-only turn and derived-memory invariants?
2. Must a user edit an arbitrary historical snapshot, or are rewind/branch plus prospective corrections the approved replacement?
3. Are self-contained world share URLs and standalone HTML downloads required for cutover, or are portable files/clipboard and print-to-PDF sufficient?
4. Should legacy manual memory modes/token limits be translated to Chronicle policy, retained only as provenance, or explicitly rejected with warnings?
5. Should imported `fullHistory` seed a Chronicle summary, and how should untrusted mechanic leakage be sanitized?

## 26. Evidence Index

- Historical baseline: `index.html:1080-1694`, `2606-2624`, `4188-4356`, `5178-5345`, `9826-10406`.
- Retirement/compatibility decision: `docs/architecture/0020-retire-legacy-player-runtime.md:11-28`.
- API surface: `services/api/src/server.ts:543-1449`.
- Legacy import contract/conversion: `packages/contracts/src/imports.ts:8-84`; `packages/domain/src/legacy-story-world.ts:14-48`.
- Legacy commit: `packages/database/src/portable-import-family-repository.ts:1544-1734`.
- Generation context: `packages/database/src/chronicle-repository.ts:837-860`, `1172-1211`.
- Active Story Player: `apps/web/public/story.html:31-51`, `352-429`; `apps/web/src/story.js:215-249`, `1069-1164`, `2155-2319`, `2711-2732`.

## 27. Coverage and Limitations

The legacy feature inventory, API surface, import conversion/commit, generation context, state workflow, recovery, exports, event mechanics, and relevant tests were reviewed in depth or at interface level. Provider transports, asset internals, all migrations, all new-UI pages, CSS/accessibility, and unrelated security/deployment concerns were sampled or excluded. RepoWise was current only for committed `HEAD` and contained stale symbol references to a removed API generation service; live source took precedence. No live provider, PostgreSQL, browser E2E, Compose, Swarm, backup, or rollback operation was executed. Therefore this is a complete capability trace for the identified historical surface, not a claim of exhaustive line-by-line repository verification.
