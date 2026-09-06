import type {
  AuthoringFailure,
  AuthoringJobListItem,
  AuthoringJobView,
  AuthoringSubmit
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";
import type { AuthoringExecutionSnapshot, AuthoringStageOutput } from "./types.js";

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
  submit(scope: OwnerScope, input: AuthoringSubmit, hash: string): Promise<AuthoringJobView>;
  read(scope: OwnerScope, jobId: string): Promise<AuthoringJobView | null>;
  list(scope: OwnerScope, cursor?: string): Promise<{ jobs: AuthoringJobListItem[]; nextCursor?: string }>;
  claim(workerId: string, leaseSeconds: number): Promise<AuthoringClaim | null>;
  heartbeat(claim: AuthoringClaim, leaseSeconds: number): Promise<boolean>;
  checkpoint(claim: AuthoringClaim, output: unknown): Promise<boolean>;
  fail(claim: AuthoringClaim, failure: AuthoringFailure): Promise<boolean>;
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
