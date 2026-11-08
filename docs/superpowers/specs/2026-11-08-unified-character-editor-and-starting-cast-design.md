# Unified Character Editor and Starting Cast Design

**Status:** Revised after [independent spec review](../../review/2026-11-08-unified-character-editor-and-starting-cast-spec-review.md). The author confirmed both [product decisions](#confirmed-product-decisions) on November 8, 2026, and accepted the [round-2 amendments](#round-2-amendments), which take precedence over any earlier text they conflict with.

**Date:** 2026-11-08

**Baseline:** `87ab54ca`

**Surface:** Nexus UI (`apps/web`). Web-Next receives compatibility fixes and installation settings in this release. Its editor redesign is a [follow-up](#web-next-follow-up).

## Summary

Authors can preset a world's primary NPCs the way they already preset the main character. Each NPC selected for a campaign is copied from the campaign's pinned world version when the campaign is created. From then on that copy belongs only to that campaign and can be edited in Story.

Nexus gets one character editor with three entry points: the World edit screen, the campaign page, and Story. The editor's model lives in `client-core` so Web-Next can adopt it later.

Fields the author wrote stay fixed against automation. Goals, location, condition and clothing update from the story. Stable fields the author left blank can be filled by discovery. A person can edit any field by hand.

## Why

- The World editor can only preset playable characters. NPCs are generic `entities` with a name, type and description.
- At campaign start the server creates only the main character's cast row (`campaign-cast-repository.ts:50-56`). Other roster members and `character`-type entities are name-matching hints. Their authored details never reach the cast.
- Nexus has separate editors with different field lists: the World/campaign dialog (`index.html:895`, `nexus.js:560`), Story's main-character form (`character-profile-form.ts`, `story.js:5913`), and the supporting editor (`campaign-cast-panel.ts:253`). Each new field or rule has to be repeated.
- The Story supporting editor has only 11 fields, so it cannot edit a full authored NPC.

## Goals

1. Mark world characters as Playable, Supporting, or Both.
2. Choose the main character and starting cast when creating a campaign.
3. Copy each chosen NPC into the campaign as a campaign-owned record, keeping every authored value. The only exception is a name or alias that fails fiction validation, which is skipped and reported.
4. Keep authored stable fields fixed against automation while listed fields keep updating.
5. Edit all fields of a preset NPC after the campaign starts, with reset to the world value.
6. Use one editor from World, the campaign page and Story, with context-specific behavior.
7. Put fields, policy, draft state and save-payload construction in `client-core`.
8. Reduce manual work with reviewed AI drafting and bulk operations.
9. In a separately released phase, let people correct the cast with merge, remove and promote to world.
10. Make the Story cast panel easier to work through, with one Needs attention inbox and clearer sheet labels.

## Non-goals

- Merging world and campaign storage. World versions stay immutable and campaigns stay isolated (ADR 0013).
- Changing how the main character is stored.
- Live links between a world character and campaign copies, in either direction, apart from the explicit Promote to world action.
- Adding presets automatically to campaigns created before this feature, including after they migrate to a newer world version. Add from world stays available to them.
- Changing the default of any `CAST_*` flag, including the auto-match default, which needs its own follow-up decision.
- Building the Web-Next character editor and starting-cast picker. Existing Web-Next writers, review actions and installation settings receive the compatibility changes specified here.
- Physical-presence tracking. A mention is not presence.
- Structured relationship edges.

## Anti-goals

The design has failed, even if it works technically, if:

- narration can silently rewrite a field the author wrote;
- authored text disappears because discovery saw a different wording;
- a campaign edit changes a world or another campaign;
- authored characters flood narrator context and crowd out the current scene;
- existing worlds or campaigns change behavior without an author opting in.

## Decisions

| Topic | Decision | Source |
|---|---|---|
| UI scope | Nexus now, Web-Next later | User |
| Editor structure | One editor, different entry points | User |
| Authored stable fields | Fixed against automation | User |
| Goals | Authored value is the start; updates from the story | User |
| Post-start editing | All fields of story characters stay editable | User |
| Snapshot lifecycle | Copied when the character enters the campaign (creation, first appearance, approval or Add from world), then unique to the campaign | User |
| Shared model | In shared code, so Web-Next is easier later | User |
| One roster with a use setting, not a separate NPC list | Keeps one workspace, AI and import path | Design call |
| Same model as main character: origin snapshot plus editable copy | Allows all fields and reset | Design call |
| Differences from fixed fields are recorded, with no approval step | Follows from "fixed" | Design call |
| Hand edit of an updating field wins until cleared | Existing override behavior | Design call |
| Numeric limits in this document | Starting values, adjustable in implementation | Design call |
| Suggest a cast uses synchronous previews, not a new durable job kind | Nexus character generation is synchronous today, and review stays local until Save world | Design call |
| Converted entities remain in the world, linked to the new character | World context and relationships keep working, including with character context off | Design call |
| Remove is soft and reversible; there is no hard delete | Accepted-history evidence stays intact | Design call |
| Merge and remove are events, undone by later events | Matches the detach pattern and handles rewind | Design call |
| Main characters cannot be merged, removed or promoted | They have separate authority | Design call |
| Promote writes to a draft only, for a world the owner chooses | Published versions are immutable | Design call |
| Only selectable characters must have guidance; Supporting characters get a warning | Incomplete NPCs must not block campaigns | User |
| Converted entities start unticked; pre-select at most 30; warn above 5 Always include | Prevents invalid requests and context flooding | User |
| Authored goals can be restored after the story changes them | Reset promise covers goals | User |
| Starting cast is hidden, with an explanation, when presets are unavailable | No controls without an effect | User |
| Unticked world NPCs can be added during play | Fixes forgotten ticks, including with discovery off | User |
| Mechanics stay stored, hidden, when a character becomes Supporting | Switching back loses nothing | User |
| The campaign page can open the editor for any campaign character | One editor; no technical reason to restrict it | User |
| Phase 6 stays specified but releases separately | Not needed for presets | User |
| Approving a held world match copies the profile; Not this character does not re-copy automatically | Add from world handles later genuine arrivals | User |
| A name that fails the mechanics filter is flagged and skipped, never aborting campaign creation | One bad name cannot block a campaign | User |
| Context without discovery needs a separate opt-in | No behavior change on upgrade | User |
| Discovery may add appearance as a separate Observed in story line | Authored fields stay fixed and story detail is kept | User |
| Nexus uses the typed `client-web` cast API for campaign character work | Shared validation, and reuse by Web-Next | User |
| One atomic route saves a preset NPC | Two revision-checked saves conflict with each other | Design call |
| A new presets flag gates every seeding path: campaign start, first appearance, review approval, Add from world and Apply world profile | Sets a clear rollback boundary, and makes "isn't adding them to campaigns yet" true | Design call |
| Both new flags live in the Web-Next Settings panel with the other cast flags | Keeps installation settings in one place | User |
| Convert only the character calls this work touches to the typed client, phase by phase | Helps now and for Web-Next, without broad risk to `nexus.js` | User |
| A pre-feature campaign that migrates to a newer world gets no automatic copies | Keeps existing campaigns unchanged; Add from world covers them | User |
| Context gives core fields across the admitted cast priority over optional fields. Recently active characters outrank pins | Honor the requested ordering within actual request headroom | User priority, bounded allocation specified below |
| The create dialog shows a Story Memory note; the enable link appears after creation | Enrollment needs an existing campaign | User |
| The Needs attention inbox and sheet fixes are in scope | Part of improving the editing experience | User |
| A removed character leaves Chronicle catalogs but still counts for name uniqueness | A mistaken character should not stay a Chronicle entity | User |
| When only one merge participant is seeded, the seeded record must be the target | A non-seeded record cannot hold authored fields | User |
| Goal overrides allow the world's 20,000-character limit | Long authored goals must stay editable | User |
| Emptying goals, location, condition or clothing returns the field to the story value | Avoids an accidental permanent blank | User |
| An authored field cannot be blanked for one campaign; it can be edited or reset | Automation must never refill an authored field | User |
| Starting cast selections last only while the create dialog is open | Nexus has no draft persistence today | User |
| Archived campaigns allow character edits and Add from world | Matches today's behavior | User |
| Open in Story goes straight to the chosen character | One step from the campaign page | User |
| Convert entities sits beside Suggest cast; Organize runs after adding, in the editor | Nexus has no entity list or row-level Organize | User |
| Draft from story's prompt has no per-campaign override | Matches other World authoring prompts | User |
| In-character claims cannot support a Draft proposal | Claims are not facts | User |
| Draft from story proposes only for fields whose effective value is blank, and never updating fields | An applied proposal must not stop story updates or replace discovered values | User |
| Generate is hidden for Supporting characters until phase 5 | Today it overwrites mechanics and resets use | User |
| Main-character Organize stays on the campaign page | Story has no review surface | User |
| Aliases are entered one per line in every editor | Names can contain commas | User |
| Every campaign editor's close prompt offers Keep editing, Save changes and Discard | One staged confirmation | User |
| Corroborated first-appearance copies can be undone with Not this character; Add from world then starts a fresh activation on the existing record | Avoids two records for one person | User |
| The new flags are enabled from the panel alone on local single-user installs; managed deployments set the environment variable and re-issue the policy | Respects operator control where it exists | User |
| With discovery off, the narrator receives last-known state as dated, lower-authority content | Values on the sheet do not silently vanish from context | User |
| Turning presets off stops new seeding only; seeded characters stay editable and in context | Rollback must not strand existing data | User |

## Domain model

### World roster

Extend `playableCharacterSchema` (`packages/contracts/src/world-library.ts:87`) with:

```ts
campaignUse: z.enum(["playable", "supporting", "both"]).default("playable"),
startingCastDefault: z.boolean().default(true),
alwaysInContext: z.boolean().default(false)
```

- The stored array keeps the name `playableCharacters` to avoid a broad portable-format rename. The UI calls it Characters.
- Existing and imported characters default to `playable`, so nothing changes until an author opts in.
- `startingCastDefault` and `alwaysInContext` have no effect on `playable` characters.
- A selectable character is one with `campaignUse` of `playable` or `both`.
- `supporting` characters do not need mechanics. The editor hides mechanics for them. Mechanics on `both` apply only when the character is the main character.
- Switching a character to Supporting keeps stored `rpgStats` and `defaultTriggers`, hidden, with the notice "Mechanics are kept but not used while this character is Supporting."
- Changing the last selectable character to Supporting shows the warning "This world will have no character to play."
- Each seed stores the original `characterText` as read-only legacy guidance, including when a structured `profile` also exists. Preserve both through edits, Reset, branch and archives. For a legacy-only record, initialize `unclassifiedNotes` from the text. Legacy text is shown read-only and offered to Organize, and is never sent to the narrator on a seeded NPC (amendment D4).

Required changes:

- `selectPlayableCharacter`, `resolvePlayableCharacters` and the single-character auto-select (`world-characters.ts:111-130`) consider only selectable characters.
- Starting cast needs Supporting characters, so add a separate unfiltered roster resolver for it. `resolvePlayableCharacters` stays selectable-only.
- `assessWorldCampaignReadiness` requires at least one selectable character and adds a distinct issue code for a roster with only Supporting characters. ID and name checks apply to every entry. The guidance check (`world-characters.ts:97`) applies only to selectable characters. Supporting characters without guidance produce a non-blocking warning. Use `no-selectable-characters` for a Supporting-only roster and include it in the HTTP adapter’s safe issue allowlist.
- Readiness adds a non-blocking warning for a Supporting character whose name fails `validateCastFiction`.
- Issue messages say "Character N", not "Playable character N" (`world-characters.ts:75-100`, `world-campaign-application-adapter.ts:34-38`).
- System Archive already exports the structured roster profile. In phase 3 extend only the roster contract, exporter and importer with `campaignUse`, `startingCastDefault` and `alwaysInContext`. Older records acquire the world schema defaults after archive validation. Phase 5 adds `linkedCharacterId` to entities and allows the typed roster provenance `{ type: "world-entity", entityId }`. Phase 6 also allows `{ type: "campaign-promotion" }`. Classify these two source shapes as portable authority under ADR 0037 and explicitly project their keys in both directions.
- Discovery keeps eligible roster entries as identity hints, reserving the selected protagonist and representing each linked entity or seeded NPC once.
- These readers mean "can be selected" and must use the selectable list: `campaign-transfer.ts:72`, `campaign-transfer-character-repository.ts:677`, `world-repository.ts:1169` and `campaign-creation-draft.ts:38`. Transfer must never map a main character onto a Supporting entry. Audit the remaining readers: generated-world assembly, source proposals, imports and archives. Infinite Worlds story-text import (`portable-import-export-composition.ts:1553`) uses the same selectable resolver for listing, single-entry auto-selection and validation under the pinned version at apply. A historical campaign snapshot retains its accepted selection.
- `WORLD_CONTENT_SCHEMA_VERSION` stays at 6. The schema is passthrough and the fields have additive defaults, and a bump would add a false `world_schema_version_changed` warning on transfer (`campaign-transfer.ts:63`).
- Older binaries would treat Supporting characters as playable. The contract fields and selection and readiness readers therefore ship in phase 3, and phase 4 adds only the authoring controls. Rolling back past the first published Supporting world exposes this behavior, and the runbook says so.

### Campaign start

Extend `campaignCreateSchema` (`world-library.ts:262`):

```ts
startingCast: z.array(z.object({
  characterId,
  alwaysInContext: z.boolean().default(false)
}).strict()).max(30).optional()
```

Rules:

- Each ID exists in the pinned world version, is `supporting` or `both`, is unique in the list, and is not the selected main character.
- Omitted means no starting cast. The stored campaign eligibility below governs later appearances, independently of any selection in this request.
- The limit of 30 keeps review manageable. Context selection, not this limit, controls narrator cost.
- Seeding runs in the same transaction as campaign creation, so a campaign never exists half-seeded.
- Seeding requires the new `CAST_PRESETS_ENABLED` flag (default false, effective only with cast editing on). When it is off, a non-empty `startingCast` is rejected with `cast_presets_disabled`, raised as a `WorldCampaignApplicationError` with status 503 because `POST /campaigns` is not a cast route. Map this specific reason to a sanitized public 503 envelope carrying `cast_presets_disabled` and the request reference ID through both the world adapter and global HTTP handler. Keep generic 5xx redaction in place.
- Seeding stores the validated world profile and original legacy guidance at full fidelity, including mechanics-like prose. Project provider-bound values using the [narrator context rules](#narrator-context).
- `create` validates names and aliases with `validateCastFiction` (`campaign-cast-repository.ts:261`), and projection repeats that check. A world-origin `create` also requires the ID in `buildScopedEntityCatalog` or `castDiscoveryWorldIdentities` (`:269-270`), whose filter is stricter (`campaign-cast-world-identities.ts:11-15,37-39`). Seeding, readiness and Add from world therefore use one eligibility predicate that matches what `applyCommand` accepts. Seeding skips a character whose name fails it, omits an alias that fails, and reports both in `skippedStartingCast` on the create response. Add from world returns a field error instead.
- A successful create consumes the form. Both Create and Create and start enter a result state associated with the returned campaign ID only when characters were skipped (amendment D13). Show the skipped list, applicable setup link, Open story and Close. Disable resubmission from that state. With no skipped entries, follow the requested close or navigation; an enrollment link alone does not interrupt, and appears on the campaign page instead.
- An internal function, `seedCampaignCastWithClient`, initializes cast state, pre-allocates character IDs, and writes one event per character. The boundary is turn 0, timeline revision 0. The idempotency key is `campaign-seed:{campaignId}:{characterId}`. `persistBatch` generates IDs internally, so the normal batch path cannot reference them.
- Evidence `sourcePath` points to a value that exists in the world version, for example the entry's `name`, so `evidenceIsCurrent` accepts it for characters with no profile.

### Cast record

Add two commands to `castCommandSchema` (`packages/contracts/src/campaign-cast.ts:67`):

```ts
{ kind: "seed_profile", characterId, worldVersionId, entityId, rosterName, rosterAliases, legacyCharacterText, profile, evidence }
{ kind: "edit_authored_profile", characterId, seedEventId, set: Record<ProfilePath, Value>, reset: ProfilePath[], restoreAuthoredGoals?: true }
```

`set` values pass `validateCastFiction`, with a field-level error on failure, carried as `details.fields: [{ path, code }]`. A record has at most one active seed. A second seed is rejected unless the earlier one is suppressed. `set` cannot make a non-blank authored value blank; the person edits it or resets it.

A preset character is written as a `create` command with `origin.kind = "world"`, which the repository already validates (`campaign-cast-repository.ts:265-271`). It is followed by `seed_profile`, and by `pin` when `alwaysInContext` is set.

Projection produces two values for each seeded character:

- `originProfile`: the immutable result of the active `seed_profile`.
- `campaignProfile`: `originProfile` plus edits whose `seedEventId` identifies this activation. Persist source identity separately from later campaign identity commands. A fresh application has a new seed event ID, even for the same roster entry.

Using cast events instead of a new table means rewind, branching, transfer and archives follow the existing timeline-aware path. Edits apply from the current turn forward.

Phase 3 introduces portable cast v3. The separately released lifecycle commands require v4 in phase 6.

- v3 adds seed/edit commands, their seed-event references and the widened goal-override representation. v4 additionally permits merge, unmerge, remove and restore, including reviewed merge choices. Reject a payload that uses a command or value its declared version cannot represent.
- v1 and v2 stay readable.
- Import maps `seed_profile` evidence as other world evidence (`campaign-cast-portability.ts:61-68`), and `portableCastReferences` must include `seed_profile` (`campaign-cast.ts:198`) so System Archive import builds a complete world map.
- World transfer goes through `copyCampaignCast` (`campaign-transfer-character-repository.ts:598`), not import, and copy does not convert world evidence or origin. Cross-world transfer must convert seed evidence and origin explicitly.

Export the lowest supported write format that represents the entire cast payload: v2 for v2-compatible data, v3 for seed/edit events or any goal override above 2,000 characters (including ordinary characters), and v4 for lifecycle events. Validate values in stored receipts as well. First-appearance eligibility lives in the enclosing portable campaign record, including when there is no cast payload. Version the enclosing Campaign and System Archive records when writing this metadata, accept prior record versions, and keep legacy fingerprint verification on the original representation.

Record these rollback boundaries in the runbook:

1. **The first settings save after phase 3.** Stored settings are parsed strictly (`packages/contracts/src/instance-settings.ts:21-33`, `instance-settings-repository.ts:26-27`) and saves store a full snapshot, so a pre-phase-3 binary cannot read a row containing the new keys, even with presets never enabled.
2. **The first v3-only cast write.** A seed, authored edit or long goal override can make the affected campaign unreadable by earlier strict live readers, even if presets are subsequently disabled.
3. **The first published Supporting or Both roster.** Older selection logic can offer a Supporting NPC as the protagonist. Guard draft writers/readers before authoring is made available.
4. **The first phase 6 lifecycle write.** Merge or Remove can introduce a v4-only event even when presets have always been off. Gate phase 6 writes on completion of the reader rollout.

Deploy contract, API, worker, rewind/copy and archive readers before enabling the corresponding writers. For phase 6, first deploy v4 readers with lifecycle writes disabled on all nodes, then activate the phase 6 writer deployment after verifying every reader. Readers for v3 and earlier must report an unsupported v4 import before any destination write. Reverting to an incompatible reader after a boundary requires a compatible forward fix or a rehearsed pre-boundary backup restore with the loss of intervening writes explicitly assessed.

### First-appearance copy

First appearance applies to eligible campaigns and Supporting or Both entries in the current pinned world. Reserve the protagonist’s scoped roster identity in every seed lookup, including discovery, held approval, Add and Apply. Track it by source world and selected roster ID across renames, same-world migration and transfer. A match to that reserved entry routes to the existing protagonist or identity review. Reject a protagonist as an Apply target.

| How the identity is established | What happens |
|---|---|
| `unique_world_name` or corroborated world match | `create` and `seed_profile` go in one event through a shared internal write that pre-allocates the character ID (`persistBatch` otherwise generates it inside; `campaign-cast-repository.ts:331-332,385`). The record uses the roster name and eligible authored aliases. The narrated term is added as an alias only if it passes validation and the 20-alias limit. The publication writes an attachment for corroborated seeds too, so Not this character can undo them |
| A person approves a held world match | Resolve against the current pinned version under lock. Exactly one eligible supporting identity and a valid campaign permit a seed. An ambiguous or changed world identity needs explicit resolution. Plain discovery remains available when seeding is disabled or the campaign is ineligible. If approval resolves to an existing cast record, attach only to the confirmed target. Use the existing identity for a reserved protagonist. A detached attachment cannot establish another automatic seed |
| Not this character (detach) | Keep the cast record, suppress this seed, its seed-scoped contributions and its authored edits. The Sources view retains their history. Fresh appearances cannot reactivate it. Add from world can reapply the roster profile on the same record |

- The seed event records which attachment can suppress it: only the one created in the same publication. Detaching a later `unique_name` attachment on a start-seeded or Add-from-world character leaves the seed intact.
- Extend `projectCastAttachments` and portable attachment validation for suppression. Suppression survives export and copy even when the attachment no longer validates after a narration correction (`campaign-cast-portability.ts:21-27`).
- It does not apply to `playable`-only roster members or to generic entities.
- Publication freezes matching policy and the seed permission captured at admission. Under the campaign write lock it also requires the currently effective presets permission at commit. An older job without permission cannot gain it on retry. Turning the flag off vetoes new seeds from queued jobs while allowing independently valid plain discovery. Review approval also checks the live permission. The operator cutoff is activation of the disabled setting across writers.
- Persist `firstAppearanceEligible` as campaign-owned portable authority independently of cast initialization. New native campaigns created with effective presets on are eligible even with no starting cast. For a native campaign created with effective presets off, store `false` for its lifetime. Enabling presets later leaves that marker unchanged. Pre-feature rows, legacy/story-text imports and older archives missing the marker default to false. Explicit Add/Apply remains available when presets are on. Branch and transfer inherit the source marker, same-world migration retains it, and both archive families export and restore its exact value even for a campaign with zero cast events.

### Add from world

The Story panel and campaign page offer **Add from world**, listing `supporting` and `both` characters from the pinned world version who have no active seed in the campaign. The main character is excluded, using `selectedCharacterId`. "Already represented" is decided by the latest active seed plus origin, comparing the world as well as the `entityId`. A seed carried from a different world does not count as already represented (amendment D16). Removed and merged-away records still count, and a merged-away match resolves to its target and is never itself seeded. The server rejects duplicates.

```text
GET  /api/v1/campaigns/:campaignId/cast/from-world-preview?characterId=...&targetCastCharacterId=...
Returns: { worldVersionId, characterId, eligibleTargets, targetCastCharacterId?, castRevision, boundary, characterRevision?, choices, changes, previewFingerprint }
POST /api/v1/campaigns/:campaignId/cast/from-world
Body: castWriteBase + { characterId, expectedWorldVersionId, previewFingerprint, targetCastCharacterId?, expectedCharacterRevision?, alwaysInContext?: boolean }
```

- The preview loads the owner-scoped campaign, its pinned roster entry and its possible targets. List each source, old effective value, proposed value and effect, including identity, long fields and overrides. For several same-name targets require an explicit target and rerun preview for it before enabling Apply. For a new record show the create outcome. The typed write recomputes the preview under lock, compares the fingerprint and revisions, and rejects stale selections with `cast_world_preview_changed` (409). A replay with the same idempotency key and request returns the original receipt.
- A create outcome requires a preview with no existing target requiring selection or restoration. At the current boundary it writes `create` and `seed_profile` together without a provider. Apply and restore require the selected target ID and its expected revision.
- On Apply, keep the target’s current display name and campaign aliases. The seed stores the canonical roster name and eligible roster aliases separately for Reset. For each stable field, a hand value on a blank world field becomes a campaign-authored edit in the same event. A populated world field takes its reviewed world value and the preview shows any displaced hand value. Leave facts and their citations intact. Preserve active overrides on goals, location, condition, clothing and observed appearance, including an intentional empty appearance override. Store enough seed-scoped transition data to recover the prior stable overrides when that activation is suppressed.
- Add from world after detach creates a fresh seed activation on the existing cast row. Reapplying the same roster entry starts from its values in the campaign’s pinned world version. Prior seed-scoped edits remain visible in history. A player may re-enter an old value as a new campaign edit. Another eligible profile on that record never inherits the former seed’s edits. Independent identity edits and updating-field overrides retain their own event order.
- A seed written to an existing record is turn-gated like any other edit.

### World migration

Migrating a campaign to a newer world version does not change existing copies. First-appearance copies in eligible campaigns and explicit additions after migration use the new pinned version. Older seed evidence stays valid only while its world version exists; the deletion guard must also treat cast seed evidence as a dependency, or the evidence must be converted to `historical_world` first. A campaign created before this feature gets no automatic copies, even after migrating; the panel's empty state points to Add from world.

If a job was admitted on an older pin, re-resolve the captured world and stable roster ID under the campaign lock at publication. Accept a match only when the entry is still eligible and the captured identity evidence uniquely supports its current name/aliases. Read the profile from the current pin. A rename that invalidates the evidence, removal, changed role eligibility, collision or reserved protagonist goes to identity review. Never commit the old version as a new origin or silently substitute a matching name.

### Discovery integration

Without this section, seeded characters have an empty cast profile (`campaign-cast-repository.ts:165,192`), so strict discovery cannot corroborate them and holds them for review (`campaign-cast-discovery.ts:195-197`).

- Build bounded role, pronoun and appearance `identityHints` from the same allowlisted provider projection used for narrator context. Keep raw profile objects and extension properties out of the discovery prompt.
- `corroborates` and the prompt use those hints. Omitted hints keep stored jobs valid. Known characters are strict `castCharacterSchema` rows (`campaign-cast.ts:46-50`), so the hints need an explicit field in the identity snapshot schema.
- Publication validates again with `reconciled`, built from the current roster, and restores only `profile` from the capture (`campaign-cast-discovery-publication.ts:47-50`). It must also carry the captured hints by character ID, or strict corroboration fails at this second pass.
- Seeded characters leave the captured `worldCharacters` list, matched by active seed and world, so they do not appear twice or use the prompt budget twice. Bare `entityId` matching could hide a different character after a transfer.
- Merged-away and removed records still count for this filter and for the world lookup at `campaign-cast-discovery-publication.ts:53-56`. A merged-away match resolves to its target, so discovery never recreates a merged person.
- Stored jobs and pending candidates are not rewritten.

### Cast lifecycle integration

New commands do not get correct lifecycle behavior automatically. Each path below filters or remaps commands explicitly and must be extended for `seed_profile`, `edit_authored_profile`, and the phase 6 commands.

| Path | Current behavior | Required change |
|---|---|---|
| Rewind, `applyCastBoundaryChange` (`campaign-cast-lifecycle.ts:18-28`) | Later events keep only `create`, `observe` and `mention` commands with turn evidence at or before the boundary | Keep a `seed_profile` only when it is in the same event as its retained `create`, including first-appearance seeds. A seed applied to an existing record, and any `pin` in that event, are turn-gated like other edits. Drop later `edit_authored_profile`, merge, unmerge, remove and restore events. Add a test for discovery lag across rewind and branch |
| Branch and transfer, `copyCampaignCast` (`:61-103`) | `remap` converts only named ID keys; unknown IDs are copied unchanged | Add `seedEventId`, `sourceCharacterId`, `mergeEventId` and any new ID keys. Copy `seed_profile` regardless of event turn (`:103`) only when it shares an event with a copied `create`. Copy a merge only when both characters are copied |
| Projection, `snapshotProjection` (`campaign-cast-repository.ts:138-181`) | Commands other than `create`, `observe`, `mention` and `detach` fall into the override and revision path | Add explicit branches. Seed and edit build `originProfile` and `campaignProfile`. A same-event `seed_profile` extends `create`, so it is not gated by event turn at `:169`. Exclude `seed_profile` from `supportingTurns` (`:159-161`), so a seed does not keep alive a character whose identity turn was corrected away |
| Chronicle metadata (`campaign-cast-repository.ts:362`) | Refreshes only for `create` and `identity` commands | Also refresh for merge, unmerge, remove and restore. Merged-away and removed records leave the catalogs (`campaign-cast-chronicle-metadata.ts:14`, `chronicle-context-repository.ts:2387`, `campaign-cast-context.ts:35`) but keep counting for name uniqueness |
| Generation capture (`:204-222`) | Rewrites old-version world evidence as `historical_world` | Apply the same rule to seed evidence, and include authored profiles in the fingerprint input |
| Cast profile cache, `cacheSnapshot` | Stores the 11-field projected profile | Keep it as is, or extend it only if roster queries need authored values |
| Archives, `campaign-cast-portability.ts` | Imports remap named references explicitly | Validate v3 seed activations and edits and v4 lifecycle events. Remap seed, source-character and merge-event references. Require an earlier or same-event matching activation/merge for edits/undo, and preserve the campaign eligibility marker independently |

## Field policy

One policy table lives in `packages/client-core/src/characters/`, with an equivalent domain function the server uses. A contract test keeps the two aligned.

| Class | Paths | Automation | Hand edit |
|---|---|---|---|
| Identity command fields | Name and `identity.aliases` | Discovery never changes them on a seeded character | Uses the existing `identity` command; offers Reset to world value. Not valid in `set` or `reset` |
| Fixed when authored | `identity` except aliases, `story` except goals, `appearance`, `unclassifiedNotes` | Non-blank authored values never change | Writes `campaignProfile`; offers Reset to world value. Cannot be blanked |
| Discoverable when blank | The same paths when blank in `campaignProfile`, where a cast field exists | Discovery can fill them | Writes `campaignProfile`, which then fixes the field |
| Updates with story | `story.goals`, `state.location`, `state.condition`, `state.clothing` | Latest valid observation wins | Writes an override; offers Use discovered value. Goal overrides allow 20,000 characters, the world limit; the other fields keep 2,000 |
| Observed in story | `appearance.description` on a seeded character | Latest valid observation wins, never blanks | Writes an override; offers Use discovered value and Clear |

Effective value:

```text
Name and aliases:             latest identity command value
Seeded stable field:          campaignProfile (non-blank) -> projected observation -> Unknown
Non-seeded stable field:      override -> projected observation -> Unknown
Updates with story:           override -> latest valid observation (dated, lower authority while tracking lags or is off) -> authored value (goals only, when no usable observation exists) -> Unknown
Observed in story:            override -> latest valid observation -> not shown
```

`selectCastContext` runs its own projection (`campaign-cast-context.ts:63,73`), so it must use this same resolver, as must `snapshotProjection`.

Emptying an updating field's input clears its override, so the field returns to the story value. Only Observed in story has an intentional empty override, which hides that line until cleared. Empty values never reach narrator context.

### Appearance

Authored appearance uses the 12 structured world fields. The cast's single `appearance.description` field is never treated as authored on a seeded character.

- The sheet shows structured fields first, then a separate **Observed in story** line with its source link.
- It never changes or replaces an authored appearance field.
- The narrator receives authored fields first, joined as the main character's are (`campaign-cast-repository.ts:94-95`), then the observed line marked as lower authority.
- Non-seeded characters keep today's `appearance.description` behavior.

### Reset and restore

| Field state | Actions | Result |
|---|---|---|
| Fixed, world value hand-edited | Reset to world value | Returns to `originProfile` |
| World value blank, hand-filled | Clear | Removes the campaign value. The field returns to any discovered value, or to blank if there is none |
| Filled by discovery | Edit | Hand edit writes `campaignProfile` |
| Name or aliases changed | Reset to world value | Write identity using the active seed’s immutable `rosterName` and `rosterAliases`, replacing the campaign alias list. Preview any campaign-only aliases this removes |
| Goals | Use discovered value; Restore authored goals | Use discovered value clears an override. Restore clears any override and ignores goal observations whose evidence turn is at or before the Restore event's `effective_turn_number`; later ones apply again. The cutoff applies after supersession resolution, on the facts selected for goals, and is carried in the generation snapshot so the narrator receives the restored goals |
| Location, condition, clothing | Use discovered value | Clears the override |
| Observed in story | Use discovered value; Clear | Clear writes an override with an empty value |

### Badges and explanation

| State | Badge text |
|---|---|
| Authored and unchanged | World canon |
| Authored, hand-edited | Edited for this campaign |
| World blank, hand-filled | Added for this campaign |
| World blank, filled by discovery | From story |
| Updating field, no hand edit | Updates with story |
| Updating or observed field, hand-edited | Your edit |
| Observed appearance | Observed in story |
| Blank discoverable field with conflicting or claim-only observations | Needs attention |

Badges are text, never color alone. The editor shows this once above seeded fields: "The story can't change World canon fields. You can edit them for this campaign." A field whose effective value is blank after Clear shows: "Left blank, this can be filled from the story."

### Details

- Name and aliases use the existing `identity` command, which is what discovery and context read.
- World profiles have no location or condition, so these start blank. `appearance.clothing` is the fixed usual outfit, and `state.clothing` is what the character currently wears.
- Discovery still records observations that differ from a fixed field. They appear under sources but do not change the value, do not delete it, and do not create a review item or conflict count. Pending detail candidates aimed at a fixed field are excluded from the review inbox.
- Clearing a hand-filled discoverable field removes the campaign value, so any discovered value shows again or discovery can fill it later. An intentional permanent blank is not supported on seeded characters.
- `projectCastProfile`'s conflict rule (`campaign-cast.ts:61-64`) stays for non-seeded characters and for blank discoverable fields. It must never be reached for a non-blank fixed field; the effective-value resolver checks `campaignProfile` first.
- The existing override paths, including PATCH and review confirm (`campaign-cast-candidate-repository.ts:96-100`), reject every fixed or discoverable path on a seeded character, blank or not, with `cast_fixed_field_override`, so a save can't succeed with no visible effect. Web-Next shows that as an error until it adopts the shared editor. Each candidate read returns server-computed `allowedActions`. Both clients render only those actions. For a pending blank seeded stable field, offer Dismiss and a link to edit the field explicitly in the authored editor. Opening that editor does not accept a claim. Resolution rechecks allowed actions against current authority.
- `CastDetail`, typed write results, stored receipts and their replay carry full effective values for the 11 cast paths, with field-specific read limits: authored story fields and goal overrides up to 20,000 characters, pronouns and observed/state fields up to 2,000. The structured detail uses the world schema per path, including arrays and legacy notes. Observations remain capped at 2,000 for every path. Ordinary overrides retain 2,000 except goals at 20,000. Use separate read, observation and override schemas. Only compact roster display values may be shortened (200 characters per displayed summary); edits, conflict comparisons and Reset must load full detail. Capture uses its own bounded projection.
- Characters added by hand or found during play have no origin snapshot. They keep today's 11-field behavior, and the editor shows only those fields.

Main characters are not part of this policy. They keep their existing profile authority and are read-only to discovery.

## Narrator context

- For every new provider-bound character input (narrator, discovery hints, Suggest/expansion and Draft from story), project only the approved fiction fields using `character-fiction-authority.ts`. Strip credential and mechanics leakage, exclude reasoning blocks including their contents, and apply `validateCastFiction` to each outgoing value. Drop any unsafe remainder or unknown extension before assembling the payload. Apply the same rules to names, legacy guidance, bounded world text and citation text; exclude a citation if sanitization invalidates the supporting span. The owner-scoped editor retains original authored text.
- The new frozen generation snapshot stores only this safe projection for the authored subset. Cap each field at 600 characters after validation, applying the cap once to the joined appearance summary. Check the complete serialized envelope against token headroom during selection.
- `selectCastContext` emits fixed fields with a new `authority: "authored"`, sourced from the world evidence or edit event. This requires:
  - a context field key type covering profile paths, because `CastContextField.field` allows only the 11 cast fields (`campaign-cast-context.ts:7`, `:75`);
  - a stable per-field `evidenceId` composed from the supplying seed or hand-edit event ID and path, so a later campaign correction cites its own event;
  - `semanticRole` treating authored text as canon and hand-edited authored text as `corrected_state` (`:150-151`);
  - `SentCast.authority` accepting the new value (`:18`), and notice text defining authored authority (`campaign-cast-context.ts:56-57`).
- For campaigns using presets (an active seed in the cast), user overrides sort with their field's position, in the order below, rather than first. Other campaigns keep overrides first (amendment D1).
- During tracking gaps the latest usable goal observation is sent dated and lower authority, honoring the Restore cutoff. Authored goals are used only when no usable observation exists (amendment D2). A goal override is capped at the same 600 characters in context and the truncation is recorded (amendment D3).
- Field order within the existing budget (`castContextTokenBudget`, at most 3,000 tokens): role, pronouns, personality, voice, motivations, goals, appearance summary, observed appearance (marked lower authority), state, background, relationships, fears and conflicts, hooks, other guidance, notes.
- Reserve the serialized envelope and a minimum `{characterId, name}` for each admitted character in rank order, breaking ties by stable character ID. Omit and count identities that cannot fit. Zero headroom sends no cast block. Spend remaining tokens one field per admitted character per round in the order above. Complete the core rounds before optional fields. Preserve source and authority for every sent value, skip fields that cannot fit, and report budget omissions in the explanation. Count the actual serialized content including notices and source IDs.
- Seeded characters at turn 0 enter context when named, referenced in an open thread, or pinned. `alwaysInContext` maps to pin. In campaigns using presets, a character active in the last two turns ranks above a pinned character; other campaigns keep today's pin-first rank (amendment D1).
- Phase 3 versions the frozen cast snapshot/context protocol and Story prompt protocol together, per [ADR 0023](../../architecture/0023-structured-character-profiles.md). Preserve the old parser, canonical fingerprint, selector, notices and prompt renderer for already-admitted jobs, including retry after restart. New admissions freeze the compatible new pair and rebuild chains whose scoped protocol/configuration no longer matches. A stored snapshot fingerprint alone cannot select the renderer.

### Flags

Context depends on discovery today (`config.ts:301`), so presets would never reach the narrator without discovery.

- Add `CAST_CONTEXT_WITHOUT_DISCOVERY_ENABLED`, default false. Context is effective when `CAST_CONTEXT_ENABLED` and editing are on, and discovery is on or this opt-in is on. Installs with context on and discovery off therefore do not change at upgrade.
- Change the dependency in both `config.ts:301` and `instance-settings.ts:87`.
- Pass the real discovery flag at capture. `generation-authority.ts:257` hard-codes `discoveryEnabled: true`, so `discoveryStatus: "off"` is never captured.
- When discovery is off, use a notice that does not claim tracking is incomplete. Non-overridden `state.*` and goal observations are sent as dated, lower-authority last-known content. Today they are dropped when status is not `current` (`campaign-cast-context.ts:32`, `:82-83`).
- A campaign also needs Story Memory enrollment and capability (`campaign-cast-repository.ts:582-583`).
- Extend the capabilities at `server.ts:1032` with `castPresets` and `castContext`, and add both to the strict `metaResponseSchema` (`client-api.ts:85-89`). `castContext` means context is effective for the instance and `storyMemoryCapability` is installed.
- Update `docs/runbooks/campaign-cast.md`.

| State | World roster | Starting cast | Story and campaign page |
|---|---|---|---|
| Presets unavailable (flag or editing off) | Show authoring controls and explain that new copies are disabled | Hidden with explanation | Existing copies follow editing permission and the campaign’s effective context status |
| Presets on, context not effective for the instance | No notice | Shown, notice: "These characters will be tracked, but won't reach the narrator until character context is enabled." | Same notice in the panel |
| Context effective, new campaign | No notice | Shown, note: "Story Memory is set on the campaign after you create it." Shown with a link to enable it in the post-create result and on the campaign page | Per-campaign notice with the same link while not enrolled |
| Context on, Story Memory capability not installed | No notice | Shown, with the not-reaching-the-narrator notice | Same notice |
| Discovery off, context on | No notice | Shown | Fixed and hand-edited fields work. Updating fields stop changing, and the narrator receives their last-known values as dated, lower-authority content, with a notice |

Apply the table in two steps. First derive seeding controls from effective presets and editing. Independently choose one narrator notice, in order: installation context disabled or capability missing; campaign enrollment missing; installed capability below the enrolled level, then effective context with discovery off; fully effective context. Show the enrollment action only when it can help. Before creation use the installation status and a neutral post-create enrollment note. After success use the returned campaign ID and effective campaign status in the read-only result or campaign page.

Notices link to the Web-Next Settings page, Characters section, which is where these settings live. Where a viewer can't reach it, the notice says "An instance administrator can enable this."

#### Settings panel

Both new flags are installation settings in the Web-Next Settings panel, Characters section, alongside the other cast flags. This is an in-scope exception to the Web-Next deferral, because that panel is the only place installation settings are managed.

| Setting key | Environment variable | Panel label | Depends on |
|---|---|---|---|
| `castPresetsEnabled` | `CAST_PRESETS_ENABLED` | Character presets | Cast editing |
| `castContextWithoutDiscoveryEnabled` | `CAST_CONTEXT_WITHOUT_DISCOVERY_ENABLED` | Character context without discovery | Cast editing |

They follow the existing registry path:

- Add both to `instanceSettingsSchema` and the feature-key types in `packages/contracts/src/instance-settings.ts`. Stored settings saved before this change have no value for them, so a stored-snapshot reader supplies false. The patch schema must have no defaults, because `instanceSettingsChangesSchema` is `.partial()` of the full schema, and zod applies defaults through `.partial()`, so any save touching another key would otherwise reset both flags to false.
- Keep the deployment policy valid on upgrade. `settingsFeatureGatesSchema` is strict with required booleans and is embedded in the policy (`instance-settings.ts:16-22,68`), and the runtime compares a digest of the parsed policy (`runtime/instance-settings.ts:38`, `local-single-user-settings.ts:21-22`). Add a policy version: a policy of the earlier version loads with both gates absent, without a digest mismatch.
- Local single-user installs permit both flags, and also `castContextEnabled` and `castEditingEnabled` when they were off at seed, from the panel alone, without depending on the original seed value (amendment D15). Managed deployments require the environment variable and a re-issued policy, and until then the panel shows `deployment_disabled` with that explanation.
- Add both to `INSTANCE_SETTING_FIELDS` with `section: "characters"` (`packages/domain/src/instance-settings.ts`). They apply on restart, like the other settings.
- Add display labels in `apps/web-next/src/settings/page.ts:20`.
- Add both to `packages/database/src/config.ts`, `compose.yaml` and `deploy/swarm/stack.yaml`, and to the runtime composition that reads the cast flags.
- Add a migration (next number 0129) replacing the `instance_settings_events_changed_keys` constraint from migration 0122. It allows at most 40 keys and names each one, and the registry already has 40 fields, so saves would otherwise fail. The contract history schema has the same cap of 40 (`packages/contracts/src/instance-settings.ts:101`); derive it from the registry.
- `resolveInstanceSettings` allows one parent per setting (`instance-settings.ts:85-88`). Add both new settings with cast editing as parent. `castContextEnabled` needs a special rule: it is forced off and locked unless discovery or the opt-in is on, and cast editing is on.
- Extend the settings unit, integration and panel end-to-end tests that enumerate these keys.

## Shared editor

The repository's boundary checks prohibit DOM manipulation in `client-web` and `client-core` (`scripts/check-client-boundaries.mjs`). The editor therefore has two layers.

### Model: `packages/client-core/src/characters/`

No DOM, no platform globals, no random IDs; callers pass idempotency keys in.

- One field-descriptor list, replacing `CHARACTER_PROFILE_FIELDS`. Each entry has path, label, input type and limit, plus section and group (core or optional) per context, because the World and Story layouts differ (`profile-fields.ts:8-9`, `management-ui.test.ts:1525-1526`). `PROFILE_FIELDS` and `SUPPORTING_FIELDS` stay as exports derived from it, with their current order and shape, until Web-Next adopts the model.
- Aliases are entered one per line in every context. World mode's comma-separated input changes to match.
- Field policy table.
- `CharacterEditorContext`:
  - `world-draft`
  - `campaign-main`
  - `campaign-preset`
  - `campaign-supporting`
- Each context defines visible fields, sections, actions, badges and lock rules.
- Draft state, validation, including the duplicate-name warning, and dirty tracking. Model dirty state replaces the DOM snapshot comparisons in Nexus and Story (`nexus.js:618-628`, `story.js:935`).
- The save builders in `client-core` keep the reviewed Organize proposal’s `protocolVersion` alongside `editSource: "ai_organized"`. Applying a proposal stages both. Preserve them through later edits and conflict/reapply while an accepted change remains. Campaign PUT sends `organizerProtocolVersion` and records it in audit history. Discarding the proposal and its changes clears its provenance. Bind it to the accepted proposal, never the current default version.
- Conflict state and "reapply my changes" for campaign contexts. `world-draft` applies locally and has no save revision.

### Renderer: `apps/web/src/character-editor/`

Vanilla TypeScript DOM, imported by both `nexus.js` and `story.js`, built from the model.

- Replaces the static fields in `index.html:895` onward, the Story main-character form, and the panel's `renderEditor`.
- World mode must keep the `#characterDialog` element, its control IDs and its nesting, so browser tests remain valid.
- The renderer mounts before `nexus.js` builds its element map (`nexus.js:19`), so `elements[id]` lookups keep working. The busy lock on `<summary>` elements moves to event delegation, because disclosures can render after load (`nexus.js:761-765`).
- `tests/unit/management-ui.test.ts` reads the static HTML and `nexus.js` source text (`:1508-1615`). Phase 1 moves those assertions to rendered-DOM checks, keeping what each one verifies.
- Context-only sections plug in through slots defined per `CharacterEditorContext`, following the table below. The model takes both the context and the host page. Organize is campaign-page only on `campaign-main`, the lock source differs by page, and the sources link is Open in Story on the campaign page.
- Styling stays with Nexus CSS, with a shared class set for both pages.

### Behavior by entry point

| Behavior | World edit | Main character | Preset NPC | Found or manual NPC |
|---|---|---|---|---|
| Opened from | World edit screen | Campaign page, Story | Campaign page, Story | Campaign page, Story |
| Fields | All | All | All | 11 cast fields |
| Required to save | Selectable: name plus guidance or legacy text. Supporting: name only | Name and a valid profile contract; guidance is not required (amendment D10) | Name | Name |
| Legacy guidance (`characterText`) | Read-only where present, included in Organize input | Read-only where present | Read-only source text alongside structured fields. Show a legacy-only fallback once | Not shown |
| Create | Add to draft | No | Add from world | POST cast create, keeping draft reapply (`campaign-cast-panel.ts:317-320`) |
| Save target | World draft, then Save world | Existing profile endpoint | Atomic authored-profile route | Existing cast PATCH |
| Primary label | Apply to world draft | Save character | Save character | Save character |
| Campaign use setting | Yes | No | No | No |
| Mechanics | Unless Supporting | Hidden, as today | No | No |
| Badges | None | None | See [Badges](#badges-and-explanation) | Your edit, From story |
| Reset | No | No | See [Reset](#reset-and-restore) | Use discovered value |
| Pin and Ignore | No | No | Yes | Yes |
| AI | Generate from concept (hidden for Supporting until phase 5), organize | Organize, campaign page only | Draft from story | Draft from story |
| Delete | Remove from draft | No | Remove, phase 6 | Remove, phase 6 |
| Editing off | Not applicable | Unchanged from today | Read-only, draft kept | Read-only, draft kept |
| Locked during generation | No | Yes, including recovery | Yes | Yes |

Lock source and live update: Story uses its existing state, and the campaign page uses the [generation read](#campaign-page). A lock that begins with an editor open disables its controls and keeps the draft (`story.js:1090`, `1104-1106`).

Generate from concept in `world-draft` keeps the draft's `id`, `source`, `campaignUse`, `startingCastDefault` and `alwaysInContext`, because the server parse would otherwise reset use to `playable` (`character-authoring.ts:147`, `nexus.js:4059-4064`). From phase 5, the Supporting run keeps stored `rpgStats` and `defaultTriggers`.

Ship the shared existing-character merge and validation guards with phase 3 in Nexus, Web-Next synchronous regeneration, durable proposal review/resume and server authoring apply. Build from the owner-loaded target, preserve its ID, source, use and cast defaults, and keep hidden mechanics for Supporting. A parsed provider default cannot change these fields. A name-only Supporting character passes review. Until phase 5, guard Supporting regeneration on both clients; resumed older jobs still pass through the preserving merge.

The Story panel keeps its roster, sources, match review, tracking status and scans. The World screen keeps its roster and publishing flow. The campaign page lists characters and links to Story for those tools. Only the editing step is shared.

### Interaction rules

| Situation | Rule |
|---|---|
| Open | Focus the first field. Disclosures use one rule: core section open, optional sections closed. Exceptions: a new World character opens the generator and focuses its prompt when available (`nexus.js:3076-3078`), and an existing Supporting character keeps Appearance open (`campaign-cast-panel.ts:282`) |
| Validation error | Open the containing section, focus the first invalid field, link errors with `aria-describedby` |
| Reset, Clear or Restore | Keep focus on that field's control or its replacement, and announce the result |
| Save | Return focus to the control that opened the editor, or the sheet heading |
| Revision conflict (campaign contexts) | Keep the draft, focus the conflict message, offer Compare latest, then Reapply my changes or Discard draft and load latest |
| Close with unsaved changes | One staged confirmation with Keep editing and Discard. Campaign contexts also offer Save changes |
| Progress, such as "2 of 5" | Announce through a polite live region |
| Narrow screens | One column, tap targets at least 44px |

The renderer must not rely on rebuilding the form while preserving focus by element ID (`campaign-cast-panel.ts:256`). Follow `docs/ui/ACCESSIBILITY_SPEC.md`.

## API

One route saves a preset NPC in a single cast event, so authored and updating fields cannot partly save:

```text
POST /api/v1/campaigns/:campaignId/cast/:characterId/authored-profile
Body: castWriteBase + expectedCharacterRevision + {
  set?: {path: string | string[]}, reset?: [path], restoreAuthoredGoals?: true,
  setOverrides?: CastOverrideValues, clearOverrides?: [CastField],
  name?, aliases?, resetIdentity?: true, pinned?, ignored?, draftEvidenceFences? /* phase 5 */
}
Success: 200, castWriteResult; the editor reloads CastDetail to refresh badges
```

- Rejects non-seeded characters and the main character.
- `set` and `reset` accept only fixed and discoverable paths, excluding `identity.aliases`. `setOverrides` and `clearOverrides` accept only updating and observed paths.
- `resetIdentity` uses only the active seed’s immutable roster name and eligible aliases. It is mutually exclusive with submitted `name` or `aliases`.
- A path cannot appear in both set and reset forms. The body must change at least one field.
- The client sends changed fields only.
- `CastDetail` adds `originProfile`, `campaignProfile` and each field's effective source: `authored`, `campaign_edit`, `override`, `observation` or `none`. Roster list rows need only what roster display uses. The compatibility field `character.profile` in typed detail and receipts follows the full effective limits. Compact list summaries must never feed save payloads.
- `POST cast/from-world` returns 201 when it creates a record and 200 when it seeds an existing one, with `castWriteResult`.
- Validation failures return `details.fields: [{ path, code }]`, and `CampaignCastError` gains that field.

### Route summary

| Route | Phase | Admission | Body limit | Error codes added (HTTP status) |
|---|---|---|---|---|
| `POST campaigns` | 4 | Existing | Existing | `cast_presets_disabled` (503) |
| `cast/:id/authored-profile` | 3 | Standard write | Whole legal multi-field request, including array limits, JSON escaping and UTF-8 bytes. Cover worst-case canonical client serialization | `cast_not_seeded`, `cast_invalid_field_class` (422) |
| `GET cast/from-world-preview` | 3 | Standard owner-scoped read | Query only | `cast_world_character_unavailable` (404), `cast_presets_disabled` (503) |
| `POST cast/from-world` | 3 | Standard write | 64 KiB | Same missing/disabled errors and `cast_world_preview_changed` (409) |
| `worlds/playable-characters/suggest-cast-preview` | 5 | Add to `GENERATION_POST` | Match generate-preview | Existing authoring codes |
| `cast/:id/draft-preview` | 5 | Add to `GENERATION_POST` | 64 KiB | Existing authoring codes |
| `cast/:id/merge`, `unmerge`, `remove`, `restore` | 6 | Standard write | 64 KiB | `cast_merge_invalid` (422), `cast_character_removed` (409) |
| `cast/:id/promotion-preview`, `promote` | 6 | Standard read and write | Sized to field limits | `cast_promotion_conflict` (409) |

`cast_fixed_field_override` (422) is added in phase 3 for existing override paths. `campaign-cast-routes.ts:36-37` sends unlisted codes to 409, so each code above must be mapped. `CampaignCastError` is a closed union (`ports.ts:20`), and `request-admission.ts:24-31` is an explicit allowlist, so both must be updated. The cast route registers a fixed 64 KiB limit (`campaign-cast-routes.ts:14`), so limits become per-route. Every route gets contract schemas in `packages/contracts` and methods in `packages/client-web`.

Apply the same whole-request sizing rule to existing edit/create routes that accept long goal overrides. In phase 5 add the bounded evidence-fence schema to both ordinary PATCH and authored-profile POST, include those bytes in admission limits, and map `cast_draft_evidence_changed` to 409 in both routes. The preview returns fences for the factual fields it proposes.

### Nexus use of the API

Nexus uses the typed cast client for all campaign character work, rather than new `api()` calls.

- Use `createCampaignCastApi` from `@infinite-quest/client-web`, the client `apps/web/src/composition.ts:228` provides to Story. `nexus.js` already imports from that package.
- Responses are validated by contract schemas, and Web-Next can use the same client.
- The scope is limited to character features. Other `nexus.js` calls are not migrated.
- World draft editing stays local until Save world, on its existing path. The new world preview route gets a typed method in `client-web`.
- Main-character editing keeps its existing endpoints, wrapped in the editor's save adapter.

#### Typed client conversion

Nexus already reaches these routes through the `api()` helper (`nexus.js:1237`). Conversion replaces that helper with typed `client-web` methods for the character functions this work touches. Server routes do not change. Each function converts in the phase that already touches it.

| Nexus function | Route | Typed method | Work | Phase |
|---|---|---|---|---|
| `generateCharacterFromPrompt` | `POST /worlds/playable-characters/generate-preview` | Move Web-Next's private `generateCharacterPreview` and progress call (`character-workspace-api.ts`) into `client-web` | Small to medium | 1 |
| `organizeCharacterProfile`, world scope | `POST /worlds/:id/draft/playable-characters/organize` | Add | Medium, shared with the row below | 1 |
| `organizeCharacterProfile`, campaign scope | `POST /campaigns/:id/character-profile/organize` | Add | Medium, shared with the row above | 1 |
| `openCampaignCharacterDialog` | `GET /campaigns/:id/character-profile` | `getCharacterProfile` exists | Very small | 2 |
| `saveCharacterFromModal`, campaign scope | `PUT /campaigns/:id/character-profile` | `updateCharacterProfile` exists | Small | 2 |
| `loadWorldVersionPlayableCharacters` | `GET /world-versions/:id/playable-characters` | `playableCharacters` exists | Very small | 4 |
| `loadCampaignCreationCharacters` | `GET /world-versions/:id/playable-characters` | `playableCharacters` exists | Very small | 4 |
| Campaign creation submit | `POST /campaigns` | `campaigns.create` exists | Small | 4 |

Estimated total: 2 to 3 days. This is an estimate from reading the code, and most of it is compatibility work.

Requirements:

- Web-Next switches its generate and progress calls to the moved `client-web` methods, so one copy remains. Its existing error kinds and sanitization keep working.
- A small adapter gives Nexus one error shape. It preserves the message, status code, reference ID and details that `nexus.js` displays or reads (`nexus.js:2743`). `parseHttpError` must keep `message` and `code` from partial bodies, because admission responses are not full envelopes (`http-client.ts:90-97`, `request-admission.ts:113`, `:126`) and an adapter after the client can't recover them.
- `progressKey` stays optional in the typed generate method, a contract schema replaces the hand-written progress parser (`character-workspace-api.ts:140-158`), and sanitization stays in Web-Next, running before the `client-web` call.
- The campaign page's generation read uses `GET /campaigns/:id/sync-status` through the typed generation client.
- The typed client rejects responses that `api()` accepted. Test each converted call with older, imported and legacy-shaped data, including characters with no `profile`. Where valid stored data fails a contract, correct the contract rather than loosening validation generally.
- Do not convert world draft save (`nexus.js:3967`), version publish (`:4299`) or unrelated `nexus.js` calls.

The conversion supports later Web-Next adoption, but the larger saving comes from the shared `client-core` model.

## Nexus UI

### World roster and dialog

- Update `renderPlayableCharacterRoster` rows to show name, role, use, and completeness, with Duplicate and reorder.
- Completeness means: selectable characters have guidance, and Supporting characters have a role or any story field.
- Duplicate creates a new opaque ID and the name "{name} copy", and keeps mechanics.
- Add a Use in campaigns control. Replace hard-coded "Playable character" and "playable character" text, sweeping `index.html`, `nexus.js` and `campaign-creation-draft.ts`. Known sites: `index.html:825`, `:851`, `:854`, `:855`, `:865`, `:901`, `:914`, `:1054`; `nexus.js:3056`, `:3066`, `:3154`, `:3416`, `:4430`, `:4734`, `:4758`, `:4803`, `:4829`; `campaign-creation-draft.ts:41`, `:56`. `nexus.js:3056` overwrites `index.html:914` at runtime.
- World-draft validation (`characterFromForm`, `nexus.js:3127-3133`) requires only a name for Supporting characters, and applies the guidance rule to selectable characters.
- Add a one-time note for existing worlds: "Existing characters stay Playable. Change one to Supporting to make it an NPC."
- Show Starting cast default and Always include when the use is Supporting or Both.
- Warn early when a roster has no selectable character.

### Campaign creation

In the dialog at `nexus.js:4710-4859`:

- Limit the main-character picker to selectable characters.
- Keep `characters` in the world-version character list response (`client-api.ts:166-172`) selectable-only, because `nexus.js:4754-4756` and `campaign-creation-draft.ts:38` depend on it. Add a `startingCastCandidates` array, built from the unfiltered roster, with use, defaults, role and a short summary. This changes `world-repository.ts:1439` and the `PlayableCharacterSummaryView` port.
- Add a Starting cast checklist with Supporting and Both characters, excluding the chosen main character.
- Pre-select `startingCastDefault` characters in roster order, up to 30. Show "N of 30 selected", and disable further ticks at the cap with an explanation.
- Each row shows role and an expandable summary, and offers Always include. Above 5, warn: "Always-included characters take up narrator context in every turn."
- Show search when there are more than 10 rows. One column at 390px.
- Changing the main character updates the list and keeps other selections. A character returning to the list returns to its previous tick.
- Empty state: no Supporting characters, with "Add NPCs in the world editor."
- Character and cast data come from one request. On load failure the dialog shows a retry, and creation stays blocked until it succeeds, as it does today (`nexus.js:4764-4769`, `:4820`).
- Extend `campaign-creation-draft.ts` and `buildCampaignCreateRequest` so ticks are kept while the dialog is open. Closing the dialog or refreshing discards them; Nexus keeps this draft in memory only (`nexus.js:4745`). Stale IDs are dropped with a notice.
- The Infinite Worlds import path passes no starting cast. Those campaigns can use Add from world.

### Campaign page

In the campaign panel (`index.html:221`, `nexus.js:4176`):

- Rename **Edit character profile…** to **Edit characters…**.
- It opens a searchable list with the main character first, then the shared editor for the chosen character. Add from world is available.
- Saves use the same paths as Story. With `editing` off, NPCs are read-only.
- Check generation state before opening an editor and before saving, and show the same lock message as Story. The server remains the final guard.
- The lock read is `GET /campaigns/:id/sync-status`. Locked means `pendingGeneration` is present or `generationRecovery.status` is `recoverable`, matching the server (`campaign-cast-repository.ts:407`). `failed` does not lock, in Story or on the campaign page (amendment D14).
- Sources, review, tracking and scans remain in Story, with an **Open in Story** link that opens the panel at the chosen character. Add a `character` query parameter to `/story/:id`, and let the panel's `open()` take a character ID.
- Archived campaigns allow character edits and Add from world, as they do today.

### Story cast panel

In `campaign-cast-panel.ts`:

- Field badges and the Observed in story line, from [Field policy](#field-policy).
- Add from world, and Apply world profile to {name}.
- Quiet "Story differs" note linking to sources on fixed fields where a differing observation exists.
- Hide empty fields on the sheet, with a Show empty fields control.
- Show the selected character in the sidebar with `aria-current`.
- Use friendly labels in sources instead of raw paths, such as `story.role`.
- Show main-character provenance once at profile level using the read contract: “World snapshot” for snapshot fallback or “Campaign profile” for a stored profile, including the initial world copy. Avoid claims about who edited individual fields. Imported records with no reliable source can show “Source unavailable.”
- One Needs attention inbox replacing the separate entry points (`campaign-cast-panel.ts:174-177`). It lists identity questions, then withheld details, then conflicts, each with its count. A conflict row links to that character's editor at the field, since conflicts have no candidate to resolve. The inbox is a panel-level wrapper. Update the shared `cast-review-queue.ts` to honor per-item `allowedActions` in both clients. Scans, context preview and Refresh characters stay as tools.
- Main-character conflict recovery matches Reapply my changes.

These findings came partly from the Web-Next surface. Items not already confirmed in `campaign-cast-panel.ts` must be checked there before implementation.

## Automation

All AI is user-triggered and reviewed. Nothing saves automatically.

| Feature | Behavior | Phase |
|---|---|---|
| Duplicate-name warning | Warn in both editors. Same-name characters stop unique-name matching (`campaign-cast-discovery.ts:189`) | 2 |
| Background updates | Updating fields apply automatically with sources and undo | Existing paths |
| Suggest a cast | See below | 5 |
| Convert entities | See below | 5 |
| Draft from story | See below | 5 |
| Merge, Remove, Promote to world | See [Campaign character lifecycle](#campaign-character-lifecycle) | 6 |

Rules for every AI feature:

- It runs only when a person asks for it. World features use the default text provider. Campaign features use the campaign's selected provider and fall back as campaign organize does (`provider-character-organization-adapter.ts:303-307`).
- When no provider is available, the control stays visible with setup guidance and manual entry still works.
- Results fill a preview or draft. Only the normal save path persists them.
- A failed request preserves every value the person had.
- Logs follow the existing authoring rule: no prompts, source text, rejected output, credentials or raw provider errors.
- Story text and authored text sent to a model are untrusted data, never instructions.

### Suggest a cast

**Purpose:** generate several Supporting characters for a world, so authors don't start from a blank roster.

**Entry point:** a Suggest cast button beside `+ Add character` in Mechanics & Characters. It works on the unsaved world draft.

**Flow:**

1. The author optionally enters direction and chooses a count from 3 to 8, default 5.
2. The server returns compact seeds in one provider call.
3. The author reviews the seed list, editing names or concepts and unticking any they don't want.
4. The client expands each ticked seed with one provider call, one at a time, showing progress such as "2 of 5".
5. The author reviews each finished character, and can open it in the shared editor, regenerate it, or drop it.
6. **Add selected to draft** appends the characters to the local draft. **Save world** remains the only persistence step.

This follows the world and character split in `2026-07-26-split-world-character-generation-design.md`, so a long response can't consume the budget needed to complete each character.

**API:**

```text
POST /api/v1/worlds/playable-characters/suggest-cast-preview
Body: { content: WorldContent, direction?: string (max 10,000), count: 3..8 }
Response: { seeds: [{ seedId, name, role, concept (max 1,000) }] }
```

Expansion reuses `POST /api/v1/worlds/playable-characters/generate-preview`, with new optional `seed: { name, role, concept }` and `campaignUse` fields. The dialog states the maximum number of provider calls before starting: one for seeds and one per ticked seed, plus repairs.

**Rules:**

- Give the provider a deterministic sample of roster and eligible character-entity names within the existing character-authoring context budget. Use at most 100 names and 4,000 characters in total, or fewer if prompt headroom is smaller. Enforce collision checks server-side against every eligible name, including those omitted from the prompt.
- The server drops seeds whose normalized name matches another seed, a roster character or a `character` entity. It returns fewer seeds rather than renaming them. Return zero through the requested count. For an empty result, offer Edit direction and Retry. Retries are explicit and there is no automatic refill call.
- The generated name must match the seed. A mismatch goes through the normal repair path, and the collision check runs again. Today only the world-seed path enforces names (`provider-world-generation-adapter.ts:94`).
- Include `character`, `person` and `npc` entities in the collision set and bounded name sample.
- With `campaignUse: "supporting"`, generation does not produce mechanics, and any returned are discarded. Mechanics are required by `CHARACTER_CONTRACT` and the `standalone_character` response contract, so add a separate supporting contract with its own protocol ID. `CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION` is shared with durable jobs and must not change.
- Suggest and Draft each need a new prompt path, native operation, repair operation, response schema and output cap. Snapshots are built only from `legacyPromptTemplateKeys`, and `promptSnapshotSchema` is strict (`prompt-repository.ts:149`, `prompt-library.ts:127-132`), so adding a legacy key breaks stored snapshots. Use a non-legacy path, as continuity prompts do. Operation and response lists are closed (`provider-output-schema.ts:33-36`, `text-response-format.ts:77-78`).
- Results get `campaignUse: "supporting"`, new opaque IDs, and `startingCastDefault: true`.
- The author can stop the run. Finished characters stay, and the remaining ones are marked not generated.
- Each failed row has its own Retry. It does not affect other rows.
- The dialog warns before closing with unadded results. Results do not survive a page refresh, and this is stated in the dialog.
- The add step fails with a clear message if the roster would exceed `MAX_PLAYABLE_CHARACTERS`.

**Future option:** add a durable `cast_suggestion` kind to authoring jobs if refresh survival becomes important.

### Convert entities

**Purpose:** turn NPCs stored as generic world entities into roster characters. No provider is required.

**Entry point:** a **Convert entities** button beside Suggest cast in Mechanics & Characters, shown when eligible entities exist. Nexus has no entity list of its own; the entity editor exists only in Web-Next.

**Eligibility:** entities whose type matches the rule already used for discovery hints, `character`, `person` or `npc`, and which are not already linked.

**Field mapping:**

| Entity value | Character field |
|---|---|
| `name`, `title` or `label` | `name` |
| `aliases`, `alias` | `profile.identity.aliases` |
| `role` | `profile.story.role` |
| `background`, `lore` | `profile.story.background` |
| `description`, `summary`, `details`, `notes` | `profile.unclassifiedNotes` only, which stays editable and reaches Organize |
| Other properties | Listed in the preview as not converted |

**Flow:**

1. A preview lists each eligible entity, the resulting fields, and any values not converted.
2. The author ticks entities to convert.
3. **Convert** appends Supporting characters to the local draft with `startingCastDefault: false`, and sets a link on each entity. Rows with no usable guidance are allowed and flagged, and never block campaigns. After adding, the author can open a character in the shared editor and use Organize, which requires world edit mode and a persisted draft (`nexus.js:3015`, `provider-character-organization-adapter.ts:374`).

**Linking:** the entity stays in the world and gains `linkedCharacterId`.

- World context and relationship records keep working, including when character context is off.
- Resolve each valid `linkedCharacterId` to one roster identity in a shared function consumed by discovery and Chronicle. Entity IDs remain relationship endpoints. The roster name and its explicitly retained aliases control lexical matching. On rename, a previous entity name survives as an alias only if the author keeps it in the conversion preview. Show any ambiguous alias shared with another person; both consumers must withhold unique matching. Reject stale links on draft save and publish.
- Fold existing cast rows whose scoped origin refers to the linked entity or roster entry into that same identity for catalog matching. Respect campaign identity edits and the pinned version. Preserve the standalone entity’s descriptions and relationships when character context is off; alias lookup uses the shared rule.
- Removing the linked character clears the link in the same draft edit.
- Character IDs are new and opaque. `source` records `{ type: "world-entity", entityId }`.
- Name collisions with a roster character block that row until the author renames it or unticks it.

### Draft from story

**Purpose:** fill gaps on a campaign NPC from what the story has established.

**Entry point:** **Draft from story** in the shared editor for `campaign-preset` and `campaign-supporting`. It is disabled during story generation and when the character has no eligible citations, and the server returns a no-provider result in that case, so no paid call is made.

**API**, modeled on the campaign organize path:

```text
POST /api/v1/campaigns/:campaignId/cast/:characterId/draft-preview
Body: { expectedCastRevision, expectedBoundary, expectedCharacterRevision, direction?: string (max 2,000) }
Response: { boundary, characterRevision, proposals: [{ path, value, evidenceIds: [...], draftEvidenceFence? }], evidence: [{ evidenceId, characterId, turnId, turnNumber, narrationRevision, sourceHash, paragraphId, start, end, quote /* max 1,000 */ }], omitted: [{ path, reason }] }
```

**Input to the model:**

- Send safe, bounded names, aliases and effective values through the provider projection in [Narrator context](#narrator-context).
- Select up to 40 recent fact-eligible spans and 24,000 characters in total from effective accepted narration. For each span verify the character, exact quoted text, attribution and depicted fact using the discovery subject/speech/negation rules. A mention can locate a passage but cannot itself establish a fact. Exclude other subjects, dialogue claims, negated or hypothetical statements, corrected text and detached evidence.
- Bind each evidence ID to its scoped character, turn, narration revision/hash and exact paragraph offsets. Resolve IDs on the server; use the original narration for validation and safe spans for the prompt.
- World premise and tone, bounded as in other authoring prompts.

**Output rules:** the server rejects the whole response when it is malformed. It drops an individual proposal, listing it in `omitted`, when:

- the path's effective value is not blank, is an updating or observed path, or is not available in the character's context;
- an evidence ID is unknown, stale or belongs to another subject, or the cited span fails to support the proposed field and value; factual values must be extractable from their cited spans after documented whitespace/case normalization;
- the value fails `validateCastFiction` or exceeds the field's limit;
- it has no evidence ID and is not `story.otherGuidance`. Label that exception “Creative guidance”; it still requires an eligible preview and an explicit hand save.

**Review:**

- Each proposal appears beside the current value with cited quotes and turn links.
- Proposals are labeled as suggestions, ticked individually, and fill the draft only when applied.
- Saved values follow normal hand-edit rules, so they carry no observation authority and do not count as evidence.
- For both ordinary PATCH and authored-profile saves, the draft carries server-verifiable `draftEvidenceFences` for accepted factual proposals, bound to campaign, character, field, proposed value and cited spans. Recheck effective narration, subject, attachment status, blank eligibility and revisions in the save transaction. A stale fence returns `cast_draft_evidence_changed` (409), preserves the draft and offers a fresh preview. Reapply cannot bypass the check. Direct manual entry remains available and is recorded as a hand edit.

This is a creative proposal and stays separate from discovery extraction. It never creates observations, mentions or attachments.

**Prompt:** add a versioned catalog entry following the shape of `cast-discovery-prompt-v1` (`prompt-library.ts:45`), through the non-legacy path described under Suggest a cast, with `campaignOverrideAllowed: false` like other World authoring prompts.

## Campaign character lifecycle

Phase 6 is specified here but releases separately from phases 1 to 5. It adds commands to `castCommandSchema` and moves them through the [lifecycle table](#cast-lifecycle-integration). All are gated by cast editing, blocked during story generation, require expected cast revision, boundary and character revisions, and are idempotent. Promote writes no cast event, so its idempotency receipt is stored with the draft write. Activate the lifecycle writer deployment only after all live and archive consumers support v4. Promote receipts are operational retry state scoped to the owner and draft; classify and exclude them from portable archives. The resulting world fields and typed provenance are portable.

Route bodies, in addition to `castWriteBase`:

```text
merge    :id = target. { sourceCharacterId, expectedCharacterRevision, expectedSourceRevision, reviewedAliases: string[], choices: Record<FieldPath, "source" | "target"> }
unmerge  :id = target. { mergeEventId, expectedCharacterRevision }
remove   { expectedCharacterRevision }
restore  { expectedCharacterRevision }
```

The merge preview is computed by the server under owner scope and returned through a read-only preview route, so the client and the write use the same rules.

### Merge

**Purpose:** combine two campaign records that are the same person.

**Commands:**

```ts
{ kind: "merge", characterId /* target */, sourceCharacterId, reviewedAliases, choices, aliasChanges /* added and removed, with provenance */ }
{ kind: "unmerge", characterId /* target */, mergeEventId }
```

Record the reviewed aliases, normalized additions and removals, prior target aliases, field choices and their authority in the merge event. Replay groups generated identity and field edits with that event. Undo reverses the merge-owned changes and replays subsequent independent target edits. Record explicit alias additions/removals on later target edits so Undo preserves a re-entered alias and does not revive an explicitly removed one. Show the resulting identities before Undo commits.

**Validation:** the server rejects a merge when:

- source and target are the same, or belong to different campaigns;
- either one is the main character;
- either one is removed or already merged away;
- only the source is seeded, in which case the preview makes the seeded record the target;
- the submitted aliases fail fiction validation, exceed 20 after normalization, duplicate one another, or fall outside the union of the two records’ names and aliases. The target display name stays canonical. When the union exceeds the limit, require explicit trimming in the preview.

**Projection:**

- The source is hidden and records `mergedInto`.
- Source observations, mentions and speaker references count as the target's. Stored rows are immutable, so projection rewrites character IDs on a projected copy before validators run (`packages/domain/src/campaign-cast.ts:40`, `:47`; `packages/contracts/src/campaign-cast-context.ts:24`). Supersession chains are resolved on that copy.
- `firstObservedTurn` becomes the earlier of the two; last-observed values are derived as usual.
- The target keeps its origin, pin and ignore state.
- The reviewed alias list becomes the target’s list. Omitted names stay in the event history.

**Field resolution** in the merge preview:

| Case | Result |
|---|---|
| Distinct manual values on both records, including an intentional empty observed-appearance override | Require an explicit source or target choice. Preserve the chosen manual authority and show the displaced value |
| One manual value, other side observed or absent | The manual value wins. For a non-blank fixed target, show the authored value first and require an explicit choice to replace it with the source as a campaign edit |
| Stable values with no manual edit | A non-blank fixed target wins by default. Permit an explicit source choice as a hand edit. Carry a sole populated value. Require a choice for conflicting observations. Persist a stable choice as a campaign edit on a seeded target or override on an ordinary target |
| Goals, state and observed appearance | Apply manual precedence first. Otherwise use the latest valid fact across both histories, then the target’s authored goal fallback where applicable |
| Both seeded | Target's snapshot stays as `originProfile`; the source's snapshot is retained for undo only |

**Dependencies to update:**

- Detach compares `attachment.characterId` directly (`campaign-cast-repository.ts:129`, `:282`, `:285`, `:466`), and `:618` filters automatic matches the same way. The route and the `:618` filter accept the target ID and resolve merged IDs. The stored detach keeps the attachment's original `characterId`, so `:129`, `:285` and export validation (`packages/contracts/src/campaign-cast.ts:162`) stay correct.
- Discovery snapshots exclude merged-away characters. A stored job whose captured identity was later merged keeps publishing to the captured source ID, which remains a valid row, and the projection credits it to the target. Undo and rewind therefore need no compensation. The publication guards (`campaign-cast-discovery-publication.ts:40-43`, `campaign-cast-discovery.ts:167`) compare against the merge-resolved identity and tolerate aliases the merge added.
- Pending review candidates stay unchanged. `proposal.existingCharacterId` and `resolution_receipt.result.character.id` resolve through active merges at read and resolve time. This covers `campaign-cast-candidate-repository.ts:27`, `:38-41` and `:73`, and attention counts at `campaign-cast-repository.ts:549-552`.
- Chains resolve transitively. A merged-away character cannot be a merge target.

**Undo:** the target's sheet lists **Merged from {name}** with **Undo merge**. Undo is available until a later merge that is still active involves either character, and restores both records and the merge's field choices. Hand edits made to the target after the merge remain. A restored source and target that share a name hold later mentions for review, as any same-name pair does.

**UI:** **Merge with another character** on the sheet opens a searchable chooser, then the side-by-side preview. Nothing changes until **Confirm merge**.

### Remove

**Purpose:** take a mistaken or unwanted character out of the cast. Ignore stays available for a real character who shouldn't be in context.

**Commands:** `{ kind: "remove", characterId }` and `{ kind: "restore", characterId }`.

| Behavior | Ignored | Removed |
|---|---|---|
| Visible in the default roster | Yes | No, only under a **Removed** filter |
| In narrator context | No | No |
| In Chronicle catalogs | Yes | No |
| Counts for name uniqueness | Yes | Yes |
| Discovery can attach observations | Yes | Yes, silently and without review items |
| Restorable | Toggle | **Restore** |

- `castListQuerySchema` gains the `removed` filter.
- Exclude removed targets from identity proposals, resolved pending-detail receipts, review counts and review actions. Check the current merge-resolved target again under lock at resolution; a stale request returns `cast_character_removed` (409). Retain existing pending rows as history. On Restore, redisplay those still pending with valid current evidence. A job completed during removal may attach supported observations silently; it must not enqueue actionable items for that person.
- The cast snapshot exposes a removed state to each consumer. Context and Chronicle exclude removed records; discovery keeps them for name uniqueness.
- Removing a seeded character keeps its snapshot, so Restore is complete. First-appearance copy never recreates a character whose record exists, including a removed or merged-away one.
- Main characters cannot be removed.
- Remove asks for confirmation, stating that the character can be restored from the Removed filter.
- Adding a name held by a removed character warns and offers Restore instead.

### Promote to world

**Purpose:** carry a character developed in play back into reusable world canon, on request.

**Entry point:** **Add to world draft** on the sheet for supporting characters.

**API:**

```text
GET  /api/v1/campaigns/:campaignId/cast/:characterId/promotion-preview?worldId=...
Response: { worldId, draftRevision, characterRevision, castRevision, boundary, destinations: [{ path, candidates: [{ sourcePath, value }], tickedByDefault, requiredOnAdd }], matches: [{ characterId, name }] }
POST /api/v1/campaigns/:campaignId/cast/:characterId/promote
Body: { worldId, expectedDraftRevision, expectedCastRevision, expectedBoundary, expectedCharacterRevision, mode: "add" | "replace", targetCharacterId?, selections: [{ destinationPath, sourcePath }], idempotencyKey }
Response: { worldId, draftRevision, characterId }
```

**Flow:**

1. Choose a world. The default is the campaign's source world; any owned non-archived world can be chosen.
2. Show one row per destination field. Add requires a valid selected name. Replace keeps the existing name unless the author explicitly selects a replacement. If multiple source values map to one selected destination, show both and require one choice.
3. When the character originated from that world, or the name matches a roster entry, the preview offers Replace or Add as new.
4. Confirm writes to the draft.
5. The result says the character is saved to the draft and must be published to be used in new campaigns.

**Rules:**

- Writes use the world draft's revision check in one transaction, the same pattern as `authoring-world-apply-adapter.ts`.
- It never creates or edits a published version, and never changes this or any other campaign.
- Map authored fields directly and observed `appearance.description` to `appearance.otherVisualDetails`. When both yield different values, require a single reviewed source for that destination; coalesce identical values. Reject duplicate destinations and incompatible source paths on the server. Exclude `state.*`. Goals start unticked.
- Values are passed through fiction validation. Field limits follow the world schema.
- New entries get `campaignUse: "supporting"`, new opaque IDs and no mechanics.
- `source` records only `{ type: "campaign-promotion" }`, with no campaign or turn identifiers, because worlds can be exported separately.
- Replace keeps the target's ID, mechanics and `campaignUse`, and overwrites only ticked fields.

### Legacy cleanup

After supporting characters use the shared editor:

- Remove the panel's `renderEditor`, Story's use of `character-profile-form.ts`, the `CHARACTER_PROFILE_FIELDS` map and the static character fields in `index.html`.
- Delete `apps/web/src/character-profile-form.ts` once Story stops importing it; Web-Next does not depend on it.

This work belongs to phase 4 (criterion 4.28).
- Run the boundary check and both client builds.

## Confirmed product decisions

The author confirmed both behaviors on November 8, 2026.

| Decision | Confirmed behavior | Acceptance criteria |
|---|---|---|
| A. Native campaign created with presets off | Automatic first-appearance copying stays off for the lifetime of the campaign. Once presets are enabled, players can use Add from world. | 3.24 |
| B. Reapply the same world profile after detaching a mistaken match | Reuse the cast record and start a fresh activation from the pinned world values. Earlier seed-scoped hand edits remain in history and can be re-entered manually. | 4.26, 4.29 |

## Round-2 amendments

Accepted by the author on November 8, 2026 after the second independent review and the review of the built code. These take precedence over earlier text.

### Decisions

| ID | Question | Decision |
|---|---|---|
| D1 | Does the new context ordering apply to existing campaigns? | Only to campaigns using presets, meaning an active seed exists in the cast. Others keep today's order |
| D2 | Which goals reach the narrator during lag or with discovery off? | Latest usable observation, dated and lower authority; authored goals only if none exists |
| D3 | Is a truncated goal override acceptable in context? | Yes, at the 600-character context cap, with the truncation recorded |
| D4 | Does legacy `characterText` reach the narrator on a seeded NPC? | No. Display and Organize only |
| D5 | Is an automatic first-appearance copy pinned when the roster says Always include? | No. The roster value sets the default only for Starting cast and Add from world |
| D6 | Is a seeded NPC's linked entity prose dropped when character context is on? | Yes. Keep only the relationship endpoint |
| D7 | Are campaigns created with presets on before phase 4 eligible? | No. Only phase 4 and later write a true marker |
| D8 | Are rolling deploys supported? | No. The runbook requires replacing all nodes at once |
| D9 | Does Web-Next's world summary list Supporting characters? | No. Selectable only |
| D10 | Does saving the main character require guidance? | No. Use Story's contract-only rule in both clients |
| D11 | Do mention-only passages count as Draft evidence? | No. Stored observations only |
| D12 | Are Suggest and Draft prompts editable at application level? | No. Trusted constants, like cast discovery |
| D13 | Does the enrollment link alone interrupt Create and start? | No. Only skipped characters do |
| D14 | Does a `failed` generation lock character edits? | No. Follow the server rule everywhere |
| D15 | Can the panel unlock context and editing gates on local installs? | Yes, including when they were off at seed |
| D16 | Does a seed carried from a different world count as represented? | No |
| D17 | Does a name omitted during merge review still resolve to the target? | No. It becomes free for a new character |
| D18 | What happens to merge choices when the target's seed is undone? | Not this character is blocked until the merge is undone |
| D19 | Is Undo allowed on a removed target, and can a removed character be promoted? | No to both. Restore first |
| D20 | Are promoted NPCs pre-ticked in Starting cast? | No. `startingCastDefault: false`, as for Convert |

### Corrections

| ID | Requirement |
|---|---|
| A1 | Approving a held match writes a suppressing attachment in the same event as the seed, so Not this character can undo it |
| A2 | A lag-published seed records its earliest evidence turn as `first_observed_turn`. Rewind and branch keep its same-event `create` and `seed_profile` when that turn is within the boundary |
| A3 | Removing a roster character clears matching `linkedCharacterId` values in every writer, including Web-Next |
| A4 | A seed lookup never targets a merged-away or removed record directly |
| A5 | A world entity with no roster entry goes through plain discovery, even with presets on |
| A6 | Authored fields use the canon semantic role, and hand-edited authored fields use `corrected_state` |
| A7 | The preset editor shows `legacyCharacterText` read-only when present, once when it equals the notes |
| A8 | Database world content read for Draft from story is validated, and Draft eligibility and field limits have one shared implementation |
| A9 | A campaign-page lock is checked at open and save and is not live; only Story has a live lock |
| A10 | Restoring a tick above the 30 cap leaves it unticked with a notice. The excluded main character does not count toward the cap |
| A11 | Phase 2's inbox uses the panel editor and existing actions; `allowedActions` and seeded fixtures arrive in phase 3. Criterion 1.9's Reapply is exercised from phase 2 |
| A12 | Presets-off rollback has its own test: seed, turn presets off, confirm edit and context still work and from-world routes return 503 |

The other round-2 review findings are recorded in the [implementation plan's remediation phase](../plans/2026-11-08-unified-character-editor-and-starting-cast.md#phase-7--remediate-review-findings), with their status.

## Follow-up decisions

**Auto-match default.** Outside this spec. A separate decision can use review requests per accepted turn, the share of automatic attachments later detached, tracking lag, and provider calls. A suggested starting bar is at least 500 automatic attachments, under 2% detached, no increase in provider calls, and no false join on adversarial fixtures.

## Documentation and in-app text

| Item | Change | Phase |
|---|---|---|
| `docs/nexus-guide/worlds/characters.md` | Retitle and explain Playable, Supporting and Both | 4 |
| `docs/nexus-guide/campaigns/create.md` | Starting cast and Always include | 4 |
| `docs/player-guide/characters-and-stats.md` | Fixed and updating fields, Observed in story, Reset, Add from world | 4 |
| `docs/runbooks/campaign-cast.md` | Reader/writer deployment order, effective flag cutoff, world/setting/event rollback boundaries, restore and format compatibility | 3 and 6 |
| `docs/architecture` | ADR 0042 and index | 3 |
| Rewind warning (`story.html:252`) | States that later character edits are dropped | 3 |
| Roster, picker and campaign text | Hard-coded strings listed under World roster and dialog | 4 |
| Player and Nexus guides | Suggest cast, Convert, Draft from story | 5 |
| Player guide and runbook | Merge, Remove, Promote | 6 |

## Illustration follow-up

A note from 2026-10-13 asks that this be raised when character tracking is redone. Today only the main character has a visual reference, so NPCs drift between images. The preset snapshot supplies the appearance data that was missing.

This spec does not include that work. It should be reviewed as its own design with these items:

- Feed cast appearance for NPCs named in a segment to the prompt refiner, preferring `campaignProfile` appearance.
- Have the refiner write appearance into the subject and return `characters_present[]`.
- Append the reference block only when the character is present.
- Describe people by appearance, not name.

See the [illustration accuracy review](../../review/2026-10-13-illustration-accuracy-review.md) for the deferred work.

## Delivery phases

Each phase ships independently and keeps tests passing. Cast edits are event-backed. Phase 3 also persists campaign eligibility independently of cast events and widens the settings constraint. Use the next available migrations and versioned archive records for these changes.

### Phase 1: Extract the editor

Add the model and renderer, then switch the World dialog to them with no behavior change.

- **1.1** One descriptor list provides all field labels, sections, limits and input types. `PROFILE_FIELDS` and `SUPPORTING_FIELDS` remain as derived exports, and the Web-Next build passes.
- **1.2** The World dialog is built by the renderer. Generate, Organize, mechanics rows and Delete behave as before, except that aliases are entered one per line.
- **1.3** Campaign-mode editing from Nexus behaves as before.
- **1.4** `check-client-boundaries` passes, with no DOM or platform code in `client-core`.
- **1.5** Existing legacy disclosure, AI and world-resume browser cases pass without weakened assertions.
- **1.6** Generate and Organize use typed `client-web` methods, and Web-Next uses the same generate and progress methods.
- **1.7** The error adapter preserves Nexus messages and reference IDs, including 429 admission messages from Generate and Organize, and legacy-shaped data passes the converted calls.
- **1.8** Draft state and save-payload builders live in `client-core`, and tests cover them without a DOM.
- **1.9** Campaign Organize → apply → Save records `ai_organized` and the reviewed proposal’s protocol version, including after Reapply my changes.

### Phase 2: Story main character and panel fixes

- **2.1** Story's main-character edit uses the shared editor with grouped fields.
- **2.2** A revision conflict offers Reapply my changes and keeps the draft.
- **2.3** Duplicate-name warnings appear in the World editor and the existing panel editor, and do not block saving.
- **2.4** The Nexus sheet hides empty fields, exposes selected state and readable source labels, shows accurate main-character profile-level provenance, and unifies the Needs attention inbox.
- **2.5** At 390px and by keyboard, every editor section and action is reachable.
- **2.6** The [Interaction rules](#interaction-rules) hold in each context shipped by this phase, including focus after Save, conflict and validation errors.
- **2.7** The campaign page opens the shared editor for the main character.
- **2.8** Campaign-scope profile load and save use the typed client.

### Phase 3: Campaign authority

Write ADR 0042 first. Build with no UI that can seed yet.

- **3.1** Commands, projection, resolver and field policy match this document.
- **3.2** A differing observation never changes or removes a non-blank fixed field.
- **3.3** Each phase 3 command follows every applicable path in [Cast lifecycle integration](#cast-lifecycle-integration). Phase 6 verifies the additional lifecycle commands before activating their writers.
- **3.4** Read v1 and v2, write the minimum compatible v2/v3 cast payload, and reject misdeclared or unsupported formats before import writes.
- **3.5** The authored-profile route enforces revisions, idempotency and generation lock.
- **3.6** Authored fields reach context in the defined order and within budget; goals fall back during gaps.
- **3.7** Context can run with discovery off, using a correct notice.
- **3.8** The runbook identifies the first incompatible settings snapshot, world publication and cast event/value, the separate phase 6 writer boundary and recovery options.
- **3.9** Installs with context on and discovery off do not change at upgrade.
- **3.10** Seeded characters corroborate through identity hints and do not fill the review queue, using strict policy fixtures.
- **3.11** Each phase 3 route in the [Route summary](#route-summary) has its admission, limit, mapped error statuses, contract and client method. Phases 4, 5 and 6 meet the same bar for their routes.
- **3.12** One preset save writes authored and updating fields atomically.
- **3.13** PATCH and review confirm on a fixed or discoverable path of a seeded character, blank or not, return `cast_fixed_field_override`.
- **3.14** System Archive round trips keep the new roster fields. Phase 5 extends this to `linkedCharacterId`.
- **3.15** Older archives and in-flight generation fingerprints remain valid.
- **3.16** A seeded character's observed appearance is latest-wins, never blanks, and follows authored appearance in context.
- **3.17** Both new flags appear in the Web-Next Settings panel's Characters section, save, show dependency locks, and are recorded in settings history. Settings stored before the upgrade still load, with both off.
- **3.18** Booting with an older deployment policy and older seed succeeds, a settings patch to an unrelated key keeps both flags on, and a local single-user install can enable them from the panel.
- **3.19** Contract fields and selection and readiness readers for `campaignUse` ship in this phase, with no authoring control yet.
- **3.20** Export v2-compatible cast data as v2. A long goal override alone selects v3. The enclosing campaign record independently preserves eligibility when the cast is empty. Seeded NPCs leave the captured world hint list. `/meta` reports effective capabilities.
- **3.21** Seeded characters appear with authored values in existing cast reads, so Web-Next does not show them as Unknown.
- **3.22** Rewind drops a seed applied to an existing record, a seed does not keep a corrected-away identity alive, and Restore authored goals reaches the narrator.
- **3.23** Identity reservation and field rounds stay within actual token headroom, prioritize recent activity above pins, and explain omissions, including at zero headroom.
- **3.24** (seeding half delivered in phase 4) A native campaign created with presets off keeps `firstAppearanceEligible: false` after presets are enabled. A valid first appearance leaves it unseeded, and explicit Add from world succeeds. Migration, branch, transfer and both archive round trips preserve each campaign’s original eligibility, including when its cast is empty.
- **3.25** Full detail, atomic multi-field writes, replayed typed receipts and archives preserve maximum legal authored values, long goals and distinct legacy text. List summaries, observations and provider snapshots obey their own limits.
- **3.26** New provider payloads use the allowlisted fiction projection. Old admitted jobs retry with the original rendered prompt and fingerprint; new admissions use the versioned pair and bootstrap incompatible chains.
- **3.27** The scoped from-world preview reports all eligible targets and exact identity, override and profile changes. A stale pin, target or preview conflicts without partial writes.
- **3.28** Both clients honor allowed review actions. Illegal fixed-field confirmations remain rejected over HTTP, including after a concurrent change in field authority.
- **3.29** Web-Next accepts a name-only Supporting NPC. For Both regeneration and previously admitted Supporting jobs, its synchronous and durable review/apply paths preserve authored use, defaults, source, ID and hidden mechanics. Legacy story import validates selectable characters at preview and apply.

### Phase 4: Authoring and campaign start

- **4.1** Authors can set Playable, Supporting or Both, plus the two Supporting options.
- **4.2** Existing worlds behave exactly as before.
- **4.3** A Supporting-only roster cannot start a campaign and says why before publish. An incomplete Supporting character never blocks a campaign.
- **4.4** The picker lists only selectable characters; Starting cast lists Supporting and Both, excluding the main character.
- **4.5** Starting cast selections are kept while the dialog is open, including when the main character changes.
- **4.6** Campaign creation and seeding are atomic.
- **4.7** A chosen NPC appears in Story with all authored values and correct badges.
- **4.8** All fields can be edited, and Reset to world value works.
- **4.9** World edits after creation do not change the campaign, and campaign edits do not change the world.
- **4.10** First-appearance copy seeds an unticked character, using the roster name, and detach suppresses it. A campaign created before this feature gets no automatic copy, even after migrating. With presets off, first appearance and approval create plain `discovered` records. World migration leaves existing copies intact.
- **4.11** Supporting characters use the shared editor; found and manual characters show their 11 fields.
- **4.12** Omitting `startingCast` works, so Web-Next and API clients can still create campaigns. Their reads show effective values for seeded characters, and legacy PATCH attempts targeting fixed fields return `cast_fixed_field_override` until Web-Next adopts the editor.
- **4.13** Overlapping flags, enrollment and capability states produce the specified controls, primary context notice and actionable link. Both create buttons enter a non-submittable result state when there is a report or setup link.
- **4.14** Starting cast respects the 30 cap and counter, warns above 5 Always include, and covers the empty and load-failure states.
- **4.15** A name failing the mechanics filter is flagged at authoring, skipped at creation, and reported, and creation succeeds.
- **4.16** Add from world works with discovery off, and Apply world profile seeds an existing same-name character.
- **4.17** Approving a held world match seeds the profile. Not this character suppresses the seed and does not re-copy.
- **4.18** Mechanics survive switching to Supporting and back.
- **4.19** Badges use the exact table text, and Reset, Clear and Restore match the matrix, including restored goals resuming story updates.
- **4.20** The campaign page opens the editor for any campaign character, using the typed cast API and the generation lock.
- **4.21** Duplicate, reorder and completeness behave as specified.
- **4.22** Character list loading and campaign creation use the typed client.
- **4.23** The World dialog saves a Supporting character with only a name, and Generate is hidden for Supporting characters.
- **4.24** The skipped-character report stays visible on both Create and Create and start.
- **4.25** The [Interaction rules](#interaction-rules) hold for preset contexts, including focus after Reset, Clear and Restore.
- **4.26** Add from world after Not this character creates a fresh seed activation on the existing cast record. The server rejects a duplicate active seed.
- **4.27** Open in Story lands on the chosen character.
- **4.28** Duplicated legacy form code is removed once supporting characters use the shared editor, and both clients build. This is delivered with phase 4 rather than waiting for phase 6.
- **4.29** Apply preserves hand values over blank world fields and updating overrides, previews displaced stable values, and Reset uses only the seed’s canonical identity. Reapplying the same roster entry starts its new activation from the pinned world values. Earlier seed-scoped hand edits remain visible in history and do not become effective again.
- **4.30** The renamed protagonist cannot acquire an NPC copy through either discovery policy, held approval, Add or Apply. A queued job rechecks the current pin and effective presets gate before committing.
- **4.31** The public campaign-create response exposes the safe disabled code and the Supporting-only readiness issue through the typed client.

### Phase 5: Bulk and AI

- **5.1** Request 3–8 suggestions and return 0 through the requested count. Bounded provider input and full server-side collision checks apply even when all names collide; the empty result offers an explicit retry.
- **5.2** Each expansion runs and fails independently, and stopping keeps finished results.
- **5.3** Nothing persists before Add selected to draft and Save world.
- **5.4** Supporting generation produces no mechanics.
- **5.5** Convert entities needs no provider, shows unconverted values, and leaves linked entities in place.
- **5.6** After conversion, discovery and Chronicle have one identity for that name, stale links are rejected on save and publish, and relationships still resolve. System Archive round trips keep `linkedCharacterId`.
- **5.7** Draft from story proposes only for fields whose effective value is blank, never for updating fields, and makes no provider call without eligible citations.
- **5.8** Each factual proposal has value-supporting, subject-attributed spans from effective accepted narration. Only labeled creative guidance may omit evidence. Saving an applied factual proposal revalidates its evidence.
- **5.9** Applying a proposal only fills the draft and creates no observation.
- **5.10** Without a provider, each feature shows guidance and manual paths remain.
- **5.11** Prompt injection fixtures in narration do not change output handling.
- **5.12** Logs contain no prompts, narration or raw provider errors.
- **5.13** Suggest cast warns before closing with unadded results.
- **5.14** Convert blocks name collisions, and a converted description-only NPC leaves the world campaign-ready.
- **5.15** Expansion keeps the reviewed seed name, older prompt snapshots still load, and the character-authoring protocol version is unchanged. From this phase both clients preserve hidden mechanics through new Supporting generation as well.
- **5.16** Discovery and Chronicle resolve linked identities and retained or retired names consistently across conversion, renaming and a campaign copy. Scoped entity references and typed conversion provenance survive System Archive import.

### Phase 6: Lifecycle

- **6.1** Merge preview shows every field outcome, and stable conflicts must be resolved.
- **6.2** After merge, one character appears with combined evidence and aliases. Discovery and pending candidates resolve to the target, and discovery does not recreate the merged-away person.
- **6.3** Undo merge restores both records. Automatic matches from a merged character can still be detached.
- **6.4** Merge and remove are undone by rewind, and survive branch, transfer and both archive types.
- **6.5** Removed characters leave the default roster and context, keep name uniqueness, and restore completely.
- **6.6** Main characters cannot be merged, removed or promoted, on client or server.
- **6.7** Promote respects draft revision, field selection and replace rules.
- **6.8** Promote never changes a published version or campaign.
- **6.9** Removed and merged-away characters leave Chronicle catalogs and are refreshed on each lifecycle command.
- **6.10** Remove asks for confirmation, and re-adding a removed name offers Restore.
- **6.11** Merge persists the reviewed alias subset and field choices, including explicit empty overrides. Undo preserves later target edits and restores source authority.
- **6.12** Removed characters have no actionable pending items or resolution writes. Restore shows only pending items with valid current evidence.
- **6.13** Promotion accepts one value per destination and requires a valid name on Add. Replace updates only approved destinations. The world provenance round-trips without campaign identifiers.
- **6.14** An ordinary campaign with presets off can produce a lifecycle-only v4 archive after the reader rollout. Incompatible imports fail before mutation; the runbook names the first v4 live write as a rollback boundary.

## Tests

Use unit and contract suites in `tests/unit`, real PostgreSQL suites in `tests/integration`, and the appropriate Nexus and Web-Next browser suites. Associate every numbered criterion with a test. Capture screenshots of changed visible interactions at desktop and 390px, including focused controls, validation, conflict recovery and the successful create result.

Domain and contracts:

- A differing discovery observation never changes or deletes a non-blank fixed field.
- Blank stable fields fill from discovery; hand-clearing returns them to discoverable.
- Goals: authored start, later observation wins, a gap sends the latest observation dated and lower authority, authored only with no usable observation, override wins until cleared.
- Effective-value order for every field class.
- Selection and readiness with Playable, Supporting and Both, including a Supporting-only roster.
- Client and domain policy tables match.
- `cast_fixed_field_override` on blank and non-blank fixed paths, and empty override handling.
- Goal overrides above 2,000 characters.
- Settings patch keeps flags on, and old policy and seed boot.
- Flag-state table, including the settings migration and panel.
- Typed-client calls with legacy-shaped data.

Persistence (PostgreSQL integration):

- Campaign creation is atomic with seeding, including flags off.
- Isolation: world edits do not change copies; campaign edits do not change worlds or other campaigns.
- Rewind before an edit, branch, Campaign Archive and System Archive round trips, cross-world transfer, v1 and v2 reads.
- Seed with mechanics-like text does not fail creation.
- First appearance, scoped detach and explicit reapplication; frozen admission permission plus live publication veto.
- Campaign world migration leaves copies intact.
- Save with revision conflict.

Context:

- Budget and order with many long authored fields.
- `alwaysInContext`, named reference and not-relevant selection for turn-0 characters.
- Context when discovery is off.

Browser (Nexus, 1440px and 390px, keyboard):

- World dialog parity after extraction.
- Roster use setting, Starting cast, selections retained while the dialog is open.
- Edit preset NPC in Story, reset to world value, conflict and reapply, generation lock, partial-save failure.

Phases 5 and 6:

- Suggest cast: duplicate seed filtering, partial failure, stop, roster limit, supporting mode with no mechanics.
- Entity conversion: field mapping, map-shaped legacy input in the pure mapper, stale links, rename collisions, canonical alias ownership in both catalogs, and relationship resolution.
- Draft from story: excluded fixed fields, unknown evidence IDs, invalidated turns, citation and character limits, adversarial narration.
- Merge: all field-resolution cases, alias limit, chains, stored discovery jobs, retargeted candidates, detach after merge, undo.
- Merge and remove through rewind, branch, transfer, Campaign Archive and System Archive.
- Remove: name uniqueness, silent discovery, restore of a seeded character.
- Promote: revision conflict, add and replace, field mapping, archived world rejection, no published-version change.

### Review regression cases

Each row names the criterion, test boundary and observable outcome. Archive cases exercise actual export and import into a different installation or campaign scope; replay cases begin with the stored historical representation.

| Criteria | Boundary and fixture | Required assertion |
|---|---|---|
| 1.9 | Nexus Organize on a campaign with a recorded proposal version, force a revision conflict, reapply, then save through the API into PostgreSQL | Audit and reload retain the accepted version and source. Discard and manual-only save carries no AI provenance. |
| 2.4, 3.28 | Browser and HTTP: new world-seeded protagonist, one manual edit, legacy import, and a pending claim on a blank seeded NPC field | Main-character label describes the profile source. Both clients show only allowed actions. Direct forbidden confirm returns 422. Dismissal or an explicit authored edit follows its own path. |
| 3.24 | PostgreSQL: create native campaigns with empty casts, one with presets on and one with presets off. Enable presets, then exercise branch, migration, transfer and each archive round trip. Include a pre-feature row and an older archive with no eligibility marker. Publish the same valid first appearance to each resulting campaign. | Only the eligible campaign and its copies seed automatically. The flag-off campaign, pre-feature row and older import keep a false marker. Explicit Add from world then succeeds for each ineligible campaign. |
| 3.25, 3.20 | Typed detail/save/receipt replay and both archives: 3,000-character background, 20,000-character goal, maximum legal simultaneous fields with escaped and multibyte text, distinct legacy and structured guidance | Exact full values and receipt round-trip. List output is bounded. An over-limit observation fails. An unseeded long goal selects v3. A v2 fixture stays v2-compatible. |
| 3.26 | Provider request capture: synthetic credential, mechanics, reasoning block with inner text, unrecognized extension, and ordinary fiction in authored fields and citations | Inspect serialized narrator, discovery, Suggest/expansion and Draft inputs for allowed fiction and absence of all sensitive fixture values. Reload the original authored sheet unchanged. |
| 3.26 | Historical job replay after upgrade/restart alongside a newly admitted job on the same campaign | Old job reproduces the recorded rendered prompt, source IDs and fingerprint. New job uses the new prompt/context pair and cannot reuse the old continuation chain. |
| 3.23 | Pure selector and final request planner: zero headroom, headroom for one identity, and 30 long pinned profiles plus recent activity | Actual envelope fits. Field rounds are deterministic, recent activity outranks pins, missing fields/characters appear in the explanation, zero sends no block. |
| 3.27, 4.29 | PostgreSQL and browser: two same-name targets, manual role over a blank vs populated world role, goal override, intentionally empty observed appearance, different campaign and roster aliases | Preview lists the exact target and field consequences. Apply writes them atomically. Editing a target, changing the pin or replaying a stale preview cannot overwrite concurrent work. Identical retry returns its original receipt. |
| 3.22, 4.17, 4.26, 4.29 | Seed a character whose pinned roster role is Ferryman, hand-edit the role to Guide, and detach the mistaken match. Reapply the same roster entry. Repeat with a different eligible entry. Also exercise a narrated alias, manual Apply, Reset after migration/import and rewind. | Reapplying the same entry keeps the cast ID, creates a new seed activation and shows Ferryman. Guide remains visible in the old activation’s history. The different entry starts with its own role. Reset restores only the roster identity, and rewind to before detach restores the earlier effective edit. |
| 4.30 | Rename a Both protagonist, mention the original name under strict and unique matching, approve a held match, then submit direct Add and Apply requests | The one protagonist remains authoritative and no NPC row or seed can represent its reserved roster identity. |
| 4.30 | Pause discovery after capture, migrate to a pin with the same identity and revised profile, repeat with renamed/removed/ambiguous identity, or activate presets-off before commit. Retry after restart | Valid identity uses the new profile. Changed identity goes to review. Disabling presets or missing captured permission prevents a seed. No stale-origin write. |
| 3.29 | Web-Next natural entry points: edit a Nexus-authored name-only Supporting NPC, regenerate a Both NPC synchronously and via durable review/resume, then run Supporting generation when phase 5 enables it | Use, ID, provenance, cast defaults and hidden mechanics survive all applicable writes. |
| 3.29, 4.31 | Infinite Worlds preview/apply with one Playable and several Supporting entries. Inject a Supporting ID. Fastify and typed client: disabled presets request and Supporting-only roster | Single selectable entry auto-selects. A forged ID fails at apply. Check public 503 code/reference, readiness issue code and generic 5xx redaction. |
| 4.13, 4.24 | Browser matrix: both create buttons, skipped name/alias, unenrolled campaign, insufficient installed capability, and discovery off with effective context | Show the highest-precedence applicable notice and correct link. Preserve the skipped list and returned campaign ID. No second POST from the result page. |
| 5.1 | Provider stub with 20,000 entities, collision with an omitted prompt name, all duplicates, then explicit retry | Input respects name/count/character budgets. The server checks the full set, returns an empty list when appropriate and makes no automatic refill call. |
| 5.8, 5.9 | Provider stub and PostgreSQL: wrong subject, mention-only, allegation in dialogue, negation, valid attributed span and creative guidance. Correct the accepted narration between preview and Save | Reject unsupported factual proposals. Show exact quotes for valid facts. Both save paths reject stale evidence without creating observations or partial edits. |
| 5.6, 5.16 | Convert and rename on a collision, once retaining the original name as an alias and once retiring it. Exercise both catalogs before and after campaign copy and System Archive round trip | Both consumers return the same unique or ambiguous result at each pin. Entity relationships resolve. Only typed provenance and link fields round-trip. |
| 6.1–6.4, 6.11 | Merge over 20 candidate aliases with conflicting manual goals, an observation against a manual goal and an intentionally empty observed-appearance override. Edit the target, then undo/replay | Reject invalid alias/choice submissions. Persist exactly the reviewed subset and manual winners. Restore source and preserve subsequent target edits. |
| 6.5, 6.12 | Remove with pending identity and resolved-detail items, attempt resolution from a stale tab, finish a discovery job while removed, invalidate one old citation, then restore | Counts and inbox agree, stale resolution returns 409, discovery stays silent, and only still-valid old pending items return. |
| 6.7, 6.13 | Promote both authored and observed appearance to the same destination, omit the Add name, and Replace with only a subset selected | Add without a valid name or a duplicate/unresolved destination fails atomically. Replace writes exactly one approved appearance value and preserves unticked fields. Typed provenance survives export/import. |
| 3.8, 6.14 | Staged readers/writers and archive fixtures v1–v4, including a no-presets campaign whose first new event is Remove | Old jobs and old archives remain readable on capable binaries. Lifecycle writes wait for reader deployment. The v3-only importer rejects v4 before any write. Rehearse and document rollback before and after each incompatible write. |

Live provider quality for phase 5 remains a separate operator validation.

## Web-Next follow-up

The data-preservation guards, shared review action checks, settings and typed-client changes specified above ship with their corresponding phases. The remaining Web-Next interface work is deferred:

- Adopt the `client-core` model in the Character Workspace and `characters-workspace.ts`. Reuse the Nexus renderer, following the `cast-review-queue` import precedent, or write a thin renderer.
- Add the Starting cast step. A campaign character picker was not found in `apps/web-next/src`.
- Replace the 6-stage trip with an inline, name-first editor.
- Replace the flat main-character form.
- Align roster text that says characters are optional with the campaign requirement.
- Fix the unhandled failure opening Add character (`characters-workspace.ts:105`).
- Fix the remaining sheet and source items listed under Story cast panel.
- Show authored field badges and the fixed-field rules. Until then, seeded characters read correctly through effective values, and saving a fixed field shows `cast_fixed_field_override`.

## Left to the builder

- Exact names, file splits and renderer structure.
- Layout of roster rows and the Starting cast checklist, following Nexus patterns.
- Numeric limits, if tests show better values.
- Final prompt wording for phase 5, within the validation rules above.

## Open checks

Verify the following implementation details against the specified behavior and acceptance fixtures.

- Verify old/new prompt protocol dispatch and chain compatibility against the frozen-job fixtures before enabling the new writer.
- Which Story panel issues found in Web-Next also exist in Nexus.
- Whether world relationships depend on linked entities in any way that conversion changes.
- Whether any readers of `playableCharacters` beyond those named under [World roster](#world-roster) assume every entry is selectable.
