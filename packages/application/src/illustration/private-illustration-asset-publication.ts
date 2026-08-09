import type {
  IllustrationImageArtifact,
  IllustrationImageExecutionResult
} from "./types.js";

export type PrivateCompletedIllustrationImageExecutionResult = Extract<
  IllustrationImageExecutionResult,
  Readonly<{ status: "completed" }>
>;

/** Claimed-job identity is the only ingress authority; ownership is reloaded from PostgreSQL. */
export type PrivateIllustrationCompletionCommand = Readonly<{
  imageJobId: string;
  workerId: string;
  result: PrivateCompletedIllustrationImageExecutionResult;
}>;

export type PrivateIllustrationFinalizationRecoveryCommand = Readonly<{
  imageJobId: string;
  workerId: string;
  leaseSeconds: number;
}>;

export type PrivatePublishedIllustrationAsset = Readonly<{
  variantIndex: number;
  assetId: string;
  contentHash: string;
}>;

export type PrivateIllustrationPublishedOutcome = Readonly<{
  outcome: "published";
  assets: readonly PrivatePublishedIllustrationAsset[];
}>;

export type PrivateIllustrationFinalizationPendingOutcome = Readonly<{
  outcome: "committed_finalization_pending";
  diagnostic: "asset_publication_finalization_recoverable";
}>;

export type PrivateIllustrationCompletionOutcome =
  | Readonly<{ outcome: "noop" }>
  | PrivateIllustrationPublishedOutcome
  | PrivateIllustrationFinalizationPendingOutcome;

export type PrivateIllustrationFinalizationRecoveryOutcome =
  | PrivateIllustrationPublishedOutcome
  | PrivateIllustrationFinalizationPendingOutcome;

/** Private downloader seam; the coordinator supplies only database-derived ownership. */
export interface PrivateIllustrationArtifactDownloadPort {
  downloadArtifact(input: Readonly<{
    ownerUserId: string;
    imageJobId: string;
    artifact: IllustrationImageArtifact;
    timeoutMs: number;
    allowPrivateHosts: boolean;
    maximumBytes: number;
  }>): Promise<Readonly<{
    bytes: Uint8Array;
    mimeType: string;
  }>>;
}

/**
 * Additive replacement seam. It is deliberately not exported by the public
 * illustration barrel and is not bound into the live worker in Task 14e3e3.
 */
export interface PrivateIllustrationAssetPublicationCoordinator {
  completeClaimedImageJob(
    command: PrivateIllustrationCompletionCommand,
  ): Promise<PrivateIllustrationCompletionOutcome>;
  recoverFinalization(
    command: PrivateIllustrationFinalizationRecoveryCommand,
  ): Promise<PrivateIllustrationFinalizationRecoveryOutcome>;
}
