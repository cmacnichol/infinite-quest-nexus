import { authoringFailureSchema, type AuthoringStageOutput } from "@infinite-quest/contracts";
import type { AuthoringClaim, AuthoringExecutionRepository } from "./ports.js";

export interface AuthoringWorkerApplication {
  runNext(input: { workerId: string; leaseSeconds: number }): Promise<boolean>;
  cleanup(): Promise<number>;
}

export type AuthoringStageExecutor = (claim: AuthoringClaim, input: { workerId: string; leaseSeconds: number }) => Promise<AuthoringStageOutput | null>;

function executionFailure(error: unknown) {
  const candidate = typeof error === "object" && error !== null && "authoringFailure" in error
    ? (error as { authoringFailure: unknown }).authoringFailure
    : undefined;
  return authoringFailureSchema.safeParse(candidate).data;
}

/**
 * Provider-free durable worker orchestration. Runtime owns provider selection,
 * prompting, credential loading, and lease-heartbeat cancellation around the
 * executor passed here.
 */
export function createAuthoringWorkerApplication(options: Readonly<{
  repository: Pick<AuthoringExecutionRepository, "claim" | "checkpoint" | "fail" | "cleanupAuthoring">;
  execute: AuthoringStageExecutor;
}>): AuthoringWorkerApplication {
  return {
    async runNext({ workerId, leaseSeconds }) {
      const claim = await options.repository.claim(workerId, leaseSeconds);
      if (!claim) return false;
      try {
        const output = await options.execute(claim, { workerId, leaseSeconds });
        return output === null ? false : await options.repository.checkpoint(claim, output);
      } catch (error) {
        const failure = executionFailure(error);
        if (!failure) throw error;
        await options.repository.fail(claim, failure);
        return false;
      }
    },
    cleanup: () => options.repository.cleanupAuthoring({ batchSize: 100 })
  };
}
