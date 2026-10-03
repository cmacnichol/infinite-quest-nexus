# Legacy UI usability and performance design specification

Status: Independently audited plan, ready with explicit execution conditions. Implementation remains unauthorized.
Prepared: 2026-10-03.
Source baseline: 94853d2d859f57b8a75bb69edd532c016570dffa.
Planning branch: codex/legacy-ui-implementation-plan.
Scope: active legacy Nexus and Story clients in apps/web, plus explicitly identified additive read contracts. Root index.html and apps/web-next are outside the UI implementation scope.

## User requirements

- Desktop is the primary experience.
- Default story reading is one turn at a time, with easy history and resume controls.
- World and campaign setup must support new and experienced users.
- Advanced settings should be tucked away.
- Work must be divided into small related chunks suitable for subagents.
- Every proposed change must explain its reason so an independent agent can audit the plan before implementation.
- This request authorizes planning, not application implementation or deployment.

## Evidence and confidence

The preceding fresh review exercised the running legacy interface and read current source. Distinguish its observations from acceptance criteria introduced here. The planning worktree matches the reviewed source commit.

Observed:
E01: Unsent story text disappeared on reload while the header continued to say Autosaved.
E02: Editing a campaign title then selecting another campaign discarded the edit without a warning.
E03: Escape dismissed an edited new provider-profile dialog without a discard warning.
E04: Edit in World Management from one world's details left a different previously selected world in the editor.
E05: A remembered Continue latest story target returned Campaign not found.
E06: History for a 317-turn campaign opened at Turn 1 while Turn 317 was selected. It rendered 317 cards, about 92,097 scroll pixels and 7,355 total DOM nodes.
E07: Desktop narration occupied approximately 998 pixels, and reading controls were below the prose.
E08: World/character authoring and campaign creation expose dense fields and differing workflows; nested character saving still requires saving the parent world.

Source-confirmed:
E09: Selected reading position resets on load; choice auto-submit behavior depends on a profile setting.
E10: Quick campaign creation omits turnControlStyle, applying the contract default instead of consistently applying user preference.
E11: Management Worlds/Campaigns share one workspace; campaign lists lack useful search/status filtering.
E12: Save semantics differ by section; errors can be routed to hidden sections; readable-export guidance targets the archive-export workspace.
E13: All published world details are hydrated at startup; searches rebuild cards; cached details have no explicit invalidation.
E14: Campaign management awaits advanced requests sequentially, including context preview.
E15: Story loading waits on optional illustration data; streaming replaces growing narration; image initialization invokes polling twice.
E16: Story dialogs lack accessible names; some tabs lack full semantics; core motion lacks consistent reduced-motion handling.
E17: nexus.js is a copied public asset, rather than a minified Vite input; observed static responses lacked compression. ETags already exist.
E18: World selection lacks protection against superseded responses; campaign selection already has protection.

Single warm localhost HTTP samples, not browser rendering benchmarks:
- World list 407,543 bytes plus 39 world details totaling 797,604 bytes: 1,205,147 bytes.
- Long campaign initial sync 543,395 bytes; state 263,260 bytes.
- Opening older history added 2,603,330 bytes.
- Context preview samples 738 ms and 1,154 ms used different budgets.
- Nexus HTML about 104 KB and nexus.js about 363 KB.
No production speedup, INP, FCP, memory ceiling, or contrast claim follows from these samples.

## Intended product behavior

### Safety and persistence

Ordinary story input is a local browser draft, never accepted campaign state. Restore it only within the server-resolved user and campaign scope. Never automatically submit restored text. Accepted turns, world drafts, campaign settings and jobs remain database-authoritative.

Replace unconditional Autosaved with separate truthful feedback: accepted story synchronization and local action-draft storage. Ordinary drafts must survive reload without superseding durable pending submissions or failed-turn recovery.

All edit dialogs and management selection changes use one consistent Save/Discard/Stay decision where saving is supported. Where saving has a different parent context, offer Keep editing/Discard rather than pretending the nested edit is authoritative. Cancel and Stay produce zero mutations.

Draft storage proposal: IndexedDB transactional storage, schemaVersion1 and immutable draftRevision on every edit; atomic compare-and-write/delete. Submission revision is separate from generation idempotency. Cross-tab conflicts require explicit reconciliation, preserving persisted and local edits; localStorage is not an atomic fallback. scope by origin (browser storage isolation), resolved user UUID and campaign UUID; maximum action length 12,000 characters; retain at most 50 draft records; prune expired records older than30days on access with disclosed retention and bounded expiry notice without expired prose. Protect current record;50unexpired records means capacity error rather than silent eviction. These bounds are product decisions for independent audit, not existing requirements. Storage failure leaves input usable and shows Draft not saved. Clearing, submitting, failing and accepting a generation have distinct draft lifecycle semantics.

### Single-turn reader

Default remains continuousReading=false for profiles without an explicit choice. Preserve existing explicit continuous-reading and auto-submit preferences; do not silently reset them.

Provide a compact sticky reader toolbar: Previous, current turn/count, Next, History and Jump to latest. Preserve browser keyboard behavior and ensure sticky elements do not obscure focus or anchors. Recovery, pending generation and accepted-turn replacement retain existing workflow restrictions.

Persist last-read turn identity plus normalized position within that turn. Missing/deleted/replaced turn identities fall back safely with a visible explanation. Restore only after the target scene is available. Jump to latest does not submit anything or overwrite action drafts.

