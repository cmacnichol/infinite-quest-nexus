# Character review dismissal and fact retraction

Status: proposed design for implementation; no new behavior implemented or deployed. Baseline: `8eeecef3`.

## Problem and current evidence

The shared review renderer in `apps/web/src/cast-review-queue.ts` offers unresolved identities only Attach, Create separate character, and Skip for this pass. Skip is a renderer-local Set and does not persist. Details under an unresolved identity are plain text. Resolved details support accept, confirm (override), and dismiss through `packages/database/src/campaign-cast-candidate-repository.ts`; dismissals already suppress equivalent retained-source details through `campaign-cast-review-sql.ts`. Existing candidate resolution can apply eligible observations when creating/attaching an identity, so hiding a detail only in the browser would not prevent its application.

Existing character removal is reversible and capability-gated in `campaign-cast-panel.ts`. Its unavailable message says only that merging is disabled, although the same lifecycle capability gates removal and restoration. `projectCastProfile` projects observations and overrides but has no user-retraction input. Cast portable journals currently support versions 1–4. Web-Next imports the shared review renderer; review changes therefore require both clients' verification.

## User-visible behavior

| Action | Meaning | Persistence |
|---|---|---|
| Skip for now | Defer this identity or grouped field for this review pass | Session only; explicitly says it returns next pass |
| Dismiss discovery | Reject this pending identity proposal and its associated proposed details | Operational decision for this exact source/proposal; Undo and Dismissed review view |
| Dismiss detail | Reject one proposed observation, before or after resolving its identity | Operational decision for this exact source/observation; Undo |
| Retract fact | Stop a recorded observation contributing to current character state | Append-only campaign correction; Restore fact |
| Remove from cast | Remove an existing supporting character from active use | Existing lifecycle operation, with existing Restore |

Dismiss is not a global ban on a name or alias. New evidence at another turn or a corrected source can appear again. Copy must state this. Operational dismissal records are excluded from portable archives and branches, consistent with current inbox policy; imported or branched history may be reviewed again. Same-installation retained-source rescans must honor dismissals. Fact retractions are authoritative campaign edits and must survive supported archive, branch and transfer workflows.

### Review layout

Identity cards show source quote, proposed details with individual Dismiss detail actions, existing-character selection, Attach, Create separate character, Dismiss discovery, and secondary Skip for now. Dismissing every detail does not dismiss the identity. Attach/create excludes dismissed details server-side and does not automatically undo any dismissal. Original proposal indexes and hashes remain stable; never address a detail by its filtered display index.

Each successful dismissal advances the queue, announces the result, and offers Undo. A Pending / Dismissed view makes recovery available after navigation or reload for dismissals made with this review workflow. Historical legacy detail dismissals continue suppressing matching evidence but are not listed or restorable in this view; they are not silently migrated. UI copy and guidance must say “Dismissals made with this review workflow” rather than implying all historical dismissals are available. Undo targets a returned decision ID and never changes an accepted fact. Show individual decisions in Dismissed with source and target labels; do not combine different source observations merely because their text matches. Restoring a detail whose identity is still dismissed leaves it hidden until the discovery is restored. Restoring a discovery retains independent detail dismissals. A restored detail on an already-resolved identity returns to detail review, not automatic acceptance.

Keep errors in place with Retry or Reload review; no optimistic disappearance before a confirmed response. Disable conflicting actions while saving. Restore keyboard focus to the next card heading, the empty-state heading, or the restored item. Large quotes are safe text and remain usable at 390px and native 200% zoom.

### Recorded facts

In the character's source/evidence history, show Retract fact beside each eligible turn-backed fact. Distinguish observations from authored profile, overrides, claims and identity mentions. This release supports supporting-character fact observations only; protagonist profile changes remain in its editor, and claims are not labeled facts. Existing authored-profile policies remain authoritative.

