import type { GenerationMutationResult } from "../../../packages/application/src/index.js";

export type GenerationLifecycleLogContext = Readonly<{
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: "append" | "replace_latest";
  jobAttempt: number;
}>;

export type GenerationRouteLifecycleDependencies = Readonly<{
  readContext(ownerUserId: string, generationJobId: string): Promise<GenerationLifecycleLogContext | null>;
  logger: Readonly<{ info(fields: Record<string, unknown>): void }>;
}>;

export type GenerationRouteLifecycle = Readonly<{
  retry(ownerUserId: string, generationJobId: string, mutate: () => Promise<GenerationMutationResult>): Promise<GenerationMutationResult>;
  cancel(ownerUserId: string, generationJobId: string, mutate: () => Promise<GenerationMutationResult>): Promise<GenerationMutationResult>;
}>;

export function createGenerationRouteLifecycle({ readContext, logger }: GenerationRouteLifecycleDependencies): GenerationRouteLifecycle {
  return {
    retry: async (ownerUserId, generationJobId, mutate) => {
      const context = await readContext(ownerUserId, generationJobId);
      const result = await mutate();
      if (context) logger.info({ event: "turn_generation_requeued", ...context });
      return result;
    },
    cancel: async (ownerUserId, generationJobId, mutate) => {
      const context = await readContext(ownerUserId, generationJobId);
      const result = await mutate();
      if (context) {
        logger.info({
          event: "turn_generation_cancelled",
          generationJobId: context.generationJobId,
          campaignId: context.campaignId,
          operationKind: context.operationKind
        });
      }
      return result;
    }
  };
}
