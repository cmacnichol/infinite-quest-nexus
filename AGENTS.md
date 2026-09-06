# Infinite Quest Nexus Repository Guidelines

## Project Goal

Infinite Quest Nexus is a self-hosted platform for creating reusable, versioned story worlds and running persistent AI-assisted campaigns within them. The platform must preserve authoritative world and campaign state independently of any LLM context window, model instance, browser session, or LM Studio response chain.

Text generation and image generation must be independent provider concerns. Story text uses the configured text-LLM endpoint, while optional illustrations use a separately configured compatible image endpoint with its own base URL, credentials, model inventory, selected model, health state, and retry policy. Never assume that the text endpoint also serves images or automatically reuse its credentials. A missing or unavailable image endpoint must disable or defer illustration work without preventing story generation.

Do not embed sample worlds, campaign records, accepted turns, story history, imported lore, or other user content in `index.html` or application source. Runtime world and campaign data belongs in the authoritative database; sanitized regression content belongs only in test fixtures. Legacy exports may be imported through explicit migration code but must not be silently bundled or restored by the client.

Before changing product terminology or deployment names, read [docs/architecture/repository-overview.md](docs/architecture/repository-overview.md).

## Target Architecture

Store database credentials, text-endpoint tokens, image-endpoint tokens, and other credentials as separate Docker Swarm secrets. Store non-sensitive endpoint and runtime settings in Swarm configs or environment configuration. Do not assume `host.docker.internal` is available from Swarm nodes.

