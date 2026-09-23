import { castScopeSchema, castSnapshotSchema, type CastScope, type CastSnapshot } from "../../contracts/src/campaign-cast.js";
import { buildScopedEntityCatalog, resolveEntityMetadata } from "../../domain/src/entity-references.js";
import { historicalFactAliasPatterns } from "./chronicle-historical-fact-pool.js";
import type { DatabaseClient } from "./pool.js";

/** Caller holds the campaign transaction lock. Only rebuildable identity indexes change. */
export async function refreshCastChronicleMetadata(client: DatabaseClient, rawScope: CastScope, rawSnapshot: CastSnapshot): Promise<void> {
  const scope = castScopeSchema.parse(rawScope), snapshot = castSnapshotSchema.parse(rawSnapshot);
  const campaign = (await client.query(`SELECT c.world_version_id,c.character_profile,c.character_snapshot,w.content
    FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id
    WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!campaign) throw new Error("Cast metadata campaign not found.");
  const catalog = buildScopedEntityCatalog({ worldContent: campaign.content, worldVersionId: campaign.world_version_id,
    characterSnapshot: campaign.character_snapshot, characterProfile: campaign.character_profile, campaignCharacters: snapshot.characters });
  // Candidate matching may be broad; full-catalog resolution below retains ambiguity.
  const patterns = [...new Set(catalog.filter((entity) => entity.source === "campaign")
    .flatMap((entity) => historicalFactAliasPatterns([entity], [entity.id])))];
  for (const table of ["chronicle_memories", "campaign_canonical_facts"] as const) {
    const ordinal = table === "chronicle_memories" ? "ordinal" : "source_turn_number";
    let after: string | null = null;
    for (;;) {
      const rows: { id: string; content: string; entity_ids: string[] }[] = (await client.query(
        `SELECT id,content,entity_ids FROM ${table}
         WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND ${ordinal}<=$4
           AND ($5::uuid IS NULL OR id>$5::uuid)
           AND (EXISTS (SELECT 1 FROM unnest(entity_ids) entity_id WHERE entity_id LIKE 'campaign:%')
             OR lower(normalize(content,NFKC)) ~ ANY($6::text[]))
         ORDER BY id LIMIT 250`, [scope.ownerUserId, scope.campaignId, campaign.world_version_id, snapshot.boundary.turnNumber, after, patterns])).rows;
      for (const row of rows) {
        const ids = [...new Set([...row.entity_ids.filter((id) => !id.startsWith("campaign:")), ...resolveEntityMetadata(row.content, catalog).entityIds])].sort();
        if (JSON.stringify(ids) === JSON.stringify([...row.entity_ids].sort())) continue;
        // A concurrent source rewrite must not receive metadata derived from old text.
        await client.query(`UPDATE ${table} SET entity_ids=$5::text[] WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3 AND content=$4 AND world_version_id=$6`,
          [row.id, scope.ownerUserId, scope.campaignId, row.content, ids, campaign.world_version_id]);
      }
      if (rows.length < 250) break;
      after = rows.at(-1)!.id;
    }
  }
}
