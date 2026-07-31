# Product UX Specification — Infinite Quest Nexus

This is the authoritative UX specification for the replacement frontend. It
preserves every product requirement and API contract found in
`FEATURE_IMPLEMENTATION_MATRIX.md` and `API_UI_CONTRACTS.md` while defining
the interaction model a coding agent should build without inventing
fundamental behavior. Screen-by-screen detail lives in
`SCREEN_INVENTORY.md`; this document defines the principles, models, and
cross-cutting behavior those screens must follow.

## Adapting the review paradigm

This audit's source template assumes a document-review product (findings,
severity, confidence, citations, human adjudication). Infinite Quest Nexus
is an AI campaign/story-generation platform, not a document-review tool —
confirmed in Phase 0 (`REPOSITORY_UI_MAP.md` "Product identity"). Rather
than force-fitting that vocabulary, this spec maps each template concept to
its real analog, or states plainly that no analog exists:

| Template concept | Infinite Quest Nexus analog | Notes |
|---|---|---|
| Document / subject content | World, World Version, Campaign, Turn | Four distinct entities, not one — see §Domain terminology |
| Deterministic check vs. AI-generated finding | *No analog.* Generation output is validated (schema, mechanics-leak detection) before it can be accepted, but this is a pass/fail gate on the one AI output, not two parallel check types being compared | Do not build a "deterministic vs. AI" toggle anywhere — nothing in the product distinguishes checks this way |
| Finding severity (Critical/High/Medium/Low/Informational) | *No analog.* No entity in this product is scored/ranked by severity | Do not invent a severity system |
| Finding confidence (High/Moderate/Low) | Provider **health status** (`unknown`/`healthy`/`degraded`/`unavailable`, `provider-service.ts:62-85`) is the closest structural analog — but it describes a provider connection, not an AI output's certainty | Model provider health as its own small status system; do not conflate with job status |
| Review status (Unreviewed/Confirmed/Dismissed/…) | Generation-job status (`queued→…→completed` / `recoverable` / `failed` / `discarded`) is the closest analog — `recoverable` is genuinely "needs a human decision" | See §Status model below; treat `recoverable` as the one true "needs your attention" state in this product |
| Citations / evidence panel | Turn history (accepted-turn ledger), cost-summary line items, and Chronicle context preview all carry enough IDs to trace a result to its source | Not a formal citation system, but the traceability principle still applies — see §Citation-equivalent traceability |
| Human adjudication of AI output | ADR 0016 reviewed character authoring (explicit save-before-persist) is the **one** place a human must approve AI output before it's canonical | Everywhere else, generation output becomes canonical automatically once it passes validation — this is by design (`docs/concepts/generation-integrity.md`), not a gap |

## Product UX principles

1. **Staged operations are visually staged, not just backend-staged.**
   Every operation that already uses a preview→commit API pattern (cross-
   world transfer, illustration backfill, world/Infinite-Worlds import,
   retry-latest turn replacement) must show the user a distinct preview
   step in the UI before the committing action, and must never present the
   preview and the commit as the same click.
2. **Recoverable is not failed, and failed is not silent.** A `recoverable`
   job always presents an explicit retry/discard decision to the user, with
   the error reason in plain language. A `failed`/`discarded` job is never
   presented identically to a `completed` one. No job status may ever be
   communicated by color alone.
