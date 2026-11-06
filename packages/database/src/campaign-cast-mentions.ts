import { buildCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { findCastMentions } from "../../domain/src/campaign-cast-mentions.js";
import type { CastScope } from "../../contracts/src/campaign-cast.js";
import type { DatabaseClient } from "./pool.js";
import { applyCastBatchWithClient, rebuildCastWithClient } from "./campaign-cast-repository.js";

/** Optional enrichment never prevents acceptance or correction of a turn. */
export async function recordAcceptedTurnCastMentions(client: DatabaseClient, scope: CastScope, turnId: string,
  onError: (error: unknown) => void): Promise<void> {
  await client.query("SAVEPOINT cast_lexical_mentions");
  try {
    const state = (await client.query("SELECT timeline_revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
    const row = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
      WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [turnId, scope.campaignId, scope.ownerUserId])).rows[0];
    if (state && row) {
      const cast = await rebuildCastWithClient(client, scope);
      const source = buildCastDiscoverySource({ scope, turnId, turnNumber: row.turn_number, narrationRevision: row.correction_revision,
        timelineRevision: state.timeline_revision, narration: row.effective_narration });
      const mentions = findCastMentions(source, cast.characters);
      for (let offset = 0; offset < mentions.length; offset += 100) {
        await applyCastBatchWithClient(client, scope, { boundary: cast.boundary,
          idempotencyKey: `lexical:${turnId}:${source.narrationRevision}:${source.timelineRevision}:${offset}`,
          commands: mentions.slice(offset, offset + 100).map((mention) => ({ kind: "mention" as const, characterId: mention.characterId,
            kindOfMention: "lexical" as const,
            evidence: { kind: "turn" as const, turnId, turnNumber: source.turnNumber, narrationRevision: source.narrationRevision,
              sourceHash: source.sourceHash, paragraphId: mention.paragraphId, quote: mention.quote },
            sourceRange: { turnId, narrationRevision: source.narrationRevision, sourceHash: source.sourceHash,
              paragraphId: mention.paragraphId, start: mention.start, end: mention.end } })) });
      }
    }
    await client.query("RELEASE SAVEPOINT cast_lexical_mentions");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT cast_lexical_mentions");
    await client.query("RELEASE SAVEPOINT cast_lexical_mentions");
    onError(error);
  }
}
