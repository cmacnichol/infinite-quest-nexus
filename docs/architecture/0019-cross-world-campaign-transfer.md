# ADR 0019: Cross-world campaign transfer creates an independent copy

## Status

Accepted

## Context

A campaign is pinned to one immutable world version, but a player may want to continue its accepted history in a different world. Treating this as an ordinary version migration would blur world ownership, silently reinterpret campaign state, and make rollback difficult. Portable export and import remains valuable for backups and movement between installations, but serializing a campaign is unnecessary and potentially lower fidelity for an in-installation operation.

## Decision

Campaign Management provides an explicit **Transfer to another world** operation. It creates a new campaign and leaves the source unchanged. The existing world-version migration remains an in-place operation restricted to newer versions of the same world.

Before commit, Nexus previews compatibility against an exact target world version. Blocking findings prevent transfer; warnings require acknowledgement. Commit revalidates ownership, readiness, source turn and state revisions, and a source fingerprint under a database lock. An idempotency key ensures retries create at most one target campaign.

The target copies the source campaign's accepted-turn ledger, authoritative state, state-edit history, selected-character snapshot, settings, summary checkpoints, and safe asset references. It does not copy model continuation chains, operational jobs, provider costs, or derived Chronicle indexes. Target Chronicle projections are rebuilt under the new campaign and target-world scope; future prompts use target-world canon. Target defaults are not silently merged into accumulated campaign state.

Source archival is a separate, explicit follow-up after the user reviews the transferred campaign.

Portable campaign import may reuse the same compatibility and character-policy rules when attaching a backup to an existing world version. Imported provenance never establishes authorization.

## Consequences

- Cross-world continuation is reversible because the original remains usable.
- Historical narration is preserved even when it conflicts with target canon; compatibility findings surface conflicts rather than asking an LLM to rewrite history.
- A transfer consumes additional authoritative storage until the source is archived or deleted.
- Derived memory and provider continuation state must be rebuilt, so semantic indexing may continue after the target campaign becomes available.
- Asset references must remain valid independently of the source campaign lifecycle.

## Alternatives considered

Changing `world_version_id` in place was rejected because it removes a reliable recovery point and makes cross-world semantics look equivalent to a same-world version upgrade. Requiring export and re-import was rejected as the primary local workflow because it adds a portability round trip and can omit installation-specific authoritative detail.
