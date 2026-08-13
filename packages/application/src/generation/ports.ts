import type {
  GenerationRequest,
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
  GenerationMutationResult
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
  retry(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  cancel(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  discard(scope: GenerationJobScope): Promise<GenerationMutationResult>;
}

export interface GenerationWorkerApplication {
  claimNext(request: GenerationClaimRequest): Promise<ClaimedGeneration | null>;
  executeClaimed(request: GenerationExecutionRequest): Promise<boolean>;
}
