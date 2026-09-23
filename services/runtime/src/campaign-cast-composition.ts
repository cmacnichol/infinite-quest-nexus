import { createCampaignCastApplication, CampaignCastError } from "../../../packages/application/src/campaign-cast/index.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";
import { createPostgresCampaignCastRepository } from "../../../packages/database/src/campaign-cast-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { runCastDiscoveryOnce, type CastDiscoveryWorkerApplication } from "../../../packages/application/src/campaign-cast/discovery.js";
import { createCastDiscoveryJobRepository } from "../../../packages/database/src/campaign-cast-job-repository.js";
import { createCastDiscoveryExtractor } from "./campaign-cast-discovery-adapter.js";
import type { PreparedAuthoringTextExecutor } from "./authoring-text-execution-preparation.js";
import { logger } from "../../../packages/logger/src/index.js";

export function createApiCampaignCastApplication(pool: DatabasePool, config: Pick<RuntimeConfig, "castEditingEnabled" | "castDiscoveryEnabled">,
  providers?: Pick<ApiGenerationProviderCollaborators, "execution" | "resolution" | "prepareCastDiscoveryExecution">) {
  const jobs = createCastDiscoveryJobRepository(pool, () => config.castEditingEnabled === true && config.castDiscoveryEnabled === true);
  return createCampaignCastApplication(createPostgresCampaignCastRepository(pool, {
    editingEnabled: config.castEditingEnabled === true, discoveryEnabled: config.castDiscoveryEnabled === true }), {
    async retryFailed(scope, id, request) {
      try { return await jobs.retryFailed(scope, id, request); }
      catch (error) {
        if (!(error instanceof CampaignCastError) || error.code !== "cast_discovery_admission_required") throw error;
      }
      // The first transaction validated authorization, source, and request, then rolled back.
      // Provider metadata/preparation must never hold that transaction's connection.
      if (!providers?.prepareCastDiscoveryExecution) throw new CampaignCastError("cast_discovery_unavailable");
      let execution;
      try {
        const campaign = (await pool.query("SELECT text_provider_profile_id FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
        const resolution = await providers.resolution.resolveDirect({ ownerUserId: scope.ownerUserId, providerRole: "text",
          ...(campaign?.text_provider_profile_id ? { selectedProviderProfileId: campaign.text_provider_profile_id } : {}) });
        if (resolution.status !== "resolved") throw new CampaignCastError("cast_discovery_unavailable");
        const provider = await providers.execution.text({ ownerUserId: scope.ownerUserId }, resolution.providerProfileId, "text", resolution.model);
        execution = await providers.prepareCastDiscoveryExecution({ ownerUserId: scope.ownerUserId, execution: provider });
      } catch { throw new CampaignCastError("cast_discovery_unavailable"); }
      // Recheck all guards after metadata I/O, including races with corrections and other retries.
      return jobs.retryFailed(scope, id, request, execution);
    }
  });
}

export function createWorkerCampaignCastApplication(pool: DatabasePool, config: Pick<RuntimeConfig, "castDiscoveryEnabled">,
  executor: PreparedAuthoringTextExecutor): CastDiscoveryWorkerApplication {
  const repository = createCastDiscoveryJobRepository(pool, () => config.castDiscoveryEnabled === true);
  const extractor = createCastDiscoveryExtractor({ executor });
  return { async runNext(workerId) {
    if (config.castDiscoveryEnabled !== true) return false;
    const status = await runCastDiscoveryOnce({ workerId, repository, extractor });
    if (["failed", "checkpoint_failed", "publication_failed"].includes(status)) {
      logger.warn({ event: "cast_discovery_deferred", workerId, status });
    }
    return status === "complete" || status === "next_chunk";
  } };
}
