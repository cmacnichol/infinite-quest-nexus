# Infinite Quest Nexus

Infinite Quest Nexus separates portable story data from installation recovery so users and operators can choose the correct transfer or recovery workflow.

## Portability and recovery

**System Archive**:
A versioned, cross-instance archive of one current owner's portable authoritative data, original assets, and portable settings. It is a logical migration format, not an exact database or deployment copy.
_Avoid_: System backup, database dump, whole-database export

**Disaster-Recovery Backup**:
An operator-managed recovery set for restoring an installation, including PostgreSQL data, asset storage, and the encryption material and deployment configuration required by that installation.
_Avoid_: System Archive, portable export

**Campaign Archive**:
A portable archive of one campaign, its pinned immutable world version, portable campaign history and state, and the original assets in that campaign's defined scope.
_Avoid_: System Archive, story export

**Readable Story Export**:
A human-readable rendering of a campaign, such as Markdown, HTML, or print-to-PDF, that is not intended for application import or authoritative recovery.
_Avoid_: Campaign Archive, backup

**Current Owner**:
The user whose owned content and preferences define the scope of a System Archive at export time. Source ownership is provenance and does not establish authority on the receiving instance.
_Avoid_: Installation, source user ID

**Portable Setting**:
User, story, prompt, or non-secret provider configuration whose meaning remains valid on another instance. It excludes credentials and host, network, storage, capacity, and deployment configuration.
_Avoid_: Runtime configuration, secret

**Original Asset**:
A retained source image and its portable library metadata, whether or not the image is currently bound to visible story content.
_Avoid_: Illustration, thumbnail, derivative

**Derived Asset**:
A regenerable representation of an Original Asset, such as a thumbnail, that is not authoritative portable data.
_Avoid_: Original Asset

**Operational State**:
Transient execution or access state used to run, resume, observe, or authorize work, rather than to preserve authored or accepted story content.
_Avoid_: Campaign State, portable history

**Archive Fingerprint**:
A stable digest of a portable archive's logical records and Original Assets, independent of creation time and packaging details.
_Avoid_: Archive ID, file checksum

**Import Preview**:
A validated, non-mutating description of an archive and the exact destination operation it would perform.
_Avoid_: Dry run, partial import

**Import Report**:
The durable record of a completed or failed import, including verified counts, normalization, ownership mapping, rebuild work, warnings, and errors.
_Avoid_: Progress message, activity log

**Data Transfer**:
The user-facing area for portable System, Campaign, and World archives; legacy and external imports; and Readable Story Exports.
_Avoid_: Backup console, restore administration

**Compatibility Adapter**:
A validated translation from a supported older or external portable format into the current logical import contract.
_Avoid_: Database migration, silent conversion

**Recovery Set**:
The coordinated database, asset-storage, version inventory, integrity evidence, and separately escrowed encryption material required for disaster recovery.
_Avoid_: System Archive, portable export

**Restore Drill**:
An isolated restoration and verification of a Recovery Set performed before that set is relied upon for production recovery.
_Avoid_: Import Preview, migration test

**Portability Classification**:
The declared treatment of a persisted domain as portable authority, portable after normalization, rebuildable, operational, security authority, or deployment configuration.
_Avoid_: Export flag, table copy rule

**Drill-Proven Recovery Set**:
A Recovery Set that has passed an isolated Restore Drill and application-level continuity checks.
_Avoid_: Created backup, verified archive

**Source Instance**:
The installation whose Current Owner creates a portable archive. It remains independent and unchanged by destination import.
_Avoid_: Primary instance, authoritative instance

**Destination Instance**:
The installation that validates and imports a portable archive under its own ownership and security authority.
_Avoid_: Replica, synchronized instance
