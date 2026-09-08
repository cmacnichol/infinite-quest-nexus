# AI Assist Implementation Roadmap and Design

**Status:** Proposed implementation plan; no implementation is authorized by this document alone.
**Source revision inspected:** 707baa8cd8eab704a8d5202e99c5a7ce2b7201c7.
**Requested delivery:** Implement one patch at a time. Finish its review and verification gate, then stop. Do not start the next patch until the user requests it.

## Reading order and execution boundaries

| Order | Plan | Agent tasks | Deliverable |
| --- | --- | --- | --- |
| 1 | [Generation reliability](2026-09-06-ai-assist-patch-1-reliability.md) | P1.1–P1.7 | Correct prompts, bounded repair, meaningful completion checks, useful errors |
| 2 | [Durable authoring](2026-09-06-ai-assist-patch-2-durable-authoring.md) | P2.1–P2.10 | Recoverable jobs, stage retries, browser resumption, explicit atomic apply |
| 3 | [World from story](2026-09-06-ai-assist-patch-3-story-source.md) | P3.1–P3.9 | Source intake, evidence review, selected roster, portable source provenance |

These are three independent delivery checkpoints and three separate PR scopes. Patch 2 depends on an accepted Patch 1; Patch 3 depends on an accepted Patch 2. Patch 1 must work with the current database and request/response endpoints. Do not bundle later-patch scaffolding into Patch 1.

Each task is intended for one agent work session, normally 1–3 hours including focused tests and review. These are sizing estimates, not deadlines. A task must end with a reviewable diff and its own verification evidence; do not hand off half a schema or an incompatible public interface. Follow the listed order by default. “Agent-sized” does not authorize spawning tasks, agents, merging, deployment, or modifying another checkout.

For each task, give the implementer this roadmap, the patch plan, the task identifier, the patch's current commit, and prerequisite task handoffs. Require a handoff listing changed files, produced interfaces, RED/GREEN commands and results, skipped checks, remaining risks, and commit SHA if a commit was requested. Re-read live source before implementing because this reference revision will move.

## Design requirements shared by every patch

1. PostgreSQL owns authoritative worlds and campaigns. AI results remain untrusted proposals until explicit human application through existing schema, ownership, and revision boundaries.
2. Manual incomplete drafts remain valid. Generation completion, content validity, and campaign readiness are separate checks.
3. New and existing world characters use the same generated-character validator and application-owned IDs. Profile organization is evidence-preserving transformation, not creative generation.
4. World versions and existing campaign snapshots are immutable. No authoring job writes accepted turns, campaign state, Chronicle memory, or embeddings.
5. Only the effective text provider executes these tasks. Illustrations remain independent and optional. Never copy credentials between roles.
6. Customized prompts may change creative guidance but cannot remove the code-owned output contract, evidence rules, or untrusted-input boundary. Version changed authoring protocols without rewriting historical metadata.
7. No silent truncation of user source, no invented “unknown” facts to satisfy a validator, and no raw model output or reasoning stored in world content.
8. Keep the current two-space TypeScript style and application/domain/database/runtime boundaries. Export new public contracts through existing package entry points.
9. Preserve unrelated work. The review began with an unrelated untracked .ci-linux-task-14e2c.sh; recheck current status and do not stage it.
10. A patch completion gate is not permission to merge, deploy, or start the next patch. Report blocked or skipped runtime checks honestly.

Required repository readings before execution:
- [Repository guidelines](../../../AGENTS.md)
- [Domain guidance](../../agents/domain.md)
- [Architecture and service boundaries](../../architecture/repository-overview.md)
- [Roster and incomplete-draft decision](../../architecture/0014-roster-only-world-character-guidance.md)
- [Reviewed character authoring](../../architecture/0016-reviewed-character-authoring.md)
- [Identity and ownership](../../concepts/identity-and-ownership.md)
- [Test matrix](../../workflows/testing.md)
- [Deployment and migration requirements](../../runbooks/deployment.md)

