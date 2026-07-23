# Enhancement proposal: Context-aware image library and illustration source policies

**Status:** Deferred proposal. Review again before implementation because the asset, identity, and illustration schemas may change.

## Summary

Infinite Quest Nexus should retain every successfully generated image as an owner-scoped library asset with durable generation provenance and searchable fictional context. Campaigns should be able to reuse those assets automatically before spending time or provider credits on a new image.

The Campaign editor should expose one illustration source policy:

1. **No automatic illustrations**
2. **Library only**
3. **Library, then generate**
4. **Generate only**

Library matching begins only after the Story Engine has accepted a turn and validated its fiction-only `imagePrompt`. It occurs before any image provider request. A missing image, weak library match, matcher failure, unavailable image provider, or failed provider job must never change whether the story turn is accepted.

This proposal extends, but does not replace, [ADR 0008](./0008-independent-illustration-pipeline.md). Text and image providers remain independent, and library-only operation must not require an image provider or embedding provider.

## Goals

- Retain generated images for later use across supported add and edit views.
- Store enough sanitized context to find and understand an image later.
- Support automatic, best-effort matching without requiring an external provider.
- Avoid new generation when an existing image is an appropriate match.
- Permit a campaign to use library images when no image provider is configured.
- Preserve user ownership, creator provenance, future sharing boundaries, and cross-user isolation.
- Make every automatic match explainable and auditable.
- Keep provider content filtering correctly scoped to generation while adding library-specific reuse controls.
- Preserve content-addressed storage and attach existing assets without copying their bytes.

## Non-goals

- Do not match an image before story-text generation. The accepted turn supplies the validated scene context needed for a reliable match.
- Do not make illustrations part of the authoritative story-acceptance transaction.
- Do not use free-form tags as authorization controls.
- Do not expose credentials, private reasoning, mechanics, scratchpads, rejected output, or raw provider responses as image metadata.
- Do not require semantic embeddings for baseline matching.
- Do not silently publish an owner's private images to other users.
- Do not guarantee that every turn receives an image. A poor match is worse than no image.

## Current implementation boundary

The current implementation already provides useful foundations:

- `assets` stores owner-scoped, content-addressed files and deduplicates identical bytes per owner.
- `asset_references` attaches a retained asset to a campaign and turn without copying the file.
- `image_jobs` retains the validated fiction-only prompt and provider generation settings for a primary generated asset.
- Accepted turns enqueue optional image work after story and Chronicle validation.
- The library can attach a retained asset manually to supported world-cover and turn-illustration views.

The missing capabilities are first-class per-image context, creator and visibility metadata, searchable library indexes, durable match decisions, provider-independent illustration policies, and automatic match orchestration. Generation context is currently split across the asset, image job, turn, and provider-result metadata. Additional artifacts may be less directly related to their generation job than the primary asset.

The current campaign illustration constraint also assumes that enabling illustrations requires a provider and model. That constraint must evolve because **Library only** is valid without either.

## Illustration source policy

Use a single policy field instead of combining an enable checkbox with a separate strategy dropdown. This prevents contradictory states such as “enabled” with no usable source.

| Policy | Library search | Provider fallback | Provider required | No acceptable match |
| --- | --- | --- | --- | --- |
| `off` | No | No | No | No illustration work |
| `library_only` | Yes | No | No | Complete with no image |
| `library_then_generate` | Yes | Yes | Yes | Queue provider generation |
| `generate_only` | No | Yes | Yes | Queue provider generation |

When the configured provider becomes unavailable, Nexus should preserve the saved policy rather than silently rewriting user intent. Automatic execution for `library_then_generate` may still attempt the library, but it must record that provider fallback was unavailable if no match is found. The editor should offer an explicit switch to `library_only`.

The server must reject a newly saved provider-dependent policy when no enabled, compatible provider and model can be resolved. Browser disabling is a convenience, not the validation boundary.

## Processing model

