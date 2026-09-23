import type { CastScope, CastBoundary, CastSnapshot, CastBatch, CastBatchReceipt } from "./types.js";

export interface CampaignCastReadPort {
  loadSnapshot(scope: CastScope, boundary: CastBoundary): Promise<CastSnapshot>;
}

/** Internal foundation port. Callers must not expose writes before phase 02 gates. */
export interface CampaignCastRepositoryPort extends CampaignCastReadPort {
  initialize(scope: CastScope): Promise<CastSnapshot>;
  applyBatch(scope: CastScope, batch: CastBatch): Promise<CastBatchReceipt>;
  rebuild(scope: CastScope): Promise<CastSnapshot>;
}
