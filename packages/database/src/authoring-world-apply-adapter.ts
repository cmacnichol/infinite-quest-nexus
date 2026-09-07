import type { AuthoringWorldApplyPort, AuthoringTransaction } from "../../application/src/authoring/ports.js";
import { AuthoringRepositoryError } from "../../application/src/authoring/types.js";
import type { OwnerScope } from "../../application/src/generation/types.js";
import type { WorldCampaignCommandContext } from "../../application/src/world-campaign/types.js";
import type { PlayableCharacter, WorldContent } from "../../contracts/src/world-library.js";
import type { AuthoringTarget } from "../../contracts/src/authoring.js";
import { worldContentSchema } from "../../contracts/src/world-library.js";
import { createPostgresWorldRepository } from "./world-repository.js";
import { worldCampaignDatabaseClient } from "./world-campaign-transaction.js";

function failureCode(value: { ok: false; failure: { reason: string } }): never {
  if (value.failure.reason === "world_not_found") throw new AuthoringRepositoryError("not_found");
  if (value.failure.reason === "draft_revision_changed") throw new AuthoringRepositoryError("revision_conflict");
  throw new AuthoringRepositoryError("invalid_state");
}

function mergeCharacter(content: WorldContent, candidate: PlayableCharacter, characterId?: string): WorldContent {
  const roster = [...content.playableCharacters];
  const selected = characterId ?? candidate.id;
  const index = roster.findIndex((entry) => entry.id === selected);
  if (characterId !== undefined && (index < 0 || candidate.id !== characterId)) throw new AuthoringRepositoryError("invalid_state");
  if (index >= 0) roster[index] = candidate;
  else roster.push(candidate);
  return worldContentSchema.parse({ ...content, playableCharacters: roster });
}

/** Applies author-reviewed content through the established world repository using the caller's transaction client. */
export function createPostgresAuthoringWorldApplyAdapter(): AuthoringWorldApplyPort {
  const worlds = createPostgresWorldRepository();
  return {
    async applyInTransaction(rawTransaction, scope, target, content) {
      const transaction = rawTransaction as WorldCampaignCommandContext;
      if (target.kind === "new_world") {
        const parsed = worldContentSchema.safeParse(content);
        if (!parsed.success) throw new AuthoringRepositoryError("invalid_state");
        const created = await worlds.createWorld(transaction, scope, { title: parsed.data.world.title, content: parsed.data });
        if (!created.ok) return failureCode(created);
        return { worldId: created.value.id, draftRevision: created.value.draftRevision };
      }

      const client = worldCampaignDatabaseClient(transaction);
      const locked = await client.query<{ content: unknown; revision: number }>(
        `SELECT wd.content, wd.revision FROM worlds w
          JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
         WHERE w.id = $1 AND w.owner_user_id = $2 AND w.status <> 'archived'
         FOR UPDATE OF w, wd`,
        [target.worldId, scope.ownerUserId]
      );
      const current = locked.rows[0];
      if (!current) throw new AuthoringRepositoryError("not_found");
      if (current.revision !== target.expectedRevision) throw new AuthoringRepositoryError("revision_conflict");
      const parsedWorld = worldContentSchema.safeParse(content);
      const next: WorldContent = parsedWorld.success
        ? parsedWorld.data
        : mergeCharacter(worldContentSchema.parse(current.content), content as PlayableCharacter, target.characterId);
      const updated = await worlds.updateWorldDraft(transaction, { ownerUserId: scope.ownerUserId, worldId: target.worldId }, {
        expectedRevision: target.expectedRevision,
        title: next.world.title,
        content: next
      });
      if (!updated.ok) return failureCode(updated);
      return { worldId: updated.value.worldId, draftRevision: updated.value.revision, ...(parsedWorld.success ? {} : { characterId: (content as PlayableCharacter).id }) };
    }
  };
}
