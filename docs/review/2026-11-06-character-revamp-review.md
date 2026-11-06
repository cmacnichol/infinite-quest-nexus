# Character tracking and usability review

Review date: 2026-11-06. Local source baseline: `6cd29919d419b02b846d1c53747262de1dd4c6ad`.

## Recommendation

Revamp Characters around a unified campaign cast workspace, automatic tracking of supported story evidence, and a small review inbox for genuine uncertainty. Reuse the existing cast persistence, discovery, history scanning, and context selection. The largest immediate gains are removing JSON editing, reducing repeated identity confirmations, and making tracking status understandable.

This is a proposal, not an implementation or deployment decision. Source defaults do not establish which capabilities are enabled in the running installation.

## What exists today

| Area | Current implementation | Consequence for the revamp |
| --- | --- | --- |
| Reusable playable characters | World rosters contain stable IDs, structured identity/story/appearance, and separate mechanics. Campaign creation selects from the pinned version. | Preserve world authoring and version isolation. |
| Campaign protagonist | Immutable origin snapshot plus a revisioned campaign-owned profile. Profile authority is separate from supporting cast. | Present one coherent interface while routing saves to the correct authority. |
| Supporting cast | Campaign-scoped identities, aliases, sparse profiles, observations, claims, overrides, pin/ignore controls, and source history. | Build on this store rather than introducing a competing character database. |
| Discovery | Durable extraction from accepted narration, exact quotations, conservative identity resolution, separate failures and retries. | Automation exists; matching friction and visibility are the main targets. |
| Historical tracking | Explicit preview/start/pause/resume/cancel scans with retained checkpoints. | Offer a clear setup flow for older campaigns; do not silently scan paid history. |
| Story use | Bounded context ranks direct references, open-thread references, pinned people, then recently observed people. Stale dynamic observations are omitted during tracking gaps. | Explain selection and freshness to the user; keep context selective. |
| Illustrations | The inspected visual-reference paths use the protagonist profile/snapshot. | Supporting-character visual references need an explicit extension. |

Evidence: [world and protagonist resolver](../../packages/domain/src/world-characters.ts), [profile contracts](../../packages/contracts/src/world-library.ts), [cast contracts](../../packages/contracts/src/campaign-cast.ts), [discovery validation](../../packages/domain/src/campaign-cast-discovery.ts), [cast projection](../../packages/domain/src/campaign-cast.ts), [context selection](../../packages/domain/src/campaign-cast-context.ts), [illustration adapter](../../services/runtime/src/illustration-image-job-adapter.ts), and [operations guide](../runbooks/campaign-cast.md).

## Main usability and automation gaps

1. **Editing the protagonist requires technical knowledge.** Both the legacy Story profile editor and replacement campaign editor expose profile JSON. Supporting characters instead have labeled fields and source history. Replace this mismatch with a shared form presentation and preserve their separate save contracts. See [legacy Story editor](../../apps/web/src/story.js) and [replacement campaign editor](../../apps/web-next/src/campaign-editor-page.ts).

2. **Returning characters can require repeated confirmation.** The current discovery prompt and validator require corroborating aliases or identifying details beyond a shared name. Even a unique known name alone is insufficient. This intentionally favors avoiding false merges, but ordinary scenes need not restate a character's appearance. The [existing October auto-match plan](../superpowers/plans/2026-10-04-campaign-cast-auto-match.md) already proposes graduated matching, detach, and inexpensive mention tracking. Its `CAST_AUTO_MATCH_ENABLED` and `identityPolicy` implementation are absent from the inspected source. Reconcile and reuse that plan rather than starting a parallel design. This is a source-supported friction hypothesis; production review frequency was not measured.

3. **Discovery and actual story use have separate gates.** Editing, discovery, context injection, and backfill default off. Context additionally depends on discovery and applies to eligible Story Memory generation. A populated roster does not by itself prove that those records are being supplied to generation. Show separate tracking and story-context status. See [configuration](../../packages/database/src/config.ts) and [operations guide](../runbooks/campaign-cast.md).

4. **The cast workflow is fragmented and legacy-only.** The [Characters panel](../../apps/web/src/campaign-cast-panel.ts) provides a list, detail editor, matches, and scan screens through a dialog, with manual refresh. Protagonist editing leaves that workflow. The replacement UI remains deferred in the cast rollout. Share the new workspace across the two active Story surfaces.

5. **Identity decisions and disputed details need distinct resolution.** A character can be attached successfully while unsupported attributes remain pending. The matches view excludes already resolved identities, and there is no dedicated approve/dismiss workflow for those withheld details. Provide separate inbox categories for identity questions and field changes, with source excerpts and clear resolution state. See [candidate API and panel](../../apps/web/src/campaign-cast-panel.ts) and [partial-resolution behavior](../runbooks/campaign-cast.md).

6. **Relationships are not structured supporting-cast authority.** The protagonist supports free-text key relationships; the cast field contract has no relationship edges and discovery explicitly forbids relationship extraction. Add relationships as a later, reviewed feature with evidence, direction, uncertainty, and history. Do not present this as existing automation.

## Ideas to adapt from SillyTavern