3. **Immutability boundaries are visible.** A published world version, an
   accepted turn, and campaign history before a rewind/branch point are
   immutable. The UI must make clear when an action would cross one of
   these boundaries (e.g., "deleting this version is permanent and its
   number will never be reused"; "rewinding will discard turns after this
   point").
4. **Generation scope is always stated before the user commits provider
   spend.** Because every generation call (text, image, embedding) can
   incur real provider cost (`docs/nexus-guide/campaigns/configure.md:14`),
   the UI must state which provider/model will be used and, where the
   provider reports pricing, an estimate — before the user triggers a
   costly action, not just after.
5. **World, world version, and campaign context is never ambiguous.** Every
   screen that shows campaign or turn data must show which world version it
   is pinned to; every screen that shows world data must show whether it is
   an editable draft or an immutable published version.
6. **Single-owner, pre-authentication is a deliberate constraint, not a
   missing feature.** Do not design a login screen, a user switcher, or any
   UI implying multi-tenant access — see §User roles.
7. **Progress on long-running work survives a page reload.** Every
   long-running job the UI initiates (generation, illustration, Chronicle
   reindex, world/Infinite-Worlds import) must be resumable/re-observable
   after a refresh, matching the durable-job backend model — except the
   one documented gap (Infinite Worlds import progress, `UI-004` in
   `CURRENT_UI_AUDIT.md`), which the UI must communicate honestly rather
   than pretend is durable.

## User roles

**Single role: the campaign owner/operator.** There is no multi-user, no
admin-vs-player distinction, and no login (`docs/operations/security.md:3`;
`README.md:122`). The application resolves every request server-side to one
database-backed `initial-owner` (`packages/database/src/pool.ts:33-40`).
`GET /api/v1/session` returns `{authentication: "deferred"}` by design.

The replacement UI must:
- Not present any login/auth screen or user-switcher.
- Still model **future-compatibility for identity** — per `AGENTS.md:88-119`'s
  documented (not yet implemented) plan for an eventual `user_identities`/OIDC
  design — by keeping the app shell's user-context area (`nexusUserProfileDialog`/`userProfileDialog`
  equivalent) as a distinct, addressable region, so auth can be added later
  without restructuring navigation. See `FRONTEND_IMPLEMENTATION_PLAN.md`.
- Treat "the user" as simultaneously the World Library curator, the
  Campaign operator, the Provider administrator, and the Story Player —
  one person wearing all these hats, not separate personas needing separate
  UIs.

## Primary user goals

1. Build and maintain a **library of reusable worlds**, moving each through
   draft → published version → (optionally) forked/archived.
2. Run one or more **campaigns**, each pinned to a specific world version,
   generating turns and watching the story unfold.
3. Keep **Chronicle memory** healthy so long campaigns retain coherent
   long-term context.
4. Configure and monitor **AI providers** (text, intent, embeddings,
   illustrations) — a prerequisite for everything else.
5. Track **provider-reported cost** per campaign, by category.
6. **Import/export** worlds and campaigns for portability and backup.
7. Recover cleanly when a generation or illustration job needs attention.

## Information architecture

Three top-level areas, replacing the current hash-view-in-one-page model
(`REPOSITORY_UI_MAP.md` §3) with real routes:

```
/                      → Dashboard
/worlds                → World Library (list)
/worlds/:worldId       → World detail (draft + version history)
/campaigns             → Campaign list
/campaigns/:campaignId → Campaign detail (config, cost, state, history)
/providers             → Provider management
/prompt-library        → Prompt library
/play/:campaignId      → Story Player (the "Infinite Quest" experience)
```

Rationale: the current app conflates "World Library" and "Imports" into one
hash-view (`REPOSITORY_UI_MAP.md` §3) and treats Nexus↔Story Player as two
unrelated documents with no shared shell. The replacement should give
Imports its own addressable location (`/worlds/import` and
`/campaigns/import`, since import targets differ) and keep one persistent
application shell across Nexus and Story Player so campaign/world context
doesn't reset on navigation (see `FRONTEND_IMPLEMENTATION_PLAN.md` for
whether this requires converging the two pages into one SPA).

## Navigation model

- **Primary navigation** (persistent shell): Dashboard, World Library,
  Campaigns, Providers, Prompt Library — a peer of the current
  `.universal-nav` bar (`navigation.css`), generalized to real routes.
- **Secondary navigation**: within a World or Campaign detail screen, tabs
  for the sub-areas currently modeled as separate dialogs (World: Overview /
  Draft Editor / Version History / Characters; Campaign: Overview / State /
  Cost / Chronicle / History).
- **Breadcrumb behavior**: World Library → World Name → Version N; Campaigns
  → Campaign Name — always shows the pinned world version for a campaign
  screen (Principle 5).
