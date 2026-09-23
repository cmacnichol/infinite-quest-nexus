import { createCampaignCastApplication } from "../../../packages/application/src/campaign-cast/index.js";
import { createPostgresCampaignCastRepository } from "../../../packages/database/src/campaign-cast-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";

export function createApiCampaignCastApplication(pool: DatabasePool, config: Pick<RuntimeConfig, "castEditingEnabled">) {
  return createCampaignCastApplication(createPostgresCampaignCastRepository(pool, { editingEnabled: config.castEditingEnabled === true }));
}