SillyTavern separates character descriptions, personality, scenario, and dialogue examples, and allows creation with just a name. Its useful lesson is progressive disclosure: start with a short concept and expose deeper editing when needed. InfiniteQuest can allow minimal saved drafts while retaining its existing campaign-readiness validation. [Character design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/).

Its personas separate player identity from AI characters and support context-bound selection. Apply that distinction as a clear **Main character** designation inside a broader cast, without switching campaign protagonists implicitly. [Personas](https://docs.sillytavern.app/usage/core-concepts/personas/).

Its group controls make character participation explicit, while World Info activates relevant lore within a budget. Adapt this into visible **Relevant to this scene** and **Pinned** states plus an explanation of why a character was supplied to the Story Engine. A mention is not proof of physical presence, and retrieval activation must not change canon. [Group chats](https://docs.sillytavern.app/usage/core-concepts/groupchats/), [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/).

Do not copy per-card system-prompt overrides, global unscoped lore activation, or chat summaries as authoritative facts. SillyTavern's own summary documentation warns that generated summaries can lose information or hallucinate. InfiniteQuest should retain accepted turns and evidence-backed profiles as authority. [Summarize](https://docs.sillytavern.app/extensions/summarize/). Further upstream evidence is recorded in the [companion research note](2026-11-06-sillytavern-characters.md).

## Proposed experience

Use a searchable cast list beside a readable character sheet. The list shows name, short role, last observed turn, and a small attention indicator. Optional portraits should never be required. Filters cover Main character, Recent, Pinned, Needs review, and Ignored; an In scene filter should wait for a defined presence model.

The sheet opens in reading mode with Identity, Personality and voice, Appearance, Current situation, and History. Unknown fields stay unobtrusive. Editing uses ordinary inputs; mechanics remain a separate advanced section for the protagonist. Put evidence behind **Why do we know this?**, and distinguish observed facts, speaker claims, manual corrections, and unresolved conflicts.

Use one persistent status line: **Up to date through turn N**, **Catching up**, or **Needs attention**. Background refresh should preserve selection and unsaved input. Expose a **Used in the next turn** preview with selection reasons and omissions; never label a character active merely because it is pinned or mentioned.

For example, when a returning character enters a later passage, record the source mention and suggest or apply the supported identity match according to policy. Do not require the reader to re-enter their biography. A possible change in clothing can be recorded from supported narration; a conflicting identity or unexplained permanent appearance change belongs in review. The user can inspect the source and undo an automatic attachment.

## Automation policy

| Operation | Recommended treatment |
| --- | --- |
| Record a reliable mention | Automatic and source-linked; call it last mentioned/observed, not confirmed present. Guard common-word names, quoted stories, ambiguity, and hypothetical references. |
| Update supported temporary facts | Automatic after validation; retain source turn and supersession history. |
| Match a returning identity | Evaluate the October graduated-match design with adversarial fixtures; pair automatic matching with an auditable detach action. A model confidence number is insufficient. |
| Contradict a stable trait, merge people, or change protagonist identity | Explicit review. Manual corrections remain authoritative. |
| Generate a new biography or expand missing details | User-requested creative proposal with review before save; separate from extraction. |
| Extract relationships | Later proposal workflow; preserve who asserted the relationship and whether it is established. |
| Scan old story | Explicit preview/start with progress, cancellation, and request estimates. |
| Promote discoveries into reusable world canon | Explicit reviewed world-draft action; never update published versions or other campaigns. |

## Delivery order

1. **Make current capabilities understandable.** Replace protagonist JSON forms, unify cast presentation, surface tracking/context capability states, add automatic progress refresh, and provide a field-change inbox. Preserve the existing APIs and source history where possible.
2. **Reduce review load.** Reconcile the October matching plan with current code; implement and verify evidence-linked mentions, graduated identity decisions, and undo together. Version the prompt and persisted protocol changes. Measure review requests per accepted turn, mistaken matches, tracking lag, and provider calls before changing defaults.
3. **Improve portrayal across text and images.** Add scene-relevance explanations and bounded supporting-character visual references. Freeze references per illustration job and use only validated fiction for depicted people through the independent image provider.
4. **Extend authoring and relationships.** Add reviewed relationship records and, if useful, a SillyTavern card compatibility adapter. Preview imported fields, preserve provenance, and do not activate imported instruction overrides or remote assets automatically. Any reusable library must still create explicit world-draft copies.

Retain owner/campaign/world-version isolation, append-only accepted turns, timeline-aware evidence invalidation, branch/transfer/archive support, generation-time frozen authority, and independent optional-job failure. Matching-policy changes need an explicit decision update; UI unification does not require merging protagonist and cast authority.

## Verification

Passed: direct Vitest invocation selecting discovery, cast context, cast panel, and character-profile tests reported 21 files and 478 tests passed. The initial pnpm launcher failed to create a local package-manager symlink; invoking the installed Vitest entry point succeeded. This is unit evidence only.

Not performed: rendered-browser usability testing, PostgreSQL integration, live-provider evaluation, or deployment configuration inspection. No product behavior was changed. The proposed UI still requires keyboard/mobile/browser verification with screenshots, and automation changes require identity ambiguity, correction/rewind, isolation, failure/retry, and portability coverage before release.
