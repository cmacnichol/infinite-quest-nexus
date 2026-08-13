import type {
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationJobStatus
} from "@infinite-quest/contracts";

export type EnqueueGenerationResult = GenerationEnqueueResponse;
export type GenerationJob = GenerationJobStatus;
export type GenerationMutationResult = GenerationActionResponse;

export type OwnerScope = Readonly<{
  ownerUserId: string;
}>;

export type CampaignGenerationScope = OwnerScope & Readonly<{
  campaignId: string;
}>;

export type GenerationJobScope = OwnerScope & Readonly<{
  jobId: string;
}>;

export type GenerationClaimRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;

type ClaimedGenerationBase = {
  jobId: string;
  ownerUserId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  attempts: number;
};

export type ClaimedGeneration =
  | Readonly<ClaimedGenerationBase & {
      operationKind: "append";
      replacementTurnId: null;
    }>
  | Readonly<ClaimedGenerationBase & {
      operationKind: "replace_latest";
      replacementTurnId: string;
    }>;

export type GenerationExecutionRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
  claim: ClaimedGeneration;
}>;
