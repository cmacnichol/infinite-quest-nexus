import { castScopeSchema, castBackfillRequestSchema } from "../../../packages/contracts/src/index.js";
import { CampaignCastError, type CastBackfillApplication } from "../../../packages/application/src/campaign-cast/index.js";
import { createCastBackfillRepository } from "../../../packages/database/src/campaign-cast-backfill-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";

export function createApiCastBackfillApplication(pool: DatabasePool,
  config: Pick<RuntimeConfig, "castEditingEnabled" | "castDiscoveryEnabled" | "castBackfillEnabled">,
  providers?: Pick<ApiGenerationProviderCollaborators, "execution" | "resolution" | "prepareCastDiscoveryExecution">): CastBackfillApplication {
  const enabled = () => config.castEditingEnabled === true && config.castDiscoveryEnabled === true && config.castBackfillEnabled === true;
  const repository = createCastBackfillRepository(pool, enabled);
  async function prepare(rawScope: Parameters<CastBackfillApplication["preview"]>[0]) {
    const scope = castScopeSchema.parse(rawScope);
    if (!enabled()) throw new CampaignCastError("cast_discovery_disabled");
    const campaign = (await pool.query("SELECT text_provider_profile_id FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
    if (!campaign) throw new CampaignCastError("cast_not_found");
    if (!providers?.prepareCastDiscoveryExecution) throw new CampaignCastError("cast_discovery_unavailable");
    try {
      const resolution = await providers.resolution.resolveDirect({ ownerUserId: scope.ownerUserId, providerRole: "text",
        ...(campaign.text_provider_profile_id ? { selectedProviderProfileId: campaign.text_provider_profile_id } : {}) });
      if (resolution.status !== "resolved") throw new Error("Provider unavailable");
      const execution = await providers.execution.text({ ownerUserId: scope.ownerUserId }, resolution.providerProfileId, "text", resolution.model);
      return await providers.prepareCastDiscoveryExecution({ ownerUserId: scope.ownerUserId, execution });
    } catch { throw new CampaignCastError("cast_discovery_unavailable"); }
  }
  return {
    get enabled() { return enabled(); },
    async preview(scope, rawRequest) {
      const request = castBackfillRequestSchema.parse(rawRequest);
      return repository.preview(scope, request, await prepare(scope));
    },
    async start(scope, rawRequest) {
      const request = castBackfillRequestSchema.parse(rawRequest);
      if (!enabled()) throw new CampaignCastError("cast_discovery_disabled");
      const replay = await repository.replayStart(scope, request);
      if (replay) return replay;
      return repository.start(scope, request, await prepare(scope));
    },
    latest: repository.latest, get: repository.get, control: repository.control, retry: repository.retry
  };
}
