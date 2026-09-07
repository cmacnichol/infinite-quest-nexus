import type {
  AuthoringApply,
  AuthoringFailure,
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
  claim(workerId: string, leaseSeconds: number): Promise<AuthoringClaim | null>;
  heartbeat(claim: AuthoringClaim, leaseSeconds: number): Promise<boolean>;
  checkpoint(claim: AuthoringClaim, output: unknown): Promise<boolean>;
  fail(claim: AuthoringClaim, failure: AuthoringFailure): Promise<boolean>;
  review(scope: OwnerScope, jobId: string, input: AuthoringReview): Promise<AuthoringJobView>;
  retry(scope: OwnerScope, jobId: string, stageId: string, expectedRevision: number): Promise<AuthoringJobView>;
  cancel(scope: OwnerScope, jobId: string, expectedRevision: number): Promise<AuthoringJobView>;
  discard(scope: OwnerScope, jobId: string, expectedRevision: number): Promise<void>;
}

/** Read/check port used before durable enqueue; it carries no publishing or campaign capability. */
export interface AuthoringTargetPort {
  assertCurrent(scope: OwnerScope, target: AuthoringWorldDraftTarget): Promise<void>;
}

export interface AuthoringApplicationDependencies {
  repository: AuthoringRepository;
  targets: AuthoringTargetPort;
  sha256: (value: string) => string;
}

/** Execution-only data is never part of the HTTP-facing repository projection. */
export interface AuthoringExecutionRepository extends AuthoringRepository {
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
  } | null>;
}
