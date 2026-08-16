# Infinite Quest Nexus Repository Guidelines

## Project Goal

Infinite Quest Nexus is a self-hosted platform for creating reusable, versioned story worlds and running persistent AI-assisted campaigns within them. The platform must preserve authoritative world and campaign state independently of any LLM context window, model instance, browser session, or LM Studio response chain.

Text generation and image generation must be independent provider concerns. Story text uses the configured text-LLM endpoint, while optional illustrations use a separately configured compatible image endpoint with its own base URL, credentials, model inventory, selected model, health state, and retry policy. Never assume that the text endpoint also serves images or automatically reuse its credentials. A missing or unavailable image endpoint must disable or defer illustration work without preventing story generation.

Do not embed sample worlds, campaign records, accepted turns, story history, imported lore, or other user content in `index.html` or application source. Runtime world and campaign data belongs in the authoritative database; sanitized regression content belongs only in test fixtures. Legacy exports may be imported through explicit migration code but must not be silently bundled or restored by the client.

Product domains, naming conventions, and deployment names: see [docs/architecture/repository-overview.md](docs/architecture/repository-overview.md).

## Target Architecture

Store database credentials, text-endpoint tokens, image-endpoint tokens, and other credentials as separate Docker Swarm secrets. Store non-sensitive endpoint and runtime settings in Swarm configs or environment configuration. Do not assume `host.docker.internal` is available from Swarm nodes.

