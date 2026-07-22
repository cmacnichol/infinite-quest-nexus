# Upgrade a campaign world version

Campaigns remain pinned until an explicit same-world upgrade.

This operation updates the existing campaign. To create an independent continuation in a different world, use [Transfer a campaign to another world](./transfer-world.md).

1. Publish a newer version of the campaign's world.
2. Select the campaign.
3. Choose the newer **World version**.
4. Select **Migrate version**.
5. Review and confirm the migration.

Nexus refuses migration while a generation job is active and does not allow migration to a different world. The accepted-turn ledger remains append-only. The next generation starts from authoritative database state with a fresh provider chain compatible with the new version.

Review new canon and character implications before migrating. The campaign's selected character snapshot and accumulated state remain campaign-owned rather than being silently replaced by draft data.
