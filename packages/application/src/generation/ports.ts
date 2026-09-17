import type {
  GenerationRequest,
  GenerationReviewDecisionRequest,
  GenerationReviewDetail,
  GenerationResult,
  GenerationRetryLatestRequest
} from "@infinite-quest/contracts";
import type {
  CampaignGenerationScope,
  ClaimedGeneration,
  EnqueueGenerationResult,
  GenerationClaimRequest,
  GenerationExecutionRequest,
  GenerationJob,
  GenerationJobScope,
  GenerationMutationResult,
  GenerationReviewDecisionResult
} from "./types.js";

export interface GenerationCommandRepository {
  enqueueAppend(
    scope: CampaignGenerationScope,
    request: GenerationRequest,
  ): Promise<EnqueueGenerationResult>;
  enqueueReplacement(
    scope: CampaignGenerationScope,
    request: GenerationRetryLatestRequest,
  ): Promise<EnqueueGenerationResult>;
  getJob(scope: GenerationJobScope): Promise<GenerationJob>;
  getResult(scope: GenerationJobScope): Promise<GenerationResult>;
  getReview(scope: GenerationJobScope): Promise<GenerationReviewDetail>;
  decideReview(scope: GenerationJobScope, request: GenerationReviewDecisionRequest): Promise<GenerationReviewDecisionResult>;
  retry(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  cancel(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  discard(scope: GenerationJobScope): Promise<GenerationMutationResult>;
}

export interface GenerationClaimRepository {
  claimNext(request: GenerationClaimRequest): Promise<ClaimedGeneration | null>;
}

export interface GenerationExecutor {
  execute(request: GenerationExecutionRequest): Promise<boolean>;
}

export interface GenerationApplication {
  enqueueAppend(
    scope: CampaignGenerationScope,
    request: GenerationRequest,
  ): Promise<EnqueueGenerationResult>;
  enqueueReplacement(
    scope: CampaignGenerationScope,
    request: GenerationRetryLatestRequest,
  ): Promise<EnqueueGenerationResult>;
  getJob(scope: GenerationJobScope): Promise<GenerationJob>;
  getResult(scope: GenerationJobScope): Promise<GenerationResult>;
  getReview(scope: GenerationJobScope): Promise<GenerationReviewDetail>;
  decideReview(scope: GenerationJobScope, request: GenerationReviewDecisionRequest): Promise<GenerationReviewDecisionResult>;
  retry(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  cancel(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  discard(scope: GenerationJobScope): Promise<GenerationMutationResult>;
}

export interface GenerationWorkerApplication {
  claimNext(request: GenerationClaimRequest): Promise<ClaimedGeneration | null>;
  executeClaimed(request: GenerationExecutionRequest): Promise<boolean>;
}
