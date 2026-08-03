import { createGenerationApplication, type GenerationApplication } from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository } from "../../../packages/database/src/generation-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { turnReportedCosts } from "../../api/src/cost-service.js";
import { promptProtocolVersion, resolvePromptSnapshot } from "../../api/src/prompt-library-service.js";

export function createApiGenerationApplication(pool: DatabasePool): GenerationApplication {
  return createGenerationApplication(createPostgresGenerationCommandRepository(pool, {
    resolvePromptSnapshot,
    promptProtocolVersion,
    readTurnReportedCosts: (ownerUserId, turnIds) => turnReportedCosts(pool, ownerUserId, [...turnIds])
  }));
}