A confirmation previews the effective field before and after retraction and identifies the quote/turn. Retraction may reveal an older value, remove a conflict, or leave an override unchanged; show that result rather than promising a blank field. Keep retracted observations visible in an expandable history, labeled Retracted, with Restore fact. Restore recomputes current state against current evidence and may reintroduce a conflict; it cannot resurrect narration invalidated by correction or rewind.

Do not physically delete observations, source narration, turns, identities or receipts. Do not implement retraction as an empty override or as source invalidation. Preserve all explicit supersession edges: retracting a superseding fact does not silently unsupersede its predecessor. Ordinary older observations not explicitly superseded may become effective again.

Retraction applies to one immutable observation ID. Publication must not revive the same retained source observation under a new ID: reject an exact equivalent fact identified by source turn/revision/hash, field/value/mode/speaker and paragraph/quote for the effective identity while its retraction remains active. Different evidence remains eligible. This suppression must use campaign-local identities and the shared merge/reference rules.

### Existing-character removal

Keep Remove from cast in supporting-character detail actions and expose an explanation when editing/lifecycle capability is disabled: “Removing and restoring characters is disabled on this server.” Do not enable flags or restart services automatically. A pending identity is dismissed without first creating a character. Protagonists and merged-away identities retain their current restrictions. Removed identities continue reserving names/aliases and use the existing Removed filter and Restore flow.

## Persistence and API design

### Pending-review decisions (operational)

Add `campaign_cast_review_decisions`, scoped by owner and campaign with scoped candidate/source relationships. Store decision UUID, candidate UUID, target (identity or observation index), source turn/revision/hash/timeline, canonical target fingerprint, action (dismiss or restore), referenced dismissal UUID for restore, sequence/revision, request hash, idempotency key, and result receipt. Keep it append-only for audit while the campaign and source turn remain; cancellation of source validity is a projection, not destructive deletion. Explicit campaign deletion or removal of the source turn cascades the associated operational decisions; deleting a candidate alone while its source remains cannot erase them. Foreign keys must not cross owner/campaign boundaries. Add indexes for scoped active-fingerprint lookup and unique scoped idempotency keys.

A shared pure fingerprint helper accepts typed stored source and the original identity/observation payload; canonical serialization excludes runtime candidate/job IDs and UI ordering. Identity fingerprints include normalized name, sorted aliases, existing identity reference and source identity evidence. Detail fingerprints include the canonical proposed identity as well as the original field/value/mode/speaker and quote/paragraph, so identical evidence about distinct people is independent; do not normalize away meaningful value differences. Store original payload/source alongside hashes for collision-safe equality checks. Timeline/source validity is checked independently of the fingerprint; retained decisions follow existing reconciliation for unchanged source after timeline changes, and become ineligible for changed/discarded sources.

Use separate additive endpoints so old attach/create and confirmed-detail response shapes remain valid:

- `POST /cast/candidates/:candidateId/review-decisions`: discriminated `dismiss_identity`, `dismiss_detail` (original observationIndex), or `restore` (decisionId). All carry cast revision, boundary, sourceHash, expectedReviewRevision and idempotencyKey. Result: decisionId, candidateId, reviewRevision, cast revision/boundary, disposition; no fabricated character required.
- `GET /cast/review-decisions?view=dismissed&cursor=...&limit=...`: paginated active dismissals with original source/target and restore eligibility. Limit 1–50, default 20.
- A campaign-scoped operational sequence supplies `expectedReviewRevision`/`reviewRevision`, including duplicate candidates for the same source; it changes on every new decision, without falsely advancing character state. Candidate results add `reviewRevision` and indexed `reviewDetails` for unresolved identities; existing proposal and resolved `details` remain compatible. Candidate view/count queries exclude active dismissals before pagination.