```mermaid
flowchart TD
  Accepted["Accepted turn with validated fiction-only image context"] --> Resolve["Durable illustration resolution"]
  Resolve --> Policy{"Illustration source policy"}
  Policy -->|Off| Done["No illustration work"]
  Policy -->|Library only| Match["Search eligible library assets"]
  Policy -->|Library then generate| Match
  Policy -->|Generate only| Generate["Queue provider image job"]
  Match --> Score{"Candidate meets threshold"}
  Score -->|Yes| Attach["Attach existing asset reference"]
  Score -->|No and library only| NoMatch["Record no match; leave turn unillustrated"]
  Score -->|No and fallback enabled| Generate
  Generate --> ProviderResult{"Provider result"}
  ProviderResult -->|Success| Persist["Persist asset, provenance, and reference"]
  ProviderResult -->|Failure| ImageFailure["Record independent image failure"]
```

The resolution operation should be a durable child workflow created during or immediately after turn commitment. Matching and provider generation must run outside the authoritative story mutation path. Retrying or replacing an illustration must never rerun the story turn.

## Asset ownership, creator provenance, and reuse scope

Ownership, provenance, and reuse scope are distinct concepts:

- `owner_user_id` is the current authorization boundary and already exists on `assets`.
- `created_by_user_id` records the internal user who originally generated or imported the asset.
- Generation-context records also retain their creating user because one deduplicated asset can have more than one provenance event.
- Changing ownership must not rewrite creator provenance.

During the pre-authentication phase, the server resolves both owner and creator to the database-backed `initial-owner`. The browser must not supply either value as proof of identity. Future OpenID Connect linking should continue using the same internal UUID.

Use a constrained scope field rather than a free-form `global` tag:

| Scope | Meaning |
| --- | --- |
| `private` | Visible only to the owner and excluded from automatic reuse unless explicitly selected. |
| `campaign` | Eligible for automatic reuse in its originating campaign. |
| `world` | Eligible across campaigns using the associated world, subject to version-aware matching. |
| `owner_library` | Eligible throughout the owner's personal library. |
| `shared` | Explicitly published to an authorized shared library. |

Do not call the final scope `global` unless every user is genuinely authorized to view and reuse the asset. A future sharing system should add grants, collaborators, or publication records; it must not interpret `shared` alone as sufficient authorization.

Free-form tags remain appropriate for descriptive categories such as `portrait`, `location`, `cover`, or `night`, but tags never grant access.

## Data model proposal

Exact names should be reviewed against the schema at implementation time. The intended relationships are more important than these provisional identifiers.

### Asset library fields

Extend the asset library with user-managed and policy fields, either directly on `assets` or through a one-to-one library record:

```text
asset_library_entries
  asset_id                    primary/foreign key -> assets
  owner_user_id               required ownership scope
  created_by_user_id          required internal user provenance
  title
  caption
  notes
  tags                        normalized/searchable representation
  reuse_scope                 private|campaign|world|owner_library|shared
  automatic_reuse_enabled     boolean
  review_status               unreviewed|eligible|restricted|blocked
  content_rating/categories   nullable structured classification
  favorite
  archived_at
  created_at / updated_at
```

Keep mutable curation fields separate from immutable generation provenance.

### Generation contexts

Use a many-to-one relationship because content-addressed deduplication can map several generation events to identical image bytes:

```text
asset_generation_contexts
  id
  owner_user_id
  asset_id
  created_by_user_id
  image_job_id                nullable for imports or migrated content
  world_id                    nullable
  world_version_id            nullable
  campaign_id                 nullable
  turn_id                     nullable
  target_type                 world_cover|turn_illustration|other
  variant_index
  fiction_prompt
  negative_prompt             nullable
  entities                    normalized identifiers and safe display names
  characters
  locations
  factions
  scene_attributes            environment, time, weather, mood, style, objects, actions
  provider_profile_id         nullable; never contains credentials
  provider_type
  model
  generation_parameters       bounded allowlisted JSON
  parent_asset_ids            for future edit/image-to-image lineage
  metadata_schema_version
  created_at
```

Store only validated, fiction-only contextual data. Allowlist provider parameters such as width, height, aspect ratio, quality, format, seed, steps, guidance, and scheduler. Do not copy arbitrary provider request or result objects into searchable context.

### Asset usage references

Continue treating attachment as a separate relationship. An asset can be used by several worlds, campaigns, or turns without altering its provenance. Future references may need world and world-version targets in addition to the existing campaign/turn roles.

