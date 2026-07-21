# ADR 0015: Permit deletion of unused published World versions

## Status

Accepted.

## Context

World versions are immutable snapshots, but immutability does not require retaining a snapshot that has never participated in a campaign. Authors need to remove accidental, obsolete, or test publications without deleting the World and its draft. A current campaign pin is not the only campaign dependency: migration history, Chronicle memories, and provider model chains can preserve a version's role in an authoritative campaign history.

Published version numbers can also escape the database through exports, logs, screenshots, and operator communication. Reusing a number after deleting the latest version would make those references ambiguous.

Drafts, forks, and import records use a World version as provenance rather than as authoritative campaign state. Deleting that source must not destroy independently editable content or import audit records.

## Decision

An owner may delete an individual published World version only through a dedicated, confirmed operation. The request identifies both the World and version and includes the expected version number so stale user interfaces cannot delete a different selection.

Deletion is rejected when the version has any campaign dependency, including:

- a campaign currently pinned to the version;
- a `campaign_world_migrations` row naming it as the source or destination;
- Chronicle memory scoped to it; or
- a model chain scoped to it.

The service checks these dependencies while holding the relevant World and version locks and returns a conflict with structured blocker counts. Database foreign keys remain the final integrity boundary. Generation and other operational records derive their version through a campaign or model chain and therefore cannot make an otherwise unused version eligible.

Non-campaign provenance is detached transactionally before deletion:

- a draft keeps its complete current content and clears `based_on_world_version_id`;
- a fork keeps its copied content and source World reference while clearing `forked_from_world_version_id`; and
- an import keeps its source hash, status, and statistics while clearing `world_version_id`.

If deletion leaves no published versions, the World remains available with its draft and returns to `draft` status. Deleting a version never renumbers surviving versions.

Each World owns a monotonically increasing next-version counter. Publication reserves and advances that counter transactionally; deletion never decreases it. Consequently, publishing after deletion may leave a deliberate gap in version numbers. This is preferable to making an old `v2` reference describe two different snapshots over time.

Successful deletion records a `world_version_deleted` activity event containing the World ID, deleted version ID and number, and provenance-detachment counts. It does not copy deleted story content into the event.

## API and user experience

The World Library exposes deletion as an action on the explicitly selected published version, separate from deleting the World. The confirmation identifies the version number and warns that deletion is permanent and version numbers are not reused. The client may use dependency metadata to disable an obviously blocked action, but the server always repeats authorization, ownership, stale-selection, and dependency checks.

When blocked, the UI explains whether a current campaign or historical campaign data retains the version. When permitted, it explains which draft, fork, or import provenance links will be detached. After deletion, World and campaign version selectors are refreshed from the authoritative API.

## Consequences

- Accidental unused publications can be removed without deleting their World.
- No campaign's current state, Chronicle, continuation chain, or migration audit can be orphaned.
- Drafts, forks, and import audits survive deletion of provenance-only links.
- Version-number gaps are expected and preserve the meaning of historical references.
- Deleting the only publication makes the World unavailable for new campaign creation until it is published again.
- A dependency preflight in the UI is advisory; concurrent campaign creation or migration can still make the final delete request fail safely.