ADR 0014 describes schema version 4 historically; current source uses version 5. Do not restore the old constant or rewrite old published JSON. Patch 3 explicitly plans the next content-schema version for its new source appendix.

## Current evidence and intended corrections

The review ran 257 existing unit tests in 11 files, all passing. A separate in-memory probe of production functions established:

| Observed behavior | Required correction | Task |
| --- | --- | --- |
| Shipped character prompt omits the nested profile schema present in fallback code | Mandatory schema in every effective prompt | P1.2 |
| Non-truncated wrong profile type returns 502 after one call | One repair for syntax, shape, or completeness failure | P1.3–P1.4 |
| Generated name plus empty profile is accepted | Generated-content semantic minimum, distinct from storage schema | P1.1 |
| Organizer evidence aliases throw ZodError with zero repair calls | Safe alias normalization plus structural/evidence repair | P1.5 |
| One failed child rejects entire world preview | Keep validated stage results and retry the failed stage | P2.2–P2.4 |
| Generic UI failure hides useful diagnosis | Typed sanitized failures, stage and field display | P1.6 |
| Concept-only input has a 20,000-character limit and mandatory 3–4 seeds | Explicit source mode, bounded complete intake, chosen roster | P3.1–P3.7 |

The synthetic probes did not identify the user's exact live provider response. No live-model completion or database/browser verification was established by that review. Preserve this distinction in subsequent reports.

The existing [organizer repair plan](2026-08-23-character-profile-organizer-contract-fix.md) is a source of requirements. For this initiative, P1.5 replaces its execution sequence and includes world and campaign organizer regression coverage. Do not implement both plans independently or duplicate protocol changes.

## Decisions fixed for implementation

### Patch 1: Response reliability

- Storage schemas stay compatible. A generated creative character needs a nonempty name, story role, background, and at least one motivation, goal, or narrative hook. Appearance remains optional when unknown. A source-derived character in Patch 3 instead needs a name and at least one supported story fact; it may not invent the creative minimum.
- Exactly one content-repair call per stage. Initial request and repair each permit one additional transport attempt for typed 429/502/503/504 or timeout/connection failures. Honor Retry-After up to 5 seconds; otherwise use 1 second. No retries for authentication, network-policy rejection, response-size limit, or other permanent errors. Four provider calls is the hard per-stage ceiling.
- A typed timeout can be ambiguous: a provider may have performed work already. Provider costs are not exactly-once. Never describe application idempotency as guaranteeing exactly-once model execution.
- Do not add provider-specific structured-output APIs in Patch 1. A shared mandatory contract and validation/repair must work through the existing provider abstraction. Native constrained decoding can be evaluated separately.
- Error codes, stage identifiers, and field paths are allowlisted; issue messages are application-authored. Do not echo rejected text, provider endpoint URLs, credentials, quotes, or arbitrary exception messages.

### Patch 2: Durable proposals

- Introduce an authoring application context and two tables: authoring_jobs and authoring_job_stages. They hold operational proposals, not published canon.
- Owner-scoped idempotency keys bind to a canonical request hash. A repeated identical submission returns the same job; changed content with that key returns 409.
- Statuses: queued, running, awaiting_review, recoverable, failed, cancel_requested, cancelled, applied, expired.
- Stage outputs are checkpointed independently. Review remains possible after a child fails. Never weaken validation merely to mark a broken stage complete.
- Lease duration uses the existing worker lease configuration; heartbeat interval is at most one third of the lease. Every checkpoint uses lease token, job generation, and stage generation fencing. Provider calls run outside database transactions.
- Add one authoring optional lane of capacity 1 per worker, after the existing optional lanes, preserving story priority and service of illustration, Chronicle, asset, and System Archive lanes.
- Cancellation is persistent. Stop before new calls and reject late results after cancellation or lease loss. An already-started provider call may run until its existing timeout if the provider abstraction cannot abort it.
- Keep old synchronous preview endpoints working during rollout. New endpoints drive the replacement UI; legacy endpoints share Patch 1 validation. Do not change legacy index.html.
- Active input and un-applied proposals expire after 7 days of inactivity. Reading/polling does not extend retention; edits, retry, and review do. Explicit discard deletes sensitive proposal payloads. Applied jobs retain only an owner-scoped receipt and request hash for 30 days. Cleanup uses bounded batches and never deletes applied world content.
- System Archive excludes these operational tables; Disaster-Recovery Backup retains database contents. Explicitly document this behavior.
- Resume must survive API/worker restarts and browser refresh. A separate owner-scoped “Resume AI Assist” list handles lost browser session keys. Never automatically overwrite newer local edits.