### Illustration resolution jobs

Do not overload provider-bound `image_jobs` with library matching. Introduce a durable parent operation:

```text
illustration_resolution_jobs
  id
  owner_user_id
  campaign_id
  turn_id
  source_policy
  matching_scope
  confidence_profile
  query_context_snapshot
  status                      queued|matching|matched|no_match|generation_queued|completed|recoverable|failed
  selected_asset_id           nullable
  selected_score              nullable
  matching_algorithm_version
  image_job_id                nullable child provider job
  reason_code
  created_at / updated_at / completed_at

illustration_match_candidates
  resolution_job_id
  asset_id
  rank
  score
  score_components
  rejection_reasons
```

Candidate retention may be limited to the top bounded set to control storage. Persist enough evidence to explain the decision without retaining private story-engine context.

## Context extraction

The match query should be constructed from the accepted, sanitized turn:

- The validated `imagePrompt`
- Present canonical character/entity identifiers
- Current location and world-version identifiers
- Safe scene attributes derived from accepted fiction
- Optional visible action, environment, time, weather, mood, style, and objects

Prefer canonical identifiers over names when available. Names remain useful for imported or older assets but can collide across worlds.

Do not include player mechanics, roll results as mechanics, stats, targets, hidden trackers, scratchpads, trigger diagnostics, model reasoning, rejected narration, or raw provider responses. A sanitized diegetic consequence may be included only when it is already part of accepted fiction.

## Matching strategy

The baseline matcher must work locally without image or embedding providers. It should combine structured filtering, full-text ranking, and deterministic scoring. Semantic similarity may enhance the score when compatible embeddings already exist, but the same policy must still function when embeddings are disabled or unhealthy.

### Candidate eligibility

Before scoring, require all of the following:

- The asset is authorized for the server-resolved user.
- The asset is within the configured matching scope.
- Automatic reuse is enabled.
- The asset is not archived or blocked.
- Its content review status satisfies the campaign policy.
- Its file is present and is a supported raster type.
- World, campaign, and version restrictions do not conflict.

Imported or user-uploaded assets should default to `unreviewed`. They may be selected manually, but should not enter automatic matching until explicitly approved or allowed by policy.

### Score components

The first implementation should favor precision over recall:

| Signal | Influence |
| --- | --- |
| Canonical character/entity agreement | Very high |
| Canonical location agreement | Very high |
| Conflicting character, location, time, or scene type | Hard rejection or large penalty |
| World and world-version relationship | High |
| Fiction-prompt text similarity | High |
| Structured action/object overlap | Medium to high |
| Style, environment, weather, time, and mood | Medium |
| Semantic similarity when available | High but bounded |
| Aspect-ratio compatibility | Low to medium |
| Reuse in nearby turns | Negative |

“Best available” must never mean “always attach something.” Apply an absolute confidence threshold and contradiction rules after ranking. If no candidate passes, return `no_match`.

### Confidence profiles

Expose understandable profiles rather than a raw score in the initial UI:

- **Strict:** highest precision; recommended for cross-campaign or owner-library matching.
- **Balanced:** default within the current world.
- **Broad:** accepts looser contextual similarity but still honors hard contradictions.

The server maps each profile to versioned scoring weights and thresholds. Persist the resolved threshold and algorithm version on the resolution job so later algorithm changes do not obscure earlier decisions.

### Matching scope

Offer these scopes independently of asset visibility:

- Current campaign
- Current world — recommended default
- Entire authorized personal library
- Authorized shared library, when sharing exists

Automatic matching should be more conservative than manual browsing. Entire-library and shared-library searches should use stricter thresholds and stronger canonical-entity requirements.

### Repetition control

Penalize assets used within a configurable recent-turn window. A reasonable initial default is to avoid automatically repeating the same image within the previous five illustrated turns unless it is the only candidate above a deliberately higher repeat threshold.

## Content filtering and safety

Provider content filtering and library eligibility are separate controls:

- Provider filtering applies only when Nexus requests a new image.
- Reattaching a retained image makes no provider call, so the provider filter cannot evaluate it.
- Generated asset provenance should record the requested provider filtering mode and any allowlisted classification result the provider actually returns.
- Library assets require an independent review status and automatic-reuse eligibility.
- Provider filtering metadata is evidence, not an authorization mechanism.

