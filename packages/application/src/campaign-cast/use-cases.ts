import { castFromWorldPreviewQuerySchema, castFromWorldPreviewSchema, castFromWorldSchema, editAuthoredCastProfileSchema,
  type CastFromWorld, type CastFromWorldPreviewQuery, type EditAuthoredCastProfile } from "@infinite-quest/contracts";
import { reviewCastDetailSchema, reviewCastDetailResultSchema, type ReviewCastDetail } from "@infinite-quest/contracts";
import { detachCastAttachmentSchema, detachCastAttachmentResultSchema, type DetachCastAttachment } from "@infinite-quest/contracts";
import { castRosterCharacterSchema, castScopeSchema, castListQuerySchema, createCastCharacterSchema, editCastCharacterSchema,
  castWriteResultSchema, castDetailSchema, type CastScope, type CastListQuery,
  type CreateCastCharacter, type EditCastCharacter } from "@infinite-quest/contracts";
import { CampaignCastError, type CampaignCastWritePort } from "./ports.js";
import type { CastBackfillApplication } from "./backfill.js";
import { castDiscoveryStatusSchema, castCandidateQuerySchema, castCandidateListSchema, resolveCastCandidateSchema,
  castCandidateResolutionSchema, retryCastDiscoverySchema, castDiscoveryRetryResultSchema, type RetryCastDiscovery,
  type CastDiscoveryRetryResult, type CastCandidateQuery, type ResolveCastCandidate } from "@infinite-quest/contracts";

