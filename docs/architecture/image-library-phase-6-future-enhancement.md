# Future enhancement: Image Library Phase 6

**Status:** Future enhancement. Not scheduled or approved for implementation.

**Source:** [Context-aware image library, PhotoSwipe browser, and illustration source policies](./image-library-enhancement-proposal.md#phase-6-semantic-sharing-and-advanced-browser-enhancements)

## Background

Phases 1-5 established an owner-scoped image library with durable provenance, verified image metadata, thumbnail derivatives, filtered cursor-based discovery, PhotoSwipe 5 browsing, manual selection, deterministic library matching, and provider fallback policies. That baseline deliberately does not infer cross-user access from a reuse-scope label, require embeddings, or expose classification and moderation controls whose provenance is not defined.

Phase 6 is the holding place for optional quality, collaboration, and high-volume curation features that should build on the stable baseline. Every capability in this item must remain independently disableable. Disabling Phase 6 must not break owner-only library browsing, manual selection, deterministic matching, or illustration generation.

## Intended benefits

- Improve match quality when compatible derived embeddings are already available, while retaining deterministic local matching as the fallback.
- Allow users to publish or grant access to selected images without weakening ownership or campaign boundaries.
- Add trustworthy content-category discovery after classification provenance and moderation behavior are defined.
- Make large libraries easier to curate through saved views, bulk actions, comparison tools, and richer PhotoSwipe metadata actions.
- Calibrate thresholds and ranking with measured rematch, rejection, and opt-out behavior instead of intuition alone.

## Required gates

Do not begin the corresponding workstream until its gates are met:

1. **Semantic matching:** a sanitized evaluation set, measurable match-quality targets, compatible derived embedding records, rebuild behavior, and an explicit policy for model/version mismatch.
2. **Sharing:** interactive authentication or OIDC linking, server-derived identity, explicit grants or publication records, authorization tests, revocation semantics, and an audit model. The existing `shared` reuse-scope value is not authorization.
3. **Content categories:** recorded classifier source, model/version, classification time, confidence, review overrides, and moderation rules. Provider filtering evidence alone is insufficient.
4. **Advanced browser features:** measured library scale and user workflows that justify the added interface and mutation complexity.

## Workstreams

### 6A. Evaluation-driven semantic matching

- Add optional semantic similarity only as another bounded score component.
- Preserve owner, grant, archive, review, reuse, scope, and contradiction checks as hard eligibility boundaries before semantic ranking.
- Store embeddings as derived, rebuildable indexes scoped by owner and asset.
- Record embedding provider/model identity, dimensions, source text protocol, and compatibility version.
- Fall back to the Phase 4 deterministic matcher when embeddings are absent, stale, incompatible, or unhealthy.
- Tune Strict, Balanced, and Broad thresholds using sanitized fixtures plus aggregate rematch, exclusion, and explicit-generation outcomes.
- Keep resolution explanations bounded; do not expose private prompts, unrestricted context snapshots, or ranking internals.

### 6B. Authorized sharing and publication

- Model explicit grants or publication records separately from ownership and reuse scope.
- Define viewer, selector, curator, publisher, and revoker capabilities rather than relying on a single shared flag.
- Make every list, facet, count, detail, attachment, match, and thumbnail/full-image request authorization-aware.
- Ensure revocation prevents future discovery and reuse while preserving auditable historical references according to a documented retention policy.
- Preserve creator provenance through ownership transfer or publication without treating creator identity as authority.
- Define portable export/import behavior without trusting foreign installation user IDs or grants.
- Add shared-with-me and published filters only after their query plans and isolation tests are complete.

### 6C. Classification-backed discovery and moderation

- Store content categories as attributed classification events rather than unversioned mutable labels.
- Separate provider request filtering, automated classification, owner curation, and moderator decisions.
- Define how conflicting classifications, confidence thresholds, appeals, overrides, and reclassification are handled.
- Prevent categories and facet counts from revealing unauthorized assets.
- Keep reattachment provider-independent; a provider content filter is not retroactive authorization or moderation.

### 6D. Advanced library and PhotoSwipe workflows

- Consider saved filter views containing only non-sensitive, authorized query fields.
- Add bulk tagging, review, archive, favorite, and reuse-eligibility actions with previews, bounded batches, partial-failure reporting, and optimistic concurrency.
- Consider side-by-side comparison for near-duplicates or variant selection without changing content-addressed deduplication rules.
- Add richer PhotoSwipe actions only when each action uses the same validated API mutation as the grid and provides loading, failure, and concurrency feedback.
- Evaluate responsive full-size derivatives and maximum served dimensions before expanding original-image delivery.
- Preserve keyboard access, touch behavior, focus restoration, reduced motion, safe text rendering, and a direct-image fallback.

## Security and integrity guardrails

- Derive identity on the server; never trust browser-supplied owner, creator, or grant identifiers.
- Apply authorization before filtering, faceting, ranking, or semantic lookup so excluded assets cannot affect results or timing observably.
- Never send private prompts, hidden mechanics, raw model output, credentials, or unrestricted provenance to a browser, embedding provider, or image provider.
- Keep embeddings, classifications, thumbnails, and summaries derived and rebuildable; authoritative bytes, ownership, grants, and references remain relational records.
- Require explicit, auditable operations for publication, ownership transfer, moderation, and bulk mutation.
- Preserve campaign/world isolation and accepted-turn semantics when shared assets are attached or later revoked.

## Validation requirements

- Semantic scoring improves the agreed evaluation metrics without increasing hard-contradiction or cross-scope matches.
- Removing or disabling embeddings produces valid deterministic results and does not interrupt story completion.
- Cross-user discovery, counts, facets, detail reads, byte access, matching, and attachment fail without an active grant.
- Grant creation, expiration, revocation, ownership transfer, export, and import have integration coverage.
- Classification provenance, overrides, reclassification, and category-filter isolation are tested.
- Bulk actions are owner/grant scoped, concurrency safe, bounded, recoverable, and auditable.
- Saved views cannot persist sensitive prompt data or resurrect access after authorization changes.
- Advanced PhotoSwipe actions remain consistent with grid actions and retain accessible fallbacks.

## Completion criteria

Phase 6 may be considered complete only when the shipped workstreams:

- can each be disabled without affecting the Phase 1-5 baseline;
- have explicit authorization and migration behavior;
- meet documented quality, performance, accessibility, and isolation targets;
- preserve deterministic provider-independent matching;
- do not expose unauthorized assets through results, metadata, facets, timing, or derived indexes; and
- include operator guidance for rollout, rollback, retention, and rebuilding derived data.

## Open decisions

- Evaluation corpus, target metrics, embedding model/version compatibility, and recalibration cadence.
- Grant roles, publication visibility, collaboration boundaries, revocation retention, and audit duration.
- Creator display and provenance rules after transfer, publication, anonymization, or deletion.
- Classification sources, moderation roles, override precedence, and retention of prior classifications.
- Whether resolution candidate evidence is retained indefinitely or summarized after a retention period.
- Responsive derivative sizes, full-image limits, and storage/caching budgets.
- Scale threshold for approximate facets, saved views, bulk curation, and comparison mode.