Automatic matching should default to eligible generated assets and explicitly approved imports. Unknown or unreviewed content should remain manually selectable only, unless an administrator deliberately changes the policy.

Never store credentials, signed temporary URLs, raw provider payloads, private reasoning, mechanics, scratchpads, rejected output, or hidden story state in library metadata. Continue rejecting unsafe remote-only artifacts according to the independent illustration pipeline.

## Campaign editor experience

Replace **Generate an optional illustration after each accepted turn** with **Automatic illustration source** and the four policies described above.

Show controls progressively:

- `off`: hide matching and provider settings.
- `library_only`: show matching scope, confidence, repetition, and eligibility settings; hide provider settings.
- `library_then_generate`: show both matching and provider-generation settings.
- `generate_only`: show provider-generation settings; hide automatic matching settings.

Provider-dependent options are disabled when no enabled compatible provider exists. **Library only** remains selectable regardless of provider availability and remains valid even when the owner's library is empty; turns then complete without an image until a match becomes possible.

Display a concise status summary such as:

- “Library only; current world; Balanced matching.”
- “Try the library first, then generate with Sogni profile X and model Y.”
- “Fallback generation is unavailable because the selected provider is disabled.”

Do not silently downgrade or rewrite the stored policy when a provider is temporarily unavailable.

## Image library experience

The shared library should support filtering by:

- Created by me
- Owned by me
- Current campaign
- Current world or world version
- Entire personal library
- Shared with me or explicitly published, when sharing exists
- Generated, imported, or user-uploaded origin
- Character, entity, location, tag, model, provider, date, and content status
- Eligible or excluded from automatic reuse

Each item should show its title, origin, creation date, creator when authorized, usage count, primary context, reuse scope, and content/review state. Detailed provenance can show prompt and generation settings without exposing secrets or private orchestration.

Supported add and edit views should select an asset by reference. They must not duplicate stored bytes. The initial reuse targets are world covers and turn illustrations; later targets can adopt the same picker contract.

## Turn-level controls

The campaign policy controls automatic behavior, but a completed turn should still offer explicit actions:

- Choose from library
- Find another library match
- Generate a new image, when a provider is available
- Remove the current illustration
- Exclude this image from future automatic matches
- Inspect **Why this image?** with bounded match evidence

Avoid an ambiguous **Regenerate** label. Finding another retained match and spending provider resources to generate a new image are different operations.

Manual replacement should attach the newly chosen asset first and then update the active reference transactionally. It must not delete the previously retained asset. Manual selection can include authorized assets that automatic matching excludes, with appropriate content warnings.

## API and contract outline

Shared contracts should define constrained enums and responses rather than accepting arbitrary metadata. Likely endpoints include:

```text
GET/PUT  /api/v1/campaigns/:campaignId/illustration-config
GET      /api/v1/assets?scope=&creator=&worldId=&campaignId=&tags=&eligible=
GET/PATCH /api/v1/assets/:assetId/library-metadata
GET      /api/v1/turns/:turnId/illustration-resolution
POST     /api/v1/turns/:turnId/illustration-match
PUT      /api/v1/turns/:turnId/illustration-asset
POST     /api/v1/turns/:turnId/illustrations
```

The exact route split should be reviewed to avoid duplicating existing library and illustration endpoints. Every query and mutation must derive the user from server identity, enforce ownership or sharing grants, and validate world/campaign relationships.

Match APIs should return bounded explanations, not private ranking internals or unrestricted context snapshots. Manual match requests must be idempotent or use an explicit replacement revision.

## Indexing and performance

- Add owner-first indexes for library scope, reuse eligibility, review status, world, campaign, creator, and creation date.
- Normalize canonical entity/location relationships into indexed rows when practical rather than relying exclusively on JSON containment.
- Use PostgreSQL full-text search for the provider-independent baseline.
- Reuse compatible stored embeddings only as a derived index. Embeddings may be rebuilt and must never become required provenance.
- Bound candidate pools before detailed scoring.
- Avoid holding the story-commit transaction open while matching.
- Record matching latency and candidate counts without logging private story content.

