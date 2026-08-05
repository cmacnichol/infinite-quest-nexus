import type { AssetApplication, AssetApplicationDependencies } from "./ports.js";
import type {
  AssetMetadataBackfillClaim,
  AssetMetadataBackfillClaimRequest,
  AssetScope,
  AssetTransactionContext,
  TurnAssetScope,
  WorldAssetScope
} from "./types.js";
import type { AssetOwnerScope } from "./types.js";

export class AssetApplicationError extends Error {
  constructor(readonly code: "owner_scope_required" | "asset_scope_required" | "worker_scope_required") {
    super(code);
    this.name = "AssetApplicationError";
  }
}

function nonBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function requireOwner(scope: AssetOwnerScope): void {
  if (!nonBlank(scope.ownerUserId)) throw new AssetApplicationError("owner_scope_required");
}

function requireAsset(scope: AssetScope): void {
  requireOwner(scope);
  if (!nonBlank(scope.assetId)) throw new AssetApplicationError("asset_scope_required");
}

function requireWorker(request: AssetMetadataBackfillClaimRequest): void {
  if (!nonBlank(request.workerId) || request.leaseSeconds <= 0) {
    throw new AssetApplicationError("worker_scope_required");
  }
}

/** Pure delegation boundary: transactions, storage, and image decoding stay in later adapters. */
export function createAssetApplication(dependencies: AssetApplicationDependencies): AssetApplication {
  return {
    listAssets: async (scope, query) => {
      requireOwner(scope);
      return dependencies.library.listAssets(scope, query);
    },
    readAsset: async (scope) => {
      requireAsset(scope);
      return dependencies.library.readAsset(scope);
    },
    selectTurnIllustration: async (scope: TurnAssetScope, command) => {
      requireAsset(scope);
      if (!nonBlank(scope.campaignId) || !nonBlank(scope.turnId) || !nonBlank(command.idempotencyKey)) {
        throw new AssetApplicationError("asset_scope_required");
      }
      return dependencies.selection.selectTurnIllustration(scope, command);
    },
    selectWorldCover: async (scope: WorldAssetScope, command) => {
      requireAsset(scope);
      if (!nonBlank(scope.worldId) || !nonBlank(command.idempotencyKey)) {
        throw new AssetApplicationError("asset_scope_required");
      }
      return dependencies.selection.selectWorldCover(scope, command);
    },
    claimNextMetadataBackfill: async (request) => {
      requireWorker(request);
      return dependencies.metadata.claimNextMetadataBackfill(request);
    },
    backfillMetadata: async (database: AssetTransactionContext, claim: AssetMetadataBackfillClaim) => {
      requireAsset(claim);
      if (!nonBlank(claim.leaseId)) throw new AssetApplicationError("worker_scope_required");
      return dependencies.metadata.backfillMetadata(database, claim);
    }
  };
}
