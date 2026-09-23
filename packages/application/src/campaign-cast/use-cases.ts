import { castScopeSchema, castListQuerySchema, createCastCharacterSchema, editCastCharacterSchema,
  castWriteResultSchema, castDetailSchema, type CastScope, type CastListQuery,
  type CreateCastCharacter, type EditCastCharacter } from "@infinite-quest/contracts";
import { CampaignCastError, type CampaignCastWritePort } from "./ports.js";
import { castDiscoveryStatusSchema, castCandidateQuerySchema, castCandidateListSchema, resolveCastCandidateSchema,
  castCandidateResolutionSchema, retryCastDiscoverySchema, castDiscoveryRetryResultSchema, type RetryCastDiscovery,
  type CastDiscoveryRetryResult, type CastCandidateQuery, type ResolveCastCandidate } from "@infinite-quest/contracts";

export function createCampaignCastApplication(repository: CampaignCastWritePort,
  discovery?: { retryFailed(scope: CastScope, id: string, request: RetryCastDiscovery): Promise<CastDiscoveryRetryResult> }) {
  return {
    async retryDiscovery(scope: CastScope, id: string, request: RetryCastDiscovery) {
      const parsedScope = castScopeSchema.parse(scope), parsedRequest = retryCastDiscoverySchema.parse(request);
      if (!discovery) throw new CampaignCastError("cast_discovery_disabled");
      return castDiscoveryRetryResultSchema.parse(await discovery.retryFailed(parsedScope, id, parsedRequest));
    },
    async candidates(scope: CastScope, query: Partial<CastCandidateQuery> = {}) {
      return castCandidateListSchema.parse(await repository.candidates(castScopeSchema.parse(scope), castCandidateQuerySchema.parse(query)));
    },
    async resolveCandidate(scope: CastScope, id: string, request: ResolveCastCandidate) {
      return castCandidateResolutionSchema.parse(await repository.resolveCandidate(castScopeSchema.parse(scope), id, resolveCastCandidateSchema.parse(request)));
    },
    async discoveryStatus(scope: CastScope) {
      return castDiscoveryStatusSchema.parse(await repository.discoveryStatus(castScopeSchema.parse(scope)));
    },
    async list(scope: CastScope, input: Partial<CastListQuery> = {}) {
      const query = castListQuerySchema.parse(input);
      const value = await repository.current(castScopeSchema.parse(scope));
      const matches = value.characters.filter((person) => [person.name, ...person.aliases]
        .some((name) => name.toLocaleLowerCase("en-US").includes(query.query.toLocaleLowerCase("en-US"))))
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = query.cursor ? matches.findIndex((person) => person.id === query.cursor) + 1 : 0;
      if (query.cursor && offset === 0) throw new CampaignCastError("cast_revision_conflict");
      const characters = matches.slice(offset, offset + query.limit);
      return { ...value, characters, nextCursor: offset + characters.length < matches.length ? characters.at(-1)!.id : null };
    },
    async detail(scope: CastScope, id: string) {
      return castDetailSchema.parse(await repository.detail(castScopeSchema.parse(scope), id));
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