## Deduplication and provenance

The existing uniqueness of `(owner_user_id, content_hash)` means identical bytes resolve to one asset. Do not weaken that storage guarantee merely to retain multiple contexts.

Instead:

- Create one generation-context row per successfully persisted artifact and generation occurrence.
- Preserve every job/variant relationship, including non-primary variants.
- Attach one asset to many usage references.
- Choose a primary display context without deleting other provenance.
- Treat transfer of ownership as a separate audited operation that does not rewrite creator fields.

## Backfill and migration

Implement forward capture first so every newly generated artifact receives complete metadata. Then perform an optional bounded backfill:

1. Create library entries for existing assets with `owner_user_id` as both owner and provisional creator.
2. Recover primary generation provenance from `image_jobs.asset_id`, prompts, provider profiles, and generation settings.
3. Recover additional artifact relationships only from validated, known metadata shapes.
4. Derive usage scope from existing world, campaign, turn, and asset-reference relationships.
5. Mark uncertain origin or content classification as `unreviewed`; do not invent metadata.
6. Make the backfill idempotent and resumable.

Do not parse arbitrary historical provider payloads into public metadata. Unknown fields remain private operational history or are ignored.

## Failure and recovery semantics

- A matcher error becomes an independent recoverable resolution failure and cannot affect the accepted turn.
- `library_only` never calls an image provider, including during retry.
- `library_then_generate` calls the provider only after a completed no-match decision.
- An unavailable fallback provider records a specific outcome rather than converting the policy silently.
- Provider retries remain governed by the existing independent image-job policy.
- Re-running resolution must be idempotent and must not create duplicate active references or duplicate provider jobs.
- Rewind, branch, import replacement, transfer, and deletion workflows must account for active resolution jobs as well as active image jobs.
- Removing a reference does not delete the retained asset unless a separate, reviewed asset-deletion operation proves it has no protected uses.

## Observability and cost attribution

Structured logs and activity events should include correlation IDs plus:

- Resolution job, campaign, turn, and selected asset identifiers
- Policy, matching scope, confidence profile, and algorithm version
- Candidate count, selected score, decision reason, and duration
- Whether provider generation was avoided, queued, unavailable, or failed
- Child image-job identifier when present

Do not log prompts, private context snapshots, credentials, or unnecessary story text.

Library reuse incurs no image-provider charge. Cost attribution remains attached only to actual provider operations. Product metrics may separately count avoided generations, but should label them as estimates rather than realized savings unless a reliable provider cost basis exists.

## Security and privacy review

- All asset, context, candidate, reference, and resolution records remain owner-scoped or explicitly grant-scoped.
- `created_by_user_id` is internal provenance and should not be exposed in portable exports or public views by default.
- Shared publication requires an explicit auditable action and future authorization design.
- Search results must not reveal that an unauthorized asset exists.
- Imported metadata and tags are untrusted and require schema validation and safe rendering.
- Deleting or anonymizing a user may require a defined provenance-retention policy before multi-user authentication ships.
- Image files should not be mutated merely to embed internal user UUIDs. Database metadata is the authoritative ownership and provenance record.

## Suggested implementation phases

### Phase 1: Durable metadata

- Add library curation, creator, reuse scope, and generation-context records.
- Capture complete provenance for every generated variant.
- Add server-scoped library filters and metadata editing.
- Backfill reliable existing provenance.

### Phase 2: Manual shared library

- Complete reusable selection across supported add and edit views.
- Add filters, reuse eligibility, review status, and provenance details.
- Preserve reference-based attachment and deduplicated storage.

### Phase 3: Provider-independent matching

- Add resolution jobs, current-campaign/current-world scopes, structured filtering, full-text scoring, thresholds, contradiction rules, and explanations.
- Ship `off` and `library_only` policies first.
- Measure false-match behavior before enabling fallback automation.

### Phase 4: Fallback generation

- Add `library_then_generate` and `generate_only` policies.
- Connect no-match decisions to existing provider image jobs.
- Add repetition control, manual rematch, and explicit new-generation actions.

### Phase 5: Semantic and shared enhancements

