import type {
  AuthoringApply,
  AuthoringFailure,
  AuthoringKind,
  AuthoringJobListItem,
  AuthoringJobView,
  AuthoringReview,
  AuthoringSubmit
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";
import type {
  AuthoringExecutionSnapshot,
  AuthoringStageOutput,
  AuthoringWorldDraftTarget
} from "./types.js";
import type { AuthoringApplyReceipt, AuthoringTarget } from "@infinite-quest/contracts";
import type { PlayableCharacter, WorldContent } from "@infinite-quest/contracts";
import type { SourceCharacterIdentityGroup, SourceDocument, SourceFact, SourceFactReview } from "@infinite-quest/contracts";

/** Opaque transaction binding owned by the persistence adapter. */
export interface AuthoringTransaction {
  readonly __authoringTransaction?: never;
}

export interface AuthoringWorldApplyPort {
  applyInTransaction(
    transaction: AuthoringTransaction,
    scope: OwnerScope,
    target: AuthoringTarget,
    content: WorldContent | PlayableCharacter
  ): Promise<{ worldId: string; draftRevision: number; characterId?: string }>;
}

export type AuthoringClaim = Readonly<{
  jobId: string;
  stageId: string;
  ownerUserId: string;
  jobGeneration: number;
  stageGeneration: number;
  leaseToken: string;
  leaseExpiresAt: string;
}>;

export interface AuthoringRepository {
  findIdempotency(scope: OwnerScope, idempotencyKey: string): Promise<{ requestHash: string; job: AuthoringJobView | null } | null>;
  submit(scope: OwnerScope, input: AuthoringSubmit, hash: string): Promise<AuthoringJobView>;
  read(scope: OwnerScope, jobId: string): Promise<AuthoringJobView | null>;
  list(scope: OwnerScope, cursor?: string): Promise<{ jobs: AuthoringJobListItem[]; nextCursor?: string }>;
  claim(workerId: string, leaseSeconds: number, allowedKinds?: readonly AuthoringKind[]): Promise<AuthoringClaim | null>;
  heartbeat(claim: AuthoringClaim, leaseSeconds: number): Promise<boolean>;
  checkpoint(claim: AuthoringClaim, output: unknown): Promise<boolean>;
  fail(claim: AuthoringClaim, failure: AuthoringFailure): Promise<boolean>;
  review(scope: OwnerScope, jobId: string, input: AuthoringReview): Promise<AuthoringJobView>;
  reviewSourceFacts?(scope: OwnerScope, jobId: string, review: SourceFactReview): Promise<AuthoringJobView>;
  startSourceSynthesis?(scope: OwnerScope, jobId: string, expectedRevision: number): Promise<AuthoringJobView>;
  retry(scope: OwnerScope, jobId: string, stageId: string, expectedRevision: number): Promise<AuthoringJobView>;
  cancel(scope: OwnerScope, jobId: string, expectedRevision: number): Promise<AuthoringJobView>;
  discard(scope: OwnerScope, jobId: string, expectedRevision: number): Promise<void>;
  apply(
    scope: OwnerScope,
    jobId: string,
    input: AuthoringApply,
    requestHash: string,
    worlds: AuthoringWorldApplyPort
  ): Promise<AuthoringApplyReceipt>;
}

/** Read/check port used before durable enqueue; it carries no publishing or campaign capability. */
export interface AuthoringTargetPort {
  assertCurrent(scope: OwnerScope, target: AuthoringWorldDraftTarget): Promise<void>;
}

export interface AuthoringApplicationDependencies {
  repository: AuthoringRepository;
  targets: AuthoringTargetPort;
  worlds: AuthoringWorldApplyPort;
  sha256: (value: string) => string;
}

/** Execution-only data is never part of the HTTP-facing repository projection. */
export interface AuthoringExecutionRepository extends AuthoringRepository {
  cleanupAuthoring(input: { batchSize: number; now?: Date }): Promise<number>;
  readClaimInput(claim: AuthoringClaim): Promise<AuthoringSubmit | null>;
  initializeExecutionSnapshot(
    claim: AuthoringClaim,
    snapshot: AuthoringExecutionSnapshot
  ): Promise<AuthoringExecutionSnapshot | null>;
  loadClaim(claim: AuthoringClaim): Promise<{
    input: AuthoringSubmit;
    snapshot: AuthoringExecutionSnapshot;
    stageKey: string;
    parentOutputs: AuthoringStageOutput[];
    /** Mutable source-plan leaf projection; immutable parent output remains retained for lineage. */
    sourcePlan?: unknown;
    /** Exact source review projection bound to a source synthesis/character stage. */
    sourceSelection?: Readonly<{
      source: SourceDocument;
      boundaryParagraphId: string;
      acceptedFacts: SourceFact[];
      selectedCharacterFactIds: string[];
      characterIdentityGroups: SourceCharacterIdentityGroup[];
      mode: "faithful" | "expand";
      reviewGeneration: number;
    }>;
  } | null>;
  /** Replaces one current source leaf with two fenced child leaves after output truncation. */
  splitSourceChunk?(claim: AuthoringClaim, chunkId: string): Promise<boolean>;
}
