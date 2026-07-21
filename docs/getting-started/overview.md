# Get to know Infinite Quest Nexus

Infinite Quest Nexus preserves story worlds and campaigns outside the browser and outside any model context window. The management application is **Infinite Quest Nexus**. The player-facing story experience is **Infinite Quest**.

## The basic workflow

1. Configure a story text provider.
2. Create or import a world draft in World Library.
3. Add at least one complete playable character.
4. Publish an immutable world version.
5. Create a campaign from that version and choose its player character.
6. Load the campaign in Infinite Quest and take an action.

## Core records

| Record | Meaning |
| --- | --- |
| World | A reusable authored project with one editable draft |
| World version | An immutable numbered snapshot published from a draft |
| Campaign | A mutable story instance pinned to one world version |
| Turn | An accepted player action and narration that becomes append-only history |
| Campaign state | Current authoritative facts and trackers produced by accepted turns |
| Chronicle | Campaign-scoped summaries and searchable memories derived from accepted history |

Editing a world draft never changes an existing campaign. Moving a campaign to a newer world version is an explicit management action.

## Provider roles

| Role | Purpose | Required? |
| --- | --- | --- |
| Story text | Generates narration and choices | Required to generate new turns |
| Chronicle embeddings | Adds semantic retrieval to lexical Chronicle search | Optional |
| Illustrations | Generates artwork after an accepted turn | Optional |

Each role has its own profile, endpoint, credentials, model inventory, default, health, and retry behavior. An embedding or illustration failure does not prevent text generation.

## Where data lives

PostgreSQL is authoritative for users, worlds, immutable versions, campaigns, accepted turns, and campaign state. Chronicle summaries and embeddings can be rebuilt from accepted data. Generated image assets live in the configured asset store and are referenced by database records.

During the current pre-authentication phase, the server assigns content to its database-backed initial owner. This is a trusted-network migration bridge, not interactive authentication.

## Continue

- [Start the local application](./quick-start.md)
- [Create your first world](./first-world.md)
- [Create your first campaign](./first-campaign.md)
- [Generate your first story turn](./first-story-turn.md)