Before changing service boundaries or runtime topology, read [docs/architecture/repository-overview.md](docs/architecture/repository-overview.md#target-architecture).

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

Use a stable internal UUID for application identity. Resolve the pre-auth initial user on the server; browser-supplied identifiers and imported provenance do not establish authorization. Preserve the existing initial-owner UUID and idempotent bootstrap behavior.

Keep root records owner-scoped and protect child records through scoped relationships and database constraints. Future OIDC identities must link explicitly to the existing internal user without transferring legacy ownership to the first login.

Before changing ownership, imports, identity bootstrap, or authentication, read [Identity and ownership](docs/concepts/identity-and-ownership.md), including the deferred OIDC design.

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

Prefer TypeScript for new application services and shared packages so validated logic can move out of the current JavaScript without maintaining separate implementations. Record system-wide architecture decisions under `docs/architecture/` and context-local decisions under the relevant context's `docs/adr/`, following [Domain docs](docs/agents/domain.md). Do not leave undocumented scripts as the only way to operate the project. Keep JSON import and export as a portable backup and migration format even after the database becomes authoritative.

Before changing repository layout or planning a legacy-client migration, read [docs/architecture/repository-overview.md](docs/architecture/repository-overview.md#repository-structure).

## Coding and Contract Conventions

Match the existing two-space indentation across HTML, CSS, and TypeScript code. Use `camelCase` for JavaScript and TypeScript values, `PascalCase` for types and components, and `UPPER_SNAKE_CASE` for constants. Prefer `const`; use `let` only for reassignment. The legacy `index.html` is kept for reference only, no longer needs to be kept in parity with the new application, and should not undergo wholesale formatting or maintenance edits.

Define shared schemas for API payloads, database-derived events, model responses, and job states. Validate untrusted data at every boundary: browser to API, database to domain model, worker to LM Studio, and model output to accepted turn. Keep prompts versioned and make prompt-protocol changes explicit because they invalidate saved LM Studio chains.

Favor pure domain functions for state transitions, prompt assembly, retrieval ranking, and output sanitization. The API and worker should call the same shared implementations rather than duplicating rules.

## Testing Requirements

Every code change must include a review of the tests associated with each changed file. Update or add those tests whenever behavior, contracts, fixtures, or expectations change; do not consider the change complete until the related tests reflect it.

Select tests for the affected behavior using the [test matrix](docs/workflows/testing.md): generation and retrieval changes require integrity and isolation coverage; illustration changes require independent-failure and retry coverage; ownership changes require identity and authorization coverage. Add OIDC linking tests when implementing that feature.

For visible UI changes, verify affected interactions in a rendered browser and include screenshots. Report checks as passed, failed, or skipped, with reasons for skips; distinguish unit evidence from real PostgreSQL, browser, and live-provider verification. For documentation-only changes, check links and the diff; application tests are needed only if executable behavior changes.

## Deployment and Operations

Before changing deployment manifests, secrets, database migrations, health checks, or shutdown and rollback behavior, read [docs/runbooks/deployment.md](docs/runbooks/deployment.md).

## Security

Never commit API keys, database credentials, exported private campaigns, or secrets. Until login or OIDC is implemented, restrict the web/API surface to the intended trusted network and consistently bind requests to the server-resolved initial user; this is a migration bridge, not authentication. Restrict text and image endpoints to trusted networks and allow only the API or worker paths that require them. Do not expose one provider's credentials to another provider or return either secret to the browser.

Treat imported worlds, rendered model output, prompt templates, MCP integrations, and generated HTML or Markdown as untrusted input. Preserve safe DOM rendering, schema validation, authorization checks, campaign/world ownership boundaries, and explicit tool allowlists. Do not allow an LLM or MCP tool to write authoritative world or campaign state without application validation and an auditable operation.

## Commit and Review Guidelines

Use short imperative commit summaries naming the affected domain or service. Keep schema, prompt-protocol, deployment, and unrelated UI changes in separate commits when practical. Pull requests must describe user-visible behavior, architecture impact, migration or rollback requirements, tests performed, and changes to models, prompts, schemas, secrets, or external APIs.

Before submitting, run the documented tests, check `git diff --check`, review the complete diff for unrelated changes, and include screenshots for visible UI changes.

## Agent Working Practices

### Task Execution & Autonomy

- For implementation or fix requests, carry the authorized work through implementation and relevant verification. Do not stop at a proposed plan when you can proceed.
- Make reasonable assumptions for routine, reversible decisions. Ask a focused question when missing information materially affects correctness, scope, or authorization.
- Continue with authorized read-only actions, local worktrees, branch edits, and appropriate tests without repeatedly asking.
- Before requesting approval, finish the preparation that is already authorized and present a concrete, reviewable result.
- Respect required approval gates. Ask before destructive, irreversible, or otherwise unauthorized actions.
- Avoid boilerplate warnings about hypothetical risks. Explain concrete blockers or material risks when relevant.

### Instruction Conflicts

- Explicit user instructions take precedence over conflicting skill guidelines, subject to higher-priority instructions and actual permission boundaries.
- If a skill causes a pause or deviation, identify the file and relevant rule, and explain whether it is an explicit requirement or your interpretation. Continue any unaffected authorized work.

### Style & Output

- Lead with the result. Use plain language, active voice, and concise paragraphs. Include technical details that help assess the work.
- Use lists when they improve readability; avoid repetitive transitions and stock phrases such as "it's worth noting", "delve", "leverage", and "Bottom line".
- Report what changed, what was verified, and any remaining uncertainty.

### Verification

- Match verification to the scope and impact of the change. Complete required checks; expand testing when a concrete unresolvedconcern justifies it.

## Agent skills

### Issue tracker

Before creating or updating GitHub issues for `cmacnichol/infinite-quest-nexus`, read [Issue tracker](docs/agents/issue-tracker.md).

### Triage labels

Before assigning triage labels, read [Triage labels](docs/agents/triage-labels.md) and use the five defaults without aliases.

### Domain docs

Before exploring a domain or changing domain documentation, read [Domain docs](docs/agents/domain.md), then the relevant context map and context documentation.

## Documentation and tools

Before changing scene-context assembly or tracker handling, read the [scene-context and mechanics review note](docs/architecture/scene-context-mechanics-review.md). The note records an open review question; existing mechanics-separation safeguards remain in force.

Use verified tool output without redundant reads. Inspect current source when evidence is incomplete, contradictory, or insufficient for the task. If code-intelligence tools are unavailable, use direct repository searches.
