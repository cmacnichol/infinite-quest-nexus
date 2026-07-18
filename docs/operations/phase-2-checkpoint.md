# Phase 2 checkpoint

Phase 2 makes the World Library and campaign lifecycle first-class database-backed workflows while preserving the Phase 1 Story Engine and Chronicle boundaries.

## Delivered

- Editable world drafts with optimistic revision checks.
- Immutable numbered world publication with release notes and content hashes.
- Version browsing, archive/restore, and source-version-aware world forks.
- Campaign creation from a selected published version.
- Campaign switching, metadata updates, archive state, and portable export.
- Explicit same-world campaign upgrades with audit records and active-generation protection.
- Provider response-chain invalidation after campaign version migration.
- Portable world export, validation preview, idempotent import, and editable imported drafts.
- World and campaign/story validation previews with invalid-turn and recursively removed credential-field warnings.
- Server-generated exports that omit provider settings, credentials, provider-profile identifiers, provider response identifiers, rejected output, and operational jobs.
- Responsive World Library and campaign controls in the Nexus interface.

## Persistence rules verified

- Saving a draft cannot mutate any published version.
- Publishing a newer version cannot move an existing campaign.
- Campaign migration cannot cross world boundaries or run during active story generation.
- Migration preserves append-only accepted turns and historical Chronicle memory.
- The next turn after migration uses the newly selected world version and a fresh model chain.
- Forked worlds are independent drafts with source provenance.
- Repeated portable imports resolve to the existing owned record.
- Legacy story imports receive an editable draft based on their imported immutable version.

## Verification

- Repository data-safety scan passed.
- TypeScript and browser-module syntax checks passed.
- 28 unit tests passed.
- 21 PostgreSQL 18 and pgvector integration tests passed.
- Compose and Swarm configurations rendered successfully.
- The production container built and the local Compose application reported ready.
- Browser verification covered world creation, draft editing, two publications, campaign creation, pinned-version notification, explicit migration, fork, archive, export, and import preview.
- A narrow mobile viewport had no horizontal overflow and produced no new browser console warnings or errors.

Runtime database records, browser saves, imported content, exports, provider credentials, logs, and the pre-migration backup remain outside the repository.
