# Nexus management guide

Infinite Quest Nexus provides the management workflows for reusable worlds, persistent campaigns, Chronicle memory, and independent provider profiles.

## Management areas

- [Navigate Nexus](./navigating-nexus.md)
- [World Library](./worlds/create.md)
- [Campaigns](./campaigns/create.md)
- [Chronicle](./chronicle/inspect.md)
- [Providers](./providers/text.md)
- [Turn intent classification](./providers/turn-intent.md)

## Safety model

- A world draft is mutable; a published version is immutable.
- Existing campaigns do not change when a draft or newer version changes.
- Campaign upgrades are explicit and retain the append-only accepted ledger.
- Chronicle summaries and embeddings are derived from authoritative campaign data.
- Text, embedding, and image providers have independent credentials and health.
- Imports and generated output are untrusted input owned by the server-resolved user.
