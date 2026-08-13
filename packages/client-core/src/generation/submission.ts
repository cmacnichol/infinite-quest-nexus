import type { GenerationEnqueueResponse } from "@infinite-quest/contracts";
import type { Clock, PendingSubmissionStore } from "../ports.js";
import type { GenerationApiPort, GenerationSubmissionInput, StoredGenerationSubmission } from "./types.js";

const PENDING_SUBMISSION_TTL_MS = 15 * 60 * 1_000;

export interface GenerationSubmissionCoordinator {
  submit(campaignId: string, input: GenerationSubmissionInput): Promise<GenerationEnqueueResponse>;
  replay(campaignId: string, submission: StoredGenerationSubmission): Promise<GenerationEnqueueResponse>;
  load(campaignId: string): StoredGenerationSubmission | null;
}

interface GenerationSubmissionCoordinatorDependencies {
  api: Pick<GenerationApiPort, "enqueue" | "enqueueReplacement">;
  clock: Clock;
  store: PendingSubmissionStore;
}

export function createGenerationSubmissionCoordinator(
  dependencies: GenerationSubmissionCoordinatorDependencies
): GenerationSubmissionCoordinator {
  return {
    async submit(campaignId, input) {
      const createdAt = dependencies.clock.now();
      const submission: StoredGenerationSubmission = input.operationKind === "append"
        ? { ...input, createdAt }
        : {
            operationKind: "replace_latest",
            request: input.request,
            expectedTurnNumber: input.request.expectedCurrentTurnNumber,
            createdAt
          };
      return enqueue(campaignId, submission, dependencies);
    },
    async replay(campaignId, submission) {
      return enqueue(campaignId, submission, dependencies);
    },
    load(campaignId) {
      const submission = dependencies.store.load(campaignId);
      if (!submission) return null;
      if (dependencies.clock.now() - submission.createdAt >= PENDING_SUBMISSION_TTL_MS) {
        dependencies.store.clear(campaignId);
        return null;
      }
      return submission;
    }
  };
}

async function enqueue(
  campaignId: string,
  submission: StoredGenerationSubmission,
  dependencies: GenerationSubmissionCoordinatorDependencies
): Promise<GenerationEnqueueResponse> {
  dependencies.store.save(campaignId, submission);
  const response = submission.operationKind === "append"
    ? await dependencies.api.enqueue(campaignId, submission.request)
    : await dependencies.api.enqueueReplacement(campaignId, submission.request);
  const acknowledged: StoredGenerationSubmission = submission.operationKind === "append"
    ? { ...submission, jobId: response.id }
    : response.operationKind === "replace_latest"
      ? { ...submission, jobId: response.id, replacementTurnId: response.replacementTurnId }
      : (() => { throw new Error("Generation enqueue operation mismatch."); })();
  dependencies.store.save(campaignId, acknowledged);
  return response;
}
