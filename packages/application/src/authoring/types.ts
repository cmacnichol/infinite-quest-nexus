export {
  authoringExecutionSnapshotSchema,
  authoringStageOutputSchema,
  authoringWorldOutlineSchema,
  type AuthoringExecutionSnapshot,
  type AuthoringStageOutput,
  type AuthoringWorldOutline
} from "@infinite-quest/contracts";

import type {
  AuthoringApply,
  AuthoringApplyReceipt,
  AuthoringJobListItem,
  AuthoringJobView,
  AuthoringReview,
  AuthoringSubmit,
  AuthoringTarget
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

export type AuthoringOwnerScope = OwnerScope;
export type AuthoringWorldDraftTarget = Extract<AuthoringTarget, { kind: "world_draft" }>;

export type AuthoringSha256 = (value: string) => string;

export interface AuthoringApplication {
  submit(scope: AuthoringOwnerScope, input: AuthoringSubmit): Promise<AuthoringJobView>;
  get(scope: AuthoringOwnerScope, id: string): Promise<AuthoringJobView | null>;
  list(scope: AuthoringOwnerScope, cursor?: string): Promise<{ jobs: AuthoringJobListItem[]; nextCursor?: string }>;
  review(scope: AuthoringOwnerScope, id: string, input: AuthoringReview): Promise<AuthoringJobView>;
  retry(scope: AuthoringOwnerScope, id: string, stageId: string, expectedRevision: number): Promise<AuthoringJobView>;
  cancel(scope: AuthoringOwnerScope, id: string, expectedRevision: number): Promise<AuthoringJobView>;
  discard(scope: AuthoringOwnerScope, id: string, expectedRevision: number): Promise<void>;
  apply(scope: AuthoringOwnerScope, id: string, input: AuthoringApply): Promise<AuthoringApplyReceipt>;
}

export type AuthoringApplicationErrorCode =
  | "authoring_owner_scope_required"
  | "authoring_not_found"
  | "authoring_revision_conflict"
  | "authoring_invalid_state"
  | "authoring_invalid_target"
  | "authoring_idempotency_conflict"
  | "authoring_apply_unavailable";

export class AuthoringApplicationError extends Error {
  constructor(readonly code: AuthoringApplicationErrorCode) {
    super(code);
    this.name = "AuthoringApplicationError";
  }
}

/** Typed adapter error. SQL adapters must not leak database-local error classes across this boundary. */
export class AuthoringRepositoryError extends Error {
  constructor(readonly code: "idempotency_conflict" | "revision_conflict" | "invalid_state" | "not_found") {
    super(code);
    this.name = "AuthoringRepositoryError";
  }
}