Full service-topology description (web/API/worker/DB/text/image/vector-search breakdown): see [docs/architecture/repository-overview.md](docs/architecture/repository-overview.md#target-architecture).

Compose/Swarm build-and-deploy contract, migration-locking strategy, and manifest layout: see [docs/runbooks/deployment.md](docs/runbooks/deployment.md).

## Domain and Persistence Rules

Keep these concepts distinct:

- A **world** is a reusable authored project.
- A **world version** is an immutable snapshot of its lore, rules, entities, relationships, triggers, assets, and defaults.
- A **campaign** is a mutable story instance created from one world version.
- A **turn** is append-only after acceptance.
- **Campaign state** contains the current mutable facts produced by accepted turns.
- **Derived memory** contains embeddings and summaries that can be rebuilt from authoritative data.

Editing a world must not silently alter existing campaigns. Moving a campaign to a newer world version requires an explicit migration. Campaign discoveries may be promoted into a new world draft only through an explicit, reviewable action.

Every campaign-owned row and memory record must be scoped by `campaign_id`; reusable canon must be scoped by `world_id` and `world_version_id`. Retrieval must never cross these boundaries accidentally.

## User Identity and Future Authentication

Design ownership now even though interactive login and OIDC are deferred. Use a stable, non-semantic internal UUID `user_id` as the application identity. Never use an email address, display name, username, OIDC `sub`, or provider-specific identifier as a primary or foreign key.

The first database migration must idempotently create one credential-free **initial user** identified by a stable system key such as `initial-owner`. The database generates and retains its UUID; every API and worker replica looks it up by that system key. Until authentication is implemented, the server assigns all created, generated, and imported content to this initial user. Do not accept an arbitrary `user_id` header, query value, or request field from the browser as proof of identity.

User-owned root records must have a non-null `owner_user_id`, including worlds, world versions where ownership is materialized, campaigns, assets, provider profiles, and imports. Operational and retrieval records such as memories, generation jobs, image jobs, and model chains must carry or reliably derive the same user scope so queries cannot cross ownership boundaries. Turns and other children must remain protected through their campaign relationship and database constraints.

Plan for these identity tables and constraints:

```text
users
  id UUID primary key
  system_key unique nullable
  display_name
  status
  created_at / updated_at

user_identities                added when authentication is implemented
  id UUID primary key
  user_id foreign key -> users.id
  provider
  issuer
  subject
  unique (issuer, subject)
```

OIDC identities must link to the internal user rather than replace it. When authentication is introduced, use an explicit administrative claim or configured migration to attach the intended OIDC `(issuer, subject)` to the existing initial user. Do not automatically grant all legacy content to whichever account happens to log in first. After the link succeeds, the same internal `user_id` continues to own all existing content without rewriting world, campaign, turn, or memory ownership.

Legacy browser saves and portable exports do not establish authorization. During the pre-auth phase, imports belong to the initial user. After authentication exists, imports belong to the authenticated user unless an administrator explicitly performs an ownership migration. Export formats may contain provenance but must not rely on a source-system `user_id` being valid in another installation.

Keep repository, service, and database APIs user-scoped from their first implementation even when only one user exists. This provides a clean future path to authorization, sharing, collaborators, and database row-level policies without a broad ownership backfill.

## Story Memory Model

Build prompts from three controlled scopes:

1. **World canon**: relevant facts from the campaign's immutable world version.
2. **Campaign canon**: structured current state, open threads, and relevant accepted events from this campaign.
3. **Current scene**: the latest action, present entities, current location, trackers, and recent verbatim turns.

The complete accepted turn ledger is the recovery source of truth. Summaries and embeddings are derived indexes, not canonical records. Use hybrid retrieval that can combine semantic similarity, entity and keyword matches, recency, chronology, and open-thread relevance.

Treat LM Studio `previous_response_id` as a short-term continuation and caching optimization. Scope every response chain to the campaign, world version, model, LM Studio endpoint or instance, prompt protocol version, and context configuration. Never reuse a chain across campaigns or worlds. If a chain is missing or incompatible, bootstrap a new one from database state and retrieved Chronicle memory.

## Generation Integrity

Story generation must be a durable, idempotent workflow such as:

```text
queued -> assessing -> generating -> validating -> indexing -> committed
                                  \-> recoverable or failed
```

Only validated, accepted output may mutate campaign state. Use database transactions and uniqueness constraints to prevent duplicate next turns. Persist enough job and LM Studio response metadata to resume, retry, or safely discard incomplete work after a browser, service, or model restart.

Illustration generation must run as an optional child job after the associated narration and fiction-only image prompt have passed validation. Image success or failure must not change whether the story turn is accepted. Persist image job status independently so it can be retried, replaced, or disabled without rerunning the story turn. Never send rolls, private reasoning, scratchpads, hidden trackers, raw model responses, or rejected narration to the image endpoint.

Keep mechanics and fiction in separate typed prompt paths. Rolls, dice, checks, stats, scores, targets, modifiers, difficulty labels, parser diagnostics, rejected output, and internal reasoning must never enter story narration, story memory, embeddings, or fiction-only prompt history. The Story Engine may pass only a sanitized diegetic outcome to the narrative model. Continue validating narrative output for mechanic leakage before display or persistence.

## Repository Structure and Migration Roadmap

Prefer TypeScript for new application services and shared packages so validated logic can move out of the current JavaScript without maintaining separate implementations. Record meaningful architecture changes as short ADRs under `docs/architecture/`. Do not leave undocumented scripts as the only way to operate the project. Keep JSON import and export as a portable backup and migration format even after the database becomes authoritative.

Target directory layout, how to run the legacy client standalone, and the 5-phase incremental migration plan: see [docs/architecture/repository-overview.md](docs/architecture/repository-overview.md#repository-structure).

## Coding and Contract Conventions

Match the existing two-space indentation across HTML, CSS, and TypeScript code. Use `camelCase` for JavaScript and TypeScript values, `PascalCase` for types and components, and `UPPER_SNAKE_CASE` for constants. Prefer `const`; use `let` only for reassignment. The legacy `index.html` is kept for reference only, no longer needs to be kept in parity with the new application, and should not undergo wholesale formatting or maintenance edits.

Define shared schemas for API payloads, database-derived events, model responses, and job states. Validate untrusted data at every boundary: browser to API, database to domain model, worker to LM Studio, and model output to accepted turn. Keep prompts versioned and make prompt-protocol changes explicit because they invalidate saved LM Studio chains.

Favor pure domain functions for state transitions, prompt assembly, retrieval ranking, and output sanitization. The API and worker should call the same shared implementations rather than duplicating rules.

## Testing Requirements

Every code change must include a review of the tests associated with each changed file. Update or add those tests whenever behavior, contracts, fixtures, or expectations change; do not consider the change complete until the related tests reflect it.

Tests must verify that rejected or incomplete generations do not mutate campaign state or Chronicle memory and that one campaign's data cannot appear in another campaign's prompt.
Tests must also cover images disabled, image endpoint unavailable, incompatible image models, independent image retries, and successful story completion when illustration generation fails.
Identity tests must verify initial-user bootstrap idempotency, automatic ownership of pre-auth content, import ownership, rejection of caller-supplied identity spoofing, cross-user query isolation, and explicit OIDC linking to the existing initial user without changing its internal UUID.

Manual test checklist (until automated infrastructure exists) and the required test-type matrix for new services: see [docs/workflows/testing.md](docs/workflows/testing.md).

## Deployment and Operations

Health checks, logging fields, migration safety rules, and rolling-update/rollback policy: see [docs/runbooks/deployment.md](docs/runbooks/deployment.md).

## Security

Never commit API keys, database credentials, exported private campaigns, or secrets. Until login or OIDC is implemented, restrict the web/API surface to the intended trusted network and consistently bind requests to the server-resolved initial user; this is a migration bridge, not authentication. Restrict text and image endpoints to trusted networks and allow only the API or worker paths that require them. Do not expose one provider's credentials to another provider or return either secret to the browser.

Treat imported worlds, rendered model output, prompt templates, MCP integrations, and generated HTML or Markdown as untrusted input. Preserve safe DOM rendering, schema validation, authorization checks, campaign/world ownership boundaries, and explicit tool allowlists. Do not allow an LLM or MCP tool to write authoritative world or campaign state without application validation and an auditable operation.

## Commit and Review Guidelines

Use short imperative commit summaries naming the affected domain or service. Keep schema, prompt-protocol, deployment, and unrelated UI changes in separate commits when practical. Pull requests must describe user-visible behavior, architecture impact, migration or rollback requirements, tests performed, and changes to models, prompts, schemas, secrets, or external APIs.

Before submitting, run the documented tests, check `git diff --check`, review the complete diff for unrelated changes, and include screenshots for visible UI changes.

<!-- Repowise's auto-generated "Codebase Intelligence" block was intentionally removed here on 2026-08-01 (editor_files.agents_md: false in .repowise/config.yaml — see AGENT_INSTRUCTIONS_AUDIT.md, Decision #5). It had gone stale the moment it stopped being refreshed, and stale architecture summaries are worse than none. The Repowise MCP tools (get_answer, search_codebase, get_context, get_risk, get_why, get_change_risk, get_health, get_dead_code) remain fully available regardless of this setting — call get_overview() for a live architecture map instead of reading a frozen one here. Build/test/dev commands: pnpm build / pnpm test / pnpm dev. -->

<!-- REPOWISE_AGENTS:START — Do not edit below this line. Auto-generated by Repowise. -->
## Codebase Intelligence for InfiniteQuest (Repowise)

Indexed by [Repowise](https://repowise.dev). Last indexed: 2026-08-16 (commit 87b4ddf). Confidence: 100%.
The MCP tools below serve pre-verified docs, symbols, history, and health from that index. Every response carries `_meta` freshness fields; a `stale_warning` appears only when a file the response actually serves changed after indexing, so silence means current.

### How to work in this repo

- **Pre-edit phase** (locate, understand, assess) is where these tools win: `get_answer` for how/where/why, `search_codebase` to find, `get_context` for a file's map, `get_risk` before touching a hotspot.
- **Edit phase**: reading a file before you edit it is correct and expected. Use these tools to decide *which* files to read and edit, not to replace that read.
- **Noisy commands** (tests, builds, `git log`/`diff`, searches, listings): prefer `repowise distill <cmd>`, the same command with its exit code preserved and errors-first compact output. A `[repowise#<ref>: N lines omitted]` marker is fully recoverable via `repowise expand <ref>` (add `-q <regex>` to filter); never re-run the command to see omitted output.

### Trust protocol

- `verified: true` means the served bytes were checked against the live tree. Never follow it with a re-read of the same lines.
- `get_answer` at `confidence: "high"` or `grounding: "extracted"` is content-grounded: cite it directly. `symbol_bodies`, `quotes`, and `code_rationale` entries are live source, so use them instead of opening the file.
- The **only** re-read triggers: `bounds: "approximate"`, `_meta.stale_warning`, `search_method: "bm25"`, `confidence: "low"`. `index_behind: true` alone is informational; the served content is unaffected by the drift.
- Not valid reasons to re-read: "just to be safe", "to see full context" (use the skeleton or a range read), "the file might have changed" (`verified` already checked).
- For exhaustive literal sweeps (rename every call site) plain text search is unbeatable, so use it. Reach for `get_context(include=["callers"])` when you need the `callers_total`/`callers_truncated` honesty signal instead of a maybe-incomplete grep.

### Tools

| Tool | When and why |
|------|--------------|
| `get_answer(question)` | First call for any how / where / why question. `confidence: "high"` or `grounding: "extracted"` is content-grounded — cite it directly. When the question names an indexed symbol, `symbol_bodies` carries its full live body (skip the `get_symbol` follow-up). Low confidence returns `best_guesses` with one-line justifications plus `code_rationale` (rationale comments mined live from candidate source). |
| `get_context(targets=[...])` | Triage card for files/modules/symbols: summary, signatures, `symbol_id`s, `hotspot` bit. File targets auto-serve a `verified` skeleton (every signature at a fraction of a full Read); `mostly_full` marks files where Read costs little more. Batch targets in one call. Opt-in blocks: `include=["callers"|"callees"|"ownership"|"decisions"|"metrics"]`. |
| `get_symbol(id)` | One verified body: `"path.py::Name"` (indexed symbol), `"path.py:140-180"` (live range read), or `"repowise#<hex>"` (omission ref). Source arrives in Read's numbered format — treat it as an already-performed Read. `truncated` responses carry a `continuation` naming the exact next range; ambiguous ids return every match in `candidates`. Index misses fall back to live-grep `fallback_lines`. |
| `search_codebase(query)` | Hybrid search, auto-routed by query shape: identifier → symbol hits (pipe `symbol_id` into `get_symbol`), path → file pages, prose → wiki-semantic. Force with `mode=symbol|path|concept|hybrid`. Concept hits carry a `sources` list; a hit whose sources are `[fts]` only is a keyword match with no semantic agreement — verify it. |
| `get_why(query, targets?)` | Why the code is shaped this way: decision records with evidence and supersession lineage, falling back to git archaeology and `code_rationale` comments. Call before refactors or pattern divergences. |
| `get_risk(targets, changed_files?)` | What history says about touching these files: churn, owners, co-change partners, blast radius. PR mode (`changed_files`) leads with a `directive` block — read `will_break` / `missing_cochanges` / `missing_tests` / `tests_to_run` first. `tests_to_run` is coverage-backed (the tests the per-test map proves exercise the changed files); empty means unknown, never no tests. To score a whole commit or diff range instead, use `get_change_risk`. |
| `get_change_risk(revspec, extensions?, exclude_patterns?)` | Pre-merge defect score for a whole commit or `base..head` range, computed from its diff shape on the live checkout (no index, no LLM). Lead with `risk_percentile` (this change ranked against sampled recent commits), summarized by `review_priority` and `classification`; `score` / `probability` / `level` are the corpus-calibrated fallback. Distinct from `get_risk`, which scores indexed files by path. A `warning` field flags an empty diff (bad revspec or over-tight extension / exclusion filters). |
| `get_health(targets?, include?)` | Health scores + findings on three dimensions (defect / maintainability / performance). Self-check the files you touched before finishing; `include=["biomarkers"|"refactoring"|"signals"]` for depth. |
| `get_dead_code()` | Confidence-tiered unreachable files / unused exports / zombie packages. For cleanup sweeps, not targeted fixes. |
| `get_overview()` | Architecture map + tool recipes. Call once, first, in an unfamiliar repo; skip it after that. |

**Compose them:** low-confidence `get_answer` then read `best_guesses[0].file`; `get_context` shows `hotspot: true` then `get_risk` before editing; `decision_records` titles then `get_why(targets=[...])`; PR review then `get_risk(targets, changed_files)` and read `directive` first. A `tombstone` error means the file moved, so follow `successor_paths`.

### Architecture
InfiniteQuest is a server-backed platform that consumes authored worlds, campaign actions, and model-provider requests, transforms them through validated domain, story-generation, persistence, and retrieval pipelines, and produces persistent campaigns, Chronicle records, world-management artifacts, and optional illustrations through web and API interfaces. The repository implements Infinite Quest Nexus, with the player-facing experience referred to as Infinite Quest. The system separates authoritative application state from language-model context. Worlds have immutable versions, campaigns evolve independently from their source worlds, and accepted story turns provide the canonical recovery ledger.

### Key modules
- `packages/logger/src` — The logging and illustration-provider layer is an application support boundary: it exposes structured logging, Chronicle processing…
- `packages/contracts/src` — The application data-contract layer is the shared TypeScript boundary between authored world and campaign data, API services, worker…
- `services/api/src` — The API service layer is the orchestration boundary for campaign-facing metadata, assets, state, transfers, character profiles, generation…
- `packages/domain/src` — I’m applying the required workflow guidance for this documentation task, then I’ll produce the page directly from the supplied subsystem…
- `packages/database/src` — The database lifecycle layer is the persistence boundary for connection configuration, pool creation, and schema migration: it consumes…
- `root` — Runtime composition is the hosting layer for Infinite Quest’s executable entrypoints, browser-facing assets, background worker startup…

### Entry points
- `services/api/src/server.ts`
- `services/runtime/src/main.ts`

### Files that need care (bug-fix history first, then churn — check `get_risk` before editing)
- `tests/integration/generation.integration.test.ts` — 12 bug fixes, last fix 4 days ago (bug magnet); 31 commits/90d
- `tests/integration/image-pipeline.integration.test.ts` — 11 bug fixes, last fix 7 days ago (bug magnet); 26 commits/90d
- `services/api/src/server.ts` — 11 bug fixes, last fix 10 days ago (bug magnet); 29 commits/90d
- `services/api/src/generation-service.ts` — 11 bug fixes, last fix 2 weeks ago (bug magnet); 47 commits/90d
- `tests/unit/web-next-world-editor-page.test.ts` — 8 bug fixes, last fix 3 days ago (bug magnet); 14 commits/90d

### Code health
Three co-equal signals: defect risk 6.53/10 avg, hotspot health 4.65/10 (stable), worst `packages/application/src/assets/private-filesystem-repository.ts` at 1.0/10 · maintainability 7.12/10 · performance risk 623 open static I/O-in-loop / N+1 findings. Detail: `get_health()`.

Critical files:
- `packages/application/src/world-campaign/types.ts` — change entropy — impact −3.0
- `packages/database/src/durable-filesystem-repository.ts` — change entropy — impact −2.5
- `tests/unit/client-api-routes.test.ts` — complex conditional (mockPool) — impact −2.5
- `packages/story-engine/src/providers/illustration/sogni/index.ts` — nested complexity (normalizeHttpError) — impact −2.4
- `tests/integration/campaign-authority-repository.integration.test.ts` — function hotspot (integration callback) — impact −2.3

### Commands
- Build: `pnpm build`
- Test: `pnpm test`
- Dev: `pnpm dev`

<!-- REPOWISE_AGENTS:END -->
