# Transfer a campaign to another world

Use a cross-world transfer when you want to continue an existing campaign's accepted history against the canon of a different world. Transfer creates a new campaign; it does not alter the original.

1. Open **Campaigns** and select the source campaign.
2. Select **Transfer to another world…**.
3. Choose an active target world and an exact published version.
4. Name the new campaign.
5. Review the compatibility preview. Resolve blocking findings and acknowledge any warnings.
6. Select **Create transferred campaign**.
7. Review the newly selected campaign before continuing its story.

Nexus preserves the source character snapshot, accumulated campaign state, and accepted turns. Future story generation uses the target version's world canon. Target defaults are not silently merged into the existing state, and conflicts are reported rather than automatically rewritten.

The transfer starts a fresh provider continuation chain and rebuilds Chronicle indexes in the new campaign scope. Generation jobs, image jobs, provider costs, credentials, and rejected model output are not copied. Illustration failure or unavailable image providers do not prevent the authoritative campaign transfer.

The original campaign remains unchanged. If it is no longer needed, archive it separately only after verifying the transferred copy.

For a newer version of the same world, use [Upgrade a campaign world version](./upgrade-world-version.md) instead. For portability between installations or disaster recovery, use [campaign export and import](./import-export.md).