Reading preferences proposal: width 60/72/84ch (default72), font size 16/18/20/22px (default18), line height 1.5/1.7/1.9 (default1.7), and dark/light/sepia (defaultdark). Scope styles to the reader. Preserve the Nexus brand. Persist through existing user settings, using typed validated values and backward-compatible defaults.

History opens immediately from loaded data without draining all cursor pages. Use up to50cards total: older selected preview plus at most49recent cards. Adjacent selected-turn Previous/Next uses one exact lookup per click; Older/Newer page navigation remains cursor-based. Add older/newer navigation, exact turn-number lookup, and campaign-scoped text search. Search means all accepted effective narration/actions in the campaign, not just locally loaded turns. No automatic context/state inspection occurs on mere history preview; load it on explicit advanced inspection.

Continuous reading remains optional. Window its rendered scenes, retain access to the complete authoritative ledger and exports, and do not load the complete ledger during ordinary startup.

### Setup and navigation

World authoring presents Basics, Lore, Playable character and Review. Draft saving remains possible before readiness; publishing remains explicit. Server readiness checks remain authoritative; the checklist is a guide, not a second domain validator. Existing campaigns never change when a world draft changes.

New characters start with a small basic section; visual/mechanics/legacy fields are disclosed separately. Applying a character to a world form is labelled Apply to world draft. Existing advanced fields remain editable and round-trip unchanged when their disclosures stay closed.

Both campaign creation entry points use one state/controller and identical default resolution. Basic fields: immutable world/version summary, campaign name and playable character. Advanced: existing supported creation options only. Carry unsaved values across disclosure/navigation. Offer Create and start / Create only; preserve duplicate-submission and post-commit refresh-failure protection.

Dashboard prioritizes recent active campaigns and resume. World and campaign collections offer search, status filtering and sorting. Defaults: active campaigns, most recently updated first; archived records remain discoverable. Do not conflate similarly named records.

Provider setup guides connection -> model inventory -> model selection -> readiness without coupling provider roles. Inventory refresh is explicit; opening a dialog makes no billable text/image generation request.

Errors and save states appear in the active section with safe text rendering, actionable retry and correlation detail where available. Distinguish backup archives from reading exports.

### Performance and architecture

First reduce unnecessary requests, serialization and DOM work. Optional illustration/advanced data must not block accepted narration or management Overview. Every asynchronous result is fenced to its campaign/world and load epoch.

Preserve existing state, turns, sync-status, cursor, SSE and generation projections. No shrinking or changing frozen public response fields. New history lookup/index and optional reader bootstrap routes are additive, owner/campaign-scoped and validated. Never include scratchpads, rejected narration, raw output or hidden mechanics in reader summaries.

Use pure policy in client-core, Web API/storage/HTTP adapters in client-web, and DOM rendering in apps/web. New code is TypeScript through existing entries; do not convert or restructure the entire legacy client.

Minify management through the existing Vite entry, preserving runtime paths and globals until callers are migrated. Cache immutable hashed assets; revalidate HTML and stable filenames. Compression applies only to appropriate static text, never SSE or downloadable archives by default.

## Constraints

- Node >=22.13.0; package manager pnpm@12.4.1 from package.json through Corepack.
- Two-space indentation; TypeScript for new shared modules/adapters; no new UI framework.
- Existing /story and /nexus routes coexist with /app routes; no redirects.
- Existing server identity/ownership, immutable world versions, append-only acceptance and generation idempotency remain intact.
- Text, image and embedding credentials and readiness are separate.
- No private live worlds/campaigns embedded in source or committed test assets.
- No prompt, provider policy, mechanics protocol, database migration or deployment topology change unless a separate audited task explicitly requires it.
- UI tests must include rendered interactions and screenshots; unit/static tests are insufficient.
- Skipped or unavailable checks are not passes. Live-provider proof is separate.
- Documentation-only planning does not require installing dependencies or running application suites.

## Measurable acceptance proposals

These are proposed engineering budgets, to be audited against the deterministic fixture before enforcement:
- Zero eager published-world detail requests on dashboard startup; no advanced campaign request before its section is opened.
- At most one statistics request per initial Nexus load.
- Opening history fetches at most one bounded page; render at most50 history cards; no complete-ledger drain.
- Initial single-turn reader never downloads all history; blocked image requests do not prevent accepted narration from appearing.
- Normal streaming update scheduled at most once per animation frame; final accepted rendering is exact and safe.
- No busy idle image polling; no duplicate initial polling.
- Same-fixture p95 for changed read paths must not regress >10% without recorded cause and reviewed exception, following ADR0028. Record variance; do not equate one sample with a benchmark.
- Local browser interaction targets: record history-open and navigation p50/p95, long tasks and DOM counts. Timing assertions should use controlled delayed-route behavior rather than fragile absolute CI milliseconds.
- Desktop 1280x800 and1440x900, secondary390x844, keyboard-only navigation,200%zoom and reduced-motion checks.
- Contrast verified for every added reader theme; normal text4.5:1, large text3:1, relevant UI/focus3:1. Target44x44px comfortable controls, without mislabelling every smaller target as a WCAG failure.

## Non-goals

No replacement-client migration, wholesale redesign, canonical state changes, new authentication, production deployment, database cleanup, provider tuning, automatic publishing, automatic world migration, or full-text/semantic-search infrastructure introduced without measured need.

## Evidence limitations carried forward

Six focused suites in the audit could not start because package-manager/Vite dependencies were unavailable. No assertions ran. Browser paint/CPU profiling, full screen-reader and contrast evaluation,200%zoom and live-provider generation were not completed. The current plan must establish a new reproducible test baseline rather than presenting these as passes.