- Add optional semantic scoring using compatible derived embeddings.
- Add authorized shared-library publication and grants only after authentication and collaboration rules exist.
- Tune scoring from sanitized evaluation fixtures and observed opt-out/rematch behavior.

## Required tests

### Contracts and persistence

- Every generated artifact, including secondary variants, retains immutable generation context.
- Identical bytes deduplicate while preserving multiple provenance events.
- Ownership transfer preserves creator provenance.
- Caller-supplied owner or creator identifiers cannot spoof identity.
- Cross-user asset discovery, matching, and attachment are rejected without an explicit grant.
- Pre-authentication creation resolves owner and creator to `initial-owner` idempotently.
- Backfill is idempotent and does not invent unavailable metadata.

### Policy behavior

- `off` creates no resolution or provider work.
- `library_only` works without image or embedding providers.
- `library_only` attaches an above-threshold match and leaves no image below threshold.
- `library_then_generate` queues exactly one provider job after a durable no-match result.
- `library_then_generate` never generates when an acceptable match exists.
- `generate_only` skips library matching.
- Provider-dependent policies are rejected when newly saved without a valid provider/model.
- Temporary provider loss does not rewrite the saved campaign policy.

### Matching

- Owner, scope, review, archive, and automatic-reuse filters run before scoring.
- Exact canonical entity/location matches rank above loose text similarity.
- Contradictory characters or locations reject otherwise similar images.
- Current-world defaults do not leak candidates from unrelated worlds.
- Low-confidence searches return no match.
- Repetition penalties prevent nearby duplicate use according to policy.
- The baseline matcher behaves deterministically without embeddings.
- Semantic enhancement cannot bypass authorization or hard contradictions.
- Persisted explanations identify the versioned decision without exposing private context.

### Safety and integrity

- Mechanics, rolls, hidden trackers, scratchpads, rejected output, and reasoning never enter image context or search text.
- Provider content-filter settings apply only to new generation.
- Blocked and unreviewed assets are excluded from automatic reuse according to policy.
- Illustration matching and generation failures do not mutate or reject accepted turns.
- Manual replacement retains the previous asset and updates references atomically.
- Rewind, branching, transfer, import replacement, and deletion handle active resolution jobs safely.

### UI and end to end

- **Library only** remains enabled with no image provider.
- Provider-dependent choices accurately reflect provider availability.
- Progressive settings visibility matches the selected policy.
- Library filters distinguish owner, creator, campaign, world, and shared scopes.
- A turn explains whether its image was reused or newly generated.
- Manual **Find another library match** and **Generate a new image** remain distinct.
- Accessible status text communicates no-match and unavailable-fallback outcomes without relying on color.

## Acceptance criteria

This enhancement is complete when:

- Newly generated images are durably retained with safe, searchable, versioned provenance.
- Ownership, creator provenance, reuse scope, and descriptive tags are modeled independently.
- Campaigns can run in library-only mode with no image or embedding provider.
- Library matching happens after accepted fiction exists and before provider generation.
- No image is attached below the configured confidence threshold.
- Library-first mode falls back exactly once when appropriate and never blocks story completion.
- Every reuse decision is owner-scoped, explainable, recoverable, and idempotent.
- Manual library reuse works across the intended add and edit views without duplicating asset bytes.
- Provider and library safety policies are both enforced at their correct boundaries.
- Tests cover identity isolation, deduplication, matching quality, workflow recovery, and provider-independent behavior.

## Decisions to confirm before implementation

- Whether `asset_library_entries` should be a separate table or selected fields should live on `assets`.
- Which normalized scene attributes are sufficiently stable for the first metadata schema.
- Whether world-version mismatch is a hard rejection or a scored penalty for each asset category.
- Initial Strict, Balanced, and Broad thresholds and the sanitized evaluation set used to calibrate them.
- Default matching scope and recent-turn repetition window.
- Whether imported images require explicit review before all automatic reuse or only outside their original campaign.
- How creator provenance is displayed after future ownership transfer or shared publication.
- Whether resolution candidate evidence is retained indefinitely or summarized after a retention period.
- Export/import behavior for image metadata and binary assets without treating foreign user UUIDs as authorization.
- The authorization and moderation model required before `shared` scope is enabled.
