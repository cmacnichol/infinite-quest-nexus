import type { CastScope, CastBoundary, CastSnapshot, CastBatch, CastBatchReceipt } from "./types.js";
import type { CreateCastCharacter, EditCastCharacter, CastWriteResult, CastDetail, CastDiscoveryStatus } from "@infinite-quest/contracts";

export interface CampaignCastWritePort {
  discoveryStatus(scope: CastScope): Promise<CastDiscoveryStatus>;
  create(scope: CastScope, request: CreateCastCharacter): Promise<CastWriteResult>;
  edit(scope: CastScope, id: string, request: EditCastCharacter): Promise<CastWriteResult>;
  current(scope: CastScope): Promise<CastSnapshot>;
  detail(scope: CastScope, id: string): Promise<CastDetail>;
}

export class CampaignCastError extends Error {
  constructor(readonly code: "cast_not_found" | "cast_revision_conflict" | "cast_generation_active"
    | "cast_idempotency_conflict" | "cast_invalid_request" | "cast_editing_disabled" | "cast_protagonist_read_only") {
    super(code.replaceAll("_", " "));
  }
}

export interface CampaignCastReadPort {
  loadSnapshot(scope: CastScope, boundary: CastBoundary): Promise<CastSnapshot>;
}

/** Internal foundation port. Callers must not expose writes before phase 02 gates. */
export interface CampaignCastRepositoryPort extends CampaignCastReadPort {
  initialize(scope: CastScope): Promise<CastSnapshot>;
  applyBatch(scope: CastScope, batch: CastBatch): Promise<CastBatchReceipt>;
  rebuild(scope: CastScope): Promise<CastSnapshot>;
}