Use the existing campaign transaction/lock ordering. New writes require editing capability, server-resolved owner, current retained source, expected cast/boundary/review revision, and no active generation. Replay the same valid receipt without repeating effects; key reuse with a changed request is a conflict. Same-source rescan lookup uses active semantic decisions. Reconcile existing `detail_decisions` dismissals through a compatibility reader; do not reinterpret earlier confirms/accepts or silently rewrite them. The existing resolveDetail dismiss path delegates to the shared decision repository while preserving its old result contract. Candidate attach/create consults active dismissals under the same lock before applying observations, including world-seeding paths.

### Recorded-fact decisions (authoritative)

Add typed `retract_observation` and `restore_observation` journal commands with characterId and observationId. Restore also references the retraction event ID; this prevents an old Undo from reversing a newer decision. Validate ownership of the actual observed identity through merge provenance, never trusting a browser-supplied character alone. Refuse redundant/ineligible transitions. Retractions require editing capability, expected cast/character revisions, current boundary and generation lock; they do not require lifecycle enablement.

Expose preview and apply through `POST /cast/characters/:characterId/observations/:observationId/decision-preview` and `/decision`. Preview returns current/projected field, source, conflict state and revisions. Apply revalidates the same expected revisions and uses an idempotency key; preview is not authority. The public `ObservationDecisionRequest` carries `action: "retract" | "restore"`, expectedCastRevision, expectedCharacterRevision, expectedBoundary and idempotencyKey; restore additionally requires retractionEventId. Preview returns field, currentValue/projectedValue (nullable), currentConflict/projectedConflict, eligible source, and current revisions/boundary; apply returns the existing cast write result plus observationId, disposition and decisionEventId. Retraction/restore advances both cast and effective character revisions. Retraction state derives from retained journal events at the requested boundary and feeds every profile/context consumer. Projection and context must agree within the applicable character field policy: seeded observed appearance retains its latest-valid-observation policy, while non-seeded static fields retain conflict handling. Validate supersession against the full retained observation graph before omitting retracted contributions.

Extend typed reference translation and portable validation for both observation IDs and retraction event IDs. Cast archive format 5 is required only when these commands are present; readers accept 1–5 and old-format exports remain unchanged when possible. Rewind before a retraction restores the prior contribution; rewind before an observation removes both observation and inapplicable correction. Merge/unmerge must retain observation identity and recompute each resulting profile without copying or losing correction authority.

## Safeguards and release

- Preserve server-resolved identity, campaign/world isolation, generation locks, idempotency, revision and source fences.
- No provider call, prompt-protocol change, world mutation, accepted-turn rewrite or capability activation.
- Ship pending-review dismissal first; recorded-fact retraction is a separately releasable second stage, dependent on compatible replay/archive readers.
- Add an additive migration after the current `0133_baseline.sql`; never rewrite the baseline. At implementation start select the next free number (currently 0134).
- Record the accepted architecture in a new ADR before executable changes. Extend existing runbooks with reader-first rollout, rollback floor and no destructive down-migration while retained correction journals exist. After format-5 writes, rollback requires compatible readers or a reviewed restore; turning off editing does not make old readers safe.
- This proposal authorizes neither implementation nor production deployment by itself.

## Acceptance

D1: Skip is temporary; identity/detail dismiss persists through reload and same-source rescan, with no cast creation or fact mutation.
D2: Individual unresolved detail dismissal survives attach/create, including world seeding; correct original indexes are used.
D3: Undo/Dismissed recovery preserves independent decisions; stale or changed-source requests conflict without side effects.
D4: Retract/restore changes profile, conflict status and narrative-context contribution consistently; overrides/authored policy remain intact.
D5: Duplicate publication, merge/unmerge, rewind, source correction, branch/transfer and archive round-trip preserve intended authority and isolation.
D6: Existing removal is discoverable, reversibly works when enabled, and explains disabled capability without changing configuration.
D7: Both clients remain compatible; accessible keyboard, narrow layout, focus, native zoom and real API/PostgreSQL flows are verified with screenshots.