export function createCampaignCastApplication(repository: CampaignCastWritePort,
  discovery?: { retryFailed(scope: CastScope, id: string, request: RetryCastDiscovery): Promise<CastDiscoveryRetryResult> },
  scans?: CastBackfillApplication) {
  return {
    ...(scans ? { scans } : {}),
    async retryDiscovery(scope: CastScope, id: string, request: RetryCastDiscovery) {
      const parsedScope = castScopeSchema.parse(scope), parsedRequest = retryCastDiscoverySchema.parse(request);
      if (!discovery) throw new CampaignCastError("cast_discovery_disabled");
      return castDiscoveryRetryResultSchema.parse(await discovery.retryFailed(parsedScope, id, parsedRequest));
    },
    async detachAttachment(scope: CastScope, characterId: string, eventId: string, input: DetachCastAttachment) {
      return detachCastAttachmentResultSchema.parse(await repository.detachAttachment(castScopeSchema.parse(scope), characterId, eventId, detachCastAttachmentSchema.parse(input)));
    },
    async candidates(scope: CastScope, query: Partial<CastCandidateQuery> = {}) {
      return castCandidateListSchema.parse(await repository.candidates(castScopeSchema.parse(scope), castCandidateQuerySchema.parse(query)));
    },
    async resolveDetail(scope: CastScope, id: string, request: ReviewCastDetail) {
      if (!repository.resolveDetail) throw new CampaignCastError("cast_invalid_request");
      return reviewCastDetailResultSchema.parse(await repository.resolveDetail(castScopeSchema.parse(scope), id, reviewCastDetailSchema.parse(request)));
    },
    async resolveCandidate(scope: CastScope, id: string, request: ResolveCastCandidate) {
      return castCandidateResolutionSchema.parse(await repository.resolveCandidate(castScopeSchema.parse(scope), id, resolveCastCandidateSchema.parse(request)));
    },
    async discoveryStatus(scope: CastScope) {
      return castDiscoveryStatusSchema.parse(await repository.discoveryStatus(castScopeSchema.parse(scope)));
    },
    async workspaceStatus(scope: CastScope) {
      if (!repository.workspaceRead) throw new CampaignCastError("cast_discovery_unavailable");
      return (await repository.workspaceRead(castScopeSchema.parse(scope), true)).status;
    },
    async list(scope: CastScope, input: Partial<CastListQuery> = {}) {
      const query = castListQuerySchema.parse(input);
      const parsedScope = castScopeSchema.parse(scope);
      const workspace = repository.workspaceRead ? await repository.workspaceRead(parsedScope) : null;
      const value = workspace?.snapshot ?? await repository.current(parsedScope);
      if (query.expectedRevision !== undefined && query.expectedRevision !== value.revision
        || query.expectedTurnNumber !== undefined && query.expectedTurnNumber !== value.boundary.turnNumber
        || query.expectedTimelineRevision !== undefined && query.expectedTimelineRevision !== value.boundary.timelineRevision) throw new CampaignCastError("cast_revision_conflict");
      const matches = value.characters.filter((person) => query.filter === "ignored" ? person.ignored : !person.ignored)
        .filter((person) => query.filter === "main" ? person.origin.kind === "protagonist"
          : query.filter === "pinned" ? person.pinned
          : query.filter === "conflicts" ? workspace?.conflictIds.includes(person.id) === true
          : query.filter === "needs_review" ? workspace?.reviewIds.includes(person.id) === true
          : query.filter === "recent" ? Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0) > 0 && Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0) >= Math.max(1, value.boundary.turnNumber - 9)
          : true)
        .filter((person) => [person.name, ...person.aliases]
        .some((name) => name.toLocaleLowerCase("en-US").includes(query.query.toLocaleLowerCase("en-US"))))
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = query.cursor ? matches.findIndex((person) => person.id === query.cursor) + 1 : 0;
      if (query.cursor && offset === 0) throw new CampaignCastError("cast_revision_conflict");
      const characters = matches.slice(offset, offset + query.limit).map(person => castRosterCharacterSchema.parse(person));
      const attention = characters.map((person) => ({ characterId: person.id, review: workspace?.reviewIds.includes(person.id) === true,
        conflict: workspace?.conflictIds.includes(person.id) === true,
        ...(workspace?.attentionCounts?.[person.id] ? { reviewCount: workspace.attentionCounts[person.id]!.review, conflictCount: workspace.attentionCounts[person.id]!.conflict } : {}) })).filter((item) => item.review || item.conflict);
      return { ...value, characters, attention, recentWindow: 10, nextCursor: offset + characters.length < matches.length ? characters.at(-1)!.id : null };
    },
    async detail(scope: CastScope, id: string) {
      return castDetailSchema.parse(await repository.detail(castScopeSchema.parse(scope), id));
    },
    async fromWorldPreview(scope: CastScope, query: CastFromWorldPreviewQuery) {
      if (!repository.fromWorldPreview) throw new CampaignCastError("cast_presets_disabled");
      return castFromWorldPreviewSchema.parse(await repository.fromWorldPreview(castScopeSchema.parse(scope), castFromWorldPreviewQuerySchema.parse(query)));
    },
    async fromWorld(scope: CastScope, input: CastFromWorld) {
      if (!repository.fromWorld) throw new CampaignCastError("cast_presets_disabled");
      return castWriteResultSchema.parse(await repository.fromWorld(castScopeSchema.parse(scope), castFromWorldSchema.parse(input)));
    },
    async editAuthoredProfile(scope: CastScope, id: string, input: EditAuthoredCastProfile) {
      if (!repository.editAuthoredProfile) throw new CampaignCastError("cast_not_seeded");
      return castWriteResultSchema.parse(await repository.editAuthoredProfile(castScopeSchema.parse(scope), id, editAuthoredCastProfileSchema.parse(input)));
    },
    async create(scope: CastScope, input: CreateCastCharacter) {
      const parsedScope = castScopeSchema.parse(scope), parsedInput = createCastCharacterSchema.parse(input);
      return castWriteResultSchema.parse(await repository.create(parsedScope, parsedInput));
    },
    async edit(scope: CastScope, id: string, input: EditCastCharacter) {
      const parsedScope = castScopeSchema.parse(scope), parsedInput = editCastCharacterSchema.parse(input);
      return castWriteResultSchema.parse(await repository.edit(parsedScope, id, parsedInput));
    }
  };
}
export type CampaignCastApplication = ReturnType<typeof createCampaignCastApplication>;
