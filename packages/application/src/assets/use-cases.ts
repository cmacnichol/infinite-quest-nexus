import type { AssetApplication, AssetApplicationDependencies } from "./ports.js";
import type {
  AssetMetadataBackfillClaim,
  AssetMetadataBackfillClaimRequest,
  AssetMetadataBackfillHeartbeatRequest,
  AssetMetadataUpdateCommand,
  AssetScope,
  AssetTransactionContext,
  TurnAssetSelectionScope,
  WorldAssetSelectionScope
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

function requireLease(claim: AssetMetadataBackfillClaim): void {
  requireAsset(claim);
  if (!nonBlank(claim.leaseId)
    || !nonBlank(claim.leaseOwner)
    || !Number.isInteger(claim.workVersion)
    || claim.workVersion <= 0
    || !nonBlank(claim.leaseExpiresAt)
    || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) {
    throw new AssetApplicationError("worker_scope_required");
  }
}

function requireHeartbeat(request: AssetMetadataBackfillHeartbeatRequest): void {
  if (!Number.isInteger(request.leaseSeconds) || request.leaseSeconds <= 0) {
    throw new AssetApplicationError("worker_scope_required");
  }
}

function requireMetadataUpdate(command: AssetMetadataUpdateCommand): void {
  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision <= 0 || !nonBlank(command.idempotencyKey)) {
    throw new AssetApplicationError("asset_scope_required");
  }
  const { expectedRevision: _expectedRevision, idempotencyKey: _idempotencyKey, ...changes } = command;
  if (Object.keys(changes).length === 0) throw new AssetApplicationError("asset_scope_required");
}

function requireSelectionAsset(command: Readonly<{ assetId?: string | null }>): void {
  if (!("assetId" in command) || (command.assetId !== null && !nonBlank(command.assetId))) {
    throw new AssetApplicationError("asset_scope_required");
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
    selectTurnIllustration: async (scope: TurnAssetSelectionScope, command) => {
      requireOwner(scope);
      if (!nonBlank(scope.campaignId) || !nonBlank(scope.turnId) || !nonBlank(command.idempotencyKey)) {
        throw new AssetApplicationError("asset_scope_required");
      }
      requireSelectionAsset(command);
      return dependencies.selection.selectTurnIllustration(scope, command);
    },
    selectWorldCover: async (scope: WorldAssetSelectionScope, command) => {
      requireOwner(scope);
      if (!nonBlank(scope.worldId) || !nonBlank(command.idempotencyKey)) {
        throw new AssetApplicationError("asset_scope_required");
      }
      requireSelectionAsset(command);
      return dependencies.selection.selectWorldCover(scope, command);
    },
    updateAssetMetadata: async (scope, command) => {
      requireAsset(scope);
      requireMetadataUpdate(command);
      return dependencies.metadata.updateAssetMetadata(scope, command);
    },
    describeAssetDelivery: async (scope, request) => {
      requireAsset(scope);
      if (request.kind === "derivative" && request.derivativeKind !== "thumbnail") {
        throw new AssetApplicationError("asset_scope_required");
      }
      return dependencies.delivery.describeAssetDelivery(scope, request);
    },
    claimNextMetadataBackfill: async (request) => {
      requireWorker(request);
      return dependencies.metadata.claimNextMetadataBackfill(request);
    },
    heartbeatMetadataBackfill: async (claim, request) => {
      requireLease(claim);
      requireHeartbeat(request);
      return dependencies.metadata.heartbeatMetadataBackfill(claim, request);
    },
    requeueMetadataBackfill: async (claim, request) => {
      requireLease(claim);
      return dependencies.metadata.requeueMetadataBackfill(claim, request);
    },
    backfillMetadata: async (database: AssetTransactionContext, claim: AssetMetadataBackfillClaim) => {
      requireLease(claim);
      return dependencies.metadata.backfillMetadata(database, claim);
    }
  };
}