- **Story Player** is reachable from a campaign's card/detail ("Play") and
  is its own focused, minimal-chrome experience — it should keep the
  universal nav bar (for "back to Nexus") but not the full secondary nav.
- **Search and filtering**: today, search is client-side substring
  filtering on two dashboard carousels only (`nexus.js:573-574,648-649`,
  `REPOSITORY_UI_MAP.md` §"Search and filtering"). Preserve this for World
  Library and Campaign list screens; do not invent server-side search
  unless `OPEN_QUESTIONS.md`'s question on data-volume growth is answered
  affirmatively.
- **User controls**: profile/settings dialog remains a persistent
  shell-level control (top-right), not a full page — matches current
  placement (`nexusUserProfileDialog`).
- **Notification patterns**: toast for transient confirmations/errors
  (adopt `story.js`'s toast pattern app-wide, retiring the separate banner
  pattern per `CURRENT_UI_AUDIT.md` UI-010), persistent inline status for
  anything requiring a decision (a `recoverable` job, a blocked migration).
- **Analysis-status indicators** (job status, in this product's vocabulary):
  a persistent, dismissible indicator in the shell when any job on the
  currently-open campaign is `generating`/`recoverable`, so a user who
  navigates away and back doesn't lose track of in-flight work.
- **Page-width/density**: preserve `story.css`'s ~1120px max content width
  for narrative reading; management screens (World/Campaign/Provider lists,
  tables) may use full width up to a larger cap — formalize both as tokens
  (`DESIGN_SYSTEM.md`).

## Core workflows

See `INTERACTION_FLOWS.md` for step-by-step detail on each of these. Listed
here for IA completeness:

1. Create/edit/publish a world; author playable characters (with AI
   assistance + explicit review, ADR 0016).
2. Create a campaign from a published world version; configure it.
3. Play: submit a turn (Action/Scene/Auto), watch generation progress,
   receive the narration, optionally view/regenerate illustrations.
4. Recover a `recoverable`/`failed` generation or image job.
5. Inspect and maintain Chronicle memory (metrics, context preview,
   reindex, embedding config).
6. Configure providers (text/intent/embeddings/illustrations); monitor
   health.
7. Track campaign cost by category.
8. Import/export worlds and campaigns.
9. Migrate a campaign to a newer world version, or transfer it to a
   different world (preview → commit).
10. Rewind or branch a campaign from an earlier turn.

## "Analysis modes" (generation-scope selection)

Mapped from the template's analysis-configuration section to this product's
real generation-scope choices, all of which must be stated before the user
commits:

- **Turn input mode**: Action / Scene direction / Auto (resolved
  server-side to Action or Scene before job creation — ADR 0021). The UI
  must show which mode was actually resolved once Auto is chosen, not just
  the word "Auto" indefinitely.
- **New turn vs. retry-latest (replace)**: see Principle 1 — must be
  visually distinct (`CURRENT_UI_AUDIT.md` UI-006).
- **Illustration scope**: per-segment regeneration vs. full backfill
  (preview → commit) — the backfill preview must state how many
  turns/segments will be affected before the user commits.
- **Chronicle reindex / embedding reindex scope**: campaign-wide only (no
  partial-scope option exists in the API — do not add one to the UI without
  a corresponding backend capability).
- **Provider selection**: which provider/model will service a generation
  call, shown before submission wherever the API allows explicit provider
  selection (`generationRequestSchema`), falling back to "using your
  default {role} provider: {name}" when not explicit.

## Screen specifications

Full per-screen detail (purpose, entry points, data, API deps, states,
responsive/a11y requirements, acceptance criteria) is in
`SCREEN_INVENTORY.md`. This section states only the screen list and how it
maps to the required-screens checklist from the audit template:

| Template's generic screen | This product's screen |
|---|---|
| Review dashboard | Dashboard |
| Document library | World Library |
| Add/select document | World create/import flow |
| Document detail | World detail |
| Document-version history | World version history |
| Start-analysis workflow | Start-turn-generation (Story Player input) |
| Analysis configuration | Turn-input-mode + provider selection (inline, not a separate screen) |
| Analysis progress | Generation-job progress (inline in Story Player) |
| Analysis result summary | Turn result / narration display |
| Finding list | Recoverable/failed job indicator (not a list screen — see below) |
| Finding detail | Job recovery panel (retry/discard with error detail) |
| Source-document viewer | Turn history / accepted-turn ledger |
| Section comparison view | *No analog* — not applicable |
| Proposed-change comparison view | Campaign world-version migration / transfer preview |
| Cross-reference impact view | Cross-world transfer preview |
| Contradiction review view | *No analog* — not applicable |
| Reviewer work queue | *No analog exists today* — see `OPEN_QUESTIONS.md` on whether a cross-campaign "needs attention" queue is in scope |
| Review history | Turn history + campaign activity |
| Export and report view | World/Campaign export |
| Settings/administration | Provider management, User profile/settings, Prompt library |
| System error/unavailable states | Global error boundary + `/health` unavailable state |

Additional screens this product needs that the generic template doesn't
name: **Campaign detail** (config/state/cost/Chronicle tabs), **Story
Player** itself, **Chronicle health**, **Provider detail/edit**.

## Domain terminology

Use exactly the terms already established in the product's own docs
(`AGENTS.md:75-86`, `docs/concepts/*.md` — see `REPOSITORY_UI_MAP.md` §1 for
sources). Do not introduce synonyms in the replacement UI copy:

- **World** — a reusable authored project: one mutable draft + a history of
  immutable published versions.
- **World Version** — an immutable, numbered snapshot of a world's lore,
  rules, entities, relationships, triggers, assets, and defaults; numbers
  are never reused, even after deletion.
- **Campaign** — a mutable story instance created from exactly one world
  version; owns its character snapshot, state, accepted-turn ledger, jobs,
  Chronicle, and assets.
- **Turn** — an accepted (committed) unit of story: player action +
  validated narration + accepted state transition. Append-only.
- **Campaign state** — the current mutable facts produced by accepted
  turns (trackers, scratchpad, RPG stats).
- **Chronicle** — the campaign-scoped derived memory system built from
  accepted fiction (recent turns, canonical facts, open threads, optional
  semantic retrieval). Rebuildable; the accepted-turn ledger is its
  recovery source of truth.
- **Story Engine** — the durable job pipeline coordinating mechanics
  assessment, prompt construction, provider calls, validation, recovery,
  and memory indexing.
- **Provider Profile** — a user-owned, role-scoped (text/intent/embeddings/
  illustrations) configuration for an external AI endpoint.
- **Action / Scene direction / Auto** — the three turn-input modes (see
  above).

## Status model (generation/job lifecycle)

This is the product's real "status model," replacing the template's
document-analysis status list:

| Status | Meaning | Visual/textual treatment requirement |
|---|---|---|
| Not started | No job exists yet for this turn/action | Neutral, input-ready state |
| `queued` / `replacement_queued` | Job accepted, not yet claimed by a worker | Indeterminate progress indicator + text label, never color-only |
| `assessing` → `generating` → `validating` → `committing` | In-flight stages | Progress indicator with stage label (mirrors `docs/concepts/generation-integrity.md`'s "Reading state / Resolving action / Writing scene / Saving turn" framing) |
| `completed` | Accepted, canonical | Success treatment; content now appears in turn history |
| `recoverable` | Validation/output issue; **requires a human decision** | Distinct, non-error-red treatment (this is not a failure, it's a decision point) + explicit retry/discard controls + plain-language reason |
| `failed` | Hard failure, no partial output usable | Error treatment + retry/discard controls |
| `discarded` | User explicitly discarded a recoverable/failed job | Neutral/archived treatment, distinguishable from `failed` |

Equivalent status sets exist for image jobs (`queued/generating/
provider_pending/downloading/completed/recoverable/failed/cancelled/
expired`) and Chronicle jobs (`queued/running/completed/failed`) — apply the
same visual language (progress → success / recoverable-decision / failure),
scaled to each job type's actual state set. **Status must never be
communicated by color alone** — always pair color with an icon and/or text
label (see `ACCESSIBILITY_SPEC.md`).

## "Severity"/"confidence"/"review status" — explicit non-application

Per §Adapting the review paradigm: **do not build a severity or confidence
badge system** — no entity in this product has either concept. The one
place a three-state "outcome" model applies is generation/image/Chronicle
job status (above). Provider health (`unknown/healthy/degraded/
unavailable`) is a separate, smaller model — present it only on provider
list/detail screens, never conflated with job status badges.

## Finding-equivalent presentation: the recovery panel

When a job is `recoverable` or `failed`, present (mirroring the template's
finding-detail model, adapted):
- Plain-language reason (from `errorMessage`/`errorCode`, `generation-service.ts`
  job fields).
- Which turn/action triggered it.
- Whether retrying will re-attempt with the same input or require the user
  to resubmit.
- Discard as a clearly-separate, non-destructive-to-history action (a
  discarded job never becomes a turn; it doesn't delete any *accepted*
  turn).
- No fabricated "confidence" score — only what the API actually returns.

## Citation-equivalent traceability

Wherever the UI shows a derived value, make its source traceable:
- Cost-summary line items → the turn/job that generated the cost
  (`cost-service.ts` FKs to `generation_job_id`/`image_job_id`/
  `chronicle_job_id`/`turn_id`).
- Chronicle context-preview entries → their source turn/canonical-fact.
- Campaign state values → the turn history (link state changes back to the
  turn that produced them where the API supports it).

## Reviewer-decision behavior (adapted)

The only true "approve AI output" decision in this product is **ADR 0016
character review**: AI-generated candidate character fields must be shown
to the user with an explicit "Save" action; nothing may auto-persist. Model
this as a genuine review step (diff-style presentation of populated fields,
explicit accept) — this is the pattern to reuse if any future feature adds
another human-adjudication point, per Principle 1's staging philosophy.

Everywhere else, "review" means the retry/discard decision on a
`recoverable` job (see above) — there is no accept/reject step for
already-`completed` turns; editing history is done through rewind/branch
instead (explicit, destructive/branching operations — Principle 3).

## Error-recovery principles

- Every API error surfaces the correlation ID when present (mirroring
  `nexus.js`'s existing structured-error pattern — the one piece of current
  error handling worth generalizing app-wide, per `CURRENT_UI_AUDIT.md`
  UI-005).
- A failed poll/stream connection is its own visible state, never silence
  (fixes `CURRENT_UI_AUDIT.md` UI-003).
- A durability gap (like the Infinite Worlds import progress issue, UI-004)
  must be disclosed in the UI copy, not hidden behind a generic spinner.
- Network/API-unreachable state at the shell level (health-check failure)
  shows a distinct "can't reach the server" screen, not a blank or
  per-widget failure.

## Responsive behavior

- Story Player must remain fully usable (read narration, submit a turn,
  view illustrations) at the mobile breakpoint (390×844) — it is the
  player-facing core experience.
- Nexus management screens (World/Campaign/Provider CRUD, cost tables,
  Chronicle settings) may progressively simplify at mobile width toward
  status-checking and light triage (view lists, open detail, resume a
  campaign into Story Player) rather than guaranteeing full desktop parity
  for every configuration form — consistent with how dense the current
  desktop-oriented forms already are (`CURRENT_UI_AUDIT.md` UI-007).
- Use one shared breakpoint scale everywhere (see `DESIGN_SYSTEM.md`),
  fixing `CURRENT_UI_AUDIT.md` UI-007.

## Accessibility requirements

Full detail in `ACCESSIBILITY_SPEC.md`. Summary requirements this spec
imposes directly:
- Every form control has a real associated `<label>` (fixes UI-002) —
  no exceptions for dialog-embedded forms.
- Every async/long-running state change (job status, poll result) is
  announced via an ARIA live region — extend Nexus's existing pattern
  (`aria-live="polite"` on dashboard stats/carousels) to Story Player,
  which currently has materially fewer live regions.
- `prefers-reduced-motion` is honored globally, not per-stylesheet
  (fixes UI-011).
- Status is never color-only (see §Status model).