### Patch 3: Source-grounded world construction

- Input: pasted text or one UTF-8 TXT/Markdown file, at most 1 MiB in UTF-8 and at most 200,000 Unicode code points. Reject malformed UTF-8, NULs, binary files, empty sources, and over-limit input with actionable errors. No PDF, DOCX, OCR, URL crawling, or multiple-file import in this patch.
- Normalize BOM and line endings once; preserve other text. Compute SHA-256 over normalized UTF-8. Paragraph IDs and code-point offsets refer to this retained representation.
- Faithful extraction is the default. Expansion is an explicit user choice. Every extracted fact cites exact retained text; inferred and invented candidates are separate categories and require explicit acceptance.
- User chooses a source boundary by paragraph. Extract only through that boundary; facts after it never enter starting canon, even indirectly through model context. Default is the end of the supplied text and is visible before generation.
- Use provider-aware input budgeting, accounting for system contract, source wrapper, output reservation, and repair context. Prefer an available verified token counter; otherwise use UTF-8 byte count as a conservative bound with a 20% context safety margin. Reject impossible budgets before a provider call.
- Chunk on paragraph boundaries; split oversized paragraphs into code-point ranges. Adjacent chunks may share one paragraph when budget permits. Deterministic coverage checks ensure every selected source character is accounted for. No silent dropping of chunks or extracted facts.
- Maximum 200 extraction chunks. If the budget would exceed this, return source_requires_larger_context with the required chunk count; do not process only the first 200.
- Select 0–20 playable characters in source mode. Unselected people remain lore entities. Zero-character drafts remain valid but not campaign-ready.
- Store accepted source and evidence as an optional typed WorldContent.sourceMaterial appendix; bump the current content schema from 5 to 6 without rewriting old versions. Operational rejected responses, prompt snapshots, and job state never enter that appendix.
- Source appendix is user-authored portable authority: retained normalized source, source hash, paragraph map, accepted fact references, provenance categories, and selected boundary. Its bytes count toward world/archive limits. It must round-trip through world, campaign, and System Archive flows.
- Prompt assembly must use explicit canon projections; do not serialize sourceMaterial wholesale into Story Engine, organizer, illustration, or embedding input. Approved extracted facts can be used as ordinary canon.
- Citation matching establishes textual support, not proof of semantic entailment. Human review is required for the source-to-fact interpretation and any conflicts.

## Verification conventions

Run tests from the selected implementation checkout. Use actual focused filenames from each task.

    node node_modules/vitest/vitest.mjs run tests/unit/authoring-output.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'

For real database coverage, use the dedicated integration configuration, never an unconfigured direct run:

    node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/authoring-jobs.integration.test.ts

The example filenames above are planned files, created by the corresponding tasks. A missing test file must not be silently ignored. Root scripts currently provide pnpm check, pnpm build, pnpm test:unit, and pnpm test:integration. If nested worktrees exist, pass both exclusions to unit runs.

Browser tests using routed fixtures establish rendering and client behavior only. Real PostgreSQL plus a deterministic HTTP provider establishes server integration. A live-provider smoke run establishes only the provider/model/version exercised. Report these evidence classes separately.

## Completion record template

For every task and patch, record:

    Task / patch:
    Starting revision:
    Changed files:
    RED command and observed failure:
    GREEN command and result:
    Database evidence:
    Browser evidence and screenshot paths:
    Live-provider evidence:
    Diff / build / boundary checks:
    Remaining limitations:
    Commit or review reference, if requested:

Planning-only changes require local-link and diff validation; application tests are not needed until implementation begins.

