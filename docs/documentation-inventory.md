# Documentation inventory and migration map

## Status

- Owner: repository maintainers
- Scope: documentation phases 0 through 6
- Last reviewed: 2026-07-21
- Audience: documentation authors and reviewers

This inventory records where current documentation belongs in the Infinite Quest Nexus documentation site. It is a migration aid, not product documentation. A moved page must remain reachable through a replacement link when contributors are likely to have bookmarked it.

## Audiences

| Audience | Primary goal | Primary sections |
| --- | --- | --- |
| Player | Start, continue, and recover an Infinite Quest story | Getting Started, Player Guide |
| World author | Create, review, publish, import, export, and fork worlds | Nexus Guide |
| Nexus administrator | Install and configure a trusted-network deployment | Installation |
| Operator | Upgrade, back up, monitor, recover, and run Swarm | Operations |
| Contributor | Understand, test, and change the platform safely | Development, Architecture |
| API integrator | Use HTTP contracts and durable jobs correctly | Reference |

## Existing source disposition

| Current source | Disposition | Destination or treatment |
| --- | --- | --- |
| `README.md` product introduction | Rewrite and retain | Concise repository landing page linking to the published documentation |
| `README.md` current capability list | Move and maintain | `reference/capabilities.md` |
| `README.md` requirements and startup | Rewrite and split | `getting-started/quick-start.md`, `installation/requirements.md`, and `installation/docker-compose.md` |
| `README.md` provider setup | Rewrite and split by role | `nexus-guide/providers/` and `installation/provider-configuration.md` |
| `README.md` import workflow | Rewrite | `nexus-guide/worlds/import-export.md` and `nexus-guide/campaigns/import-export.md` |
| `README.md` Chronicle context explanation | Rewrite and split | `concepts/chronicle-memory.md`, `concepts/context-construction.md`, and Chronicle reference pages |
| `README.md` endpoint list | Replace with structured reference | Future `reference/api/` phase; retain a compact link until complete |
| `README.md` development commands | Rewrite | `development/local-development.md` |
| `README.md` data and backup guidance | Rewrite and verify | `operations/backup-restore.md` |
| `README.md` Swarm guidance | Rewrite and verify | `operations/swarm/` |
| `README.md` security notes | Rewrite | `operations/security.md` and `concepts/security-boundaries.md` |
| `README.md` implementation milestones | Remove from user documentation | Track as GitHub issues or clearly historical planning material |
| `AGENTS.md` architecture and safety rules | Keep authoritative for agents | Use as a factual source; do not publish the instruction file as user documentation |
| `docs/architecture/0001` through `0016` | Keep with stable filenames | Add an architecture index and link the decisions from concept pages |
| `docs/operations/phase-1-checkpoint.md` | Preserve as history | Move to `docs/project-history/checkpoints/` after durable facts are incorporated elsewhere |
| `docs/operations/phase-2-checkpoint.md` | Preserve as history | Move to `docs/project-history/checkpoints/` after durable facts are incorporated elsewhere |
| `docs/operations/phase-3-checkpoint.md` | Preserve as history | Move to `docs/project-history/checkpoints/` after durable facts are incorporated elsewhere |
| `docs/operations/deferred-improvements.md` | Exclude from active product navigation | Retain under project history until items are represented by issues or ADR proposals |
| `.env.example` | Keep as configuration source | Document every setting in installation guidance; never duplicate real credentials |
| `compose.yaml` | Keep authoritative deployment manifest | Document lifecycle, health, storage, and safety behavior |
| `compose.override.example.yaml` | Keep authoritative example | Document development-only PostgreSQL exposure |
| `deploy/swarm/stack.yaml` | Keep authoritative deployment manifest | Document external database, secrets, configs, shared assets, scaling, and rollback |
| `database/migrations/` | Keep authoritative schema history | Explain online versus maintenance migrations and initial-user bootstrap |
| `packages/contracts/` | Keep authoritative payload contracts | Use as the source for future API and portable-format reference |
| `apps/web/public/` UI labels and help | Keep authoritative UI implementation | Use exact current labels in task guides and screenshot captions |
| `tests/` | Keep authoritative behavioral evidence | Use to verify workflows, isolation rules, recovery, and documented limitations |
| Root `index.html` | Preserve unchanged as legacy reference | Mention only in contributor and migration context; do not document it as the active UI |

## Target navigation

```text
Home
├── Getting Started
│   ├── Platform overview
│   ├── Quick start
│   ├── Create your first world
│   ├── Create your first campaign
│   └── Generate your first story turn
├── Player Guide
├── Nexus Guide
│   ├── World Library
│   ├── Campaigns
│   ├── Chronicle
│   └── Providers
├── Installation
├── Operations
│   ├── Compose
│   ├── Swarm
│   └── Recovery
├── Concepts
├── Reference
├── Development
├── Architecture decisions
└── Project history
```

The public navigation uses audience-friendly names. Individual pages should still follow the Diataxis distinction between learning-oriented tutorials, goal-oriented how-to guides, factual reference, and explanatory concepts.

## Content gaps by phase

### Phase 3: Getting Started and Player Guide

- Verified first-run journey from `.env` to an accepted turn
- World, campaign, provider, and model prerequisites
- Player controls, choices, story length, and model switching
- Refresh and durable-job recovery
- Optional illustration behavior and independent failure
- Portable campaign export and safe handling

### Phase 4: Nexus management

- Draft editing, character review, publication, version history, and deletion guards
- World fork, archive, restore, import, and export behavior
- Campaign creation, selection, archive, deletion, and explicit version upgrade
- Chronicle inspection, context modes, reindexing, and embeddings
- Independent text, embedding, and image provider configuration

### Phase 5: Installation and operations

- Clean Compose installation and verification
- Trusted-network security posture before authentication exists
- Secret and file-based-secret contract
- Provider networking for Docker Desktop and Swarm
- Backup, restore, upgrade, migration, health, logs, and recovery
- Swarm external PostgreSQL, independent API/worker roles, and shared asset storage

### Phase 6: Concepts and architecture

- Authoritative versus derived state
- Worlds, immutable versions, campaigns, turns, and Chronicle
- Prompt scopes and campaign isolation
- Durable generation and validation boundaries
- Private mechanics versus fiction-only content
- Independent illustration jobs
- Initial-user identity and future OIDC linking

## Historical-content rule

Historical checkpoints and plans may explain why the repository reached its current state, but they must not be the only place an operator can find a required procedure. Before moving a historical document, copy its durable operational knowledge into an active guide and verify it against the current code.
