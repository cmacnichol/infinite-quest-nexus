import { createCampaignCastApplication } from "../../../packages/application/src/campaign-cast/index.js";
import { createPostgresCampaignCastRepository } from "../../../packages/database/src/campaign-cast-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { runCastDiscoveryOnce, type CastDiscoveryWorkerApplication } from "../../../packages/application/src/campaign-cast/discovery.js";
import { createCastDiscoveryJobRepository } from "../../../packages/database/src/campaign-cast-job-repository.js";
import { createCastDiscoveryExtractor } from "./campaign-cast-discovery-adapter.js";
import type { PreparedAuthoringTextExecutor } from "./authoring-text-execution-preparation.js";
import { logger } from "../../../packages/logger/src/index.js";

export function createApiCampaignCastApplication(pool: DatabasePool, config: Pick<RuntimeConfig, "castEditingEnabled">) {
  return createCampaignCastApplication(createPostgresCampaignCastRepository(pool, { editingEnabled: config.castEditingEnabled === true }));
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
