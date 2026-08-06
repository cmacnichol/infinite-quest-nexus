import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DatabaseIssuedStorageLocator,
  DurableFilesystemJournalPort,
  DurableFilesystemOperationId,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemScope,
  PrivateStorageLocatorRedemptionPort,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "./private-storage-lifecycle.js";

export interface FakePublicationCandidateIssuer {
  issuePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    descriptor: PrivateStorageDescriptor,
  ): AssetPublicationCandidate;
}

export type FakeDurableFilesystemLifecycle = FakePublicationCandidateIssuer & PrivateStorageLocatorRedemptionPort & Readonly<{
  journal: DurableFilesystemJournalPort;
  events(): readonly string[];
}>;

type OperationState = "reserved" | "attached" | "finalized" | "cleanup_pending" | "cleaned";

type OperationRecord = Readonly<{
  reservation: ReservedFilesystemOperation;
}> & {
  state: OperationState;
  workVersion: number;
  activeClaim: DurableFilesystemRecoveryClaim;
};

/** Pure test fake for the private durable publication protocol. */
export function createFakeDurableFilesystemLifecycle(): FakeDurableFilesystemLifecycle {
  const operationById = new Map<DurableFilesystemOperationId, OperationRecord>();
  const candidateByToken = new Map<AssetPublicationCandidate, Readonly<{
    operationId: DurableFilesystemOperationId;
    descriptor: PrivateStorageDescriptor;
  }>>();
  const locatorByToken = new Map<DatabaseIssuedStorageLocator, Readonly<{
    scope: DurableFilesystemScope;
    descriptor: PrivateStorageDescriptor;
  }>>();
  const observedEvents: string[] = [];
  let operationSequence = 0;
  let candidateSequence = 0;
  let locatorSequence = 0;
  let leaseSequence = 0;

  function issueClaim(
    operationId: DurableFilesystemOperationId,
    leaseOwner: string,
    workVersion: number,
    leaseExpiresAt: string,
  ): DurableFilesystemRecoveryClaim {
    return {
      operationId,
      leaseId: `filesystem-lease-${++leaseSequence}`,
      leaseOwner,
      workVersion,
      leaseExpiresAt
    } as DurableFilesystemRecoveryClaim;
  }

  function operationMatches(
    record: OperationRecord,
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
  ): boolean {
    const reserved = record.reservation;
    return reserved.operationId === operation.operationId
      && reserved.ownerUserId === operation.ownerUserId
      && reserved.resourceKind === operation.resourceKind
      && reserved.purpose === operation.purpose
      && (reserved.resourceKind !== "asset" || operation.resourceKind !== "asset" || reserved.assetId === operation.assetId)
      && (reserved.resourceKind !== "portable" || operation.resourceKind !== "portable" || reserved.operationScopeId === operation.operationScopeId);
  }

  function claimOutcome(
    record: OperationRecord | undefined,
    operation: ReservedFilesystemOperation | AttachedFilesystemOperation,
    claim: DurableFilesystemRecoveryClaim,
  ): "valid" | "stale" | "lease_lost" {
    if (!record || !operationMatches(record, operation)) return "stale";
    const active = record.activeClaim;
    if (active.operationId !== claim.operationId
      || active.leaseId !== claim.leaseId
      || active.leaseOwner !== claim.leaseOwner
      || active.workVersion !== claim.workVersion
      || active.leaseExpiresAt !== claim.leaseExpiresAt
      || Date.parse(claim.leaseExpiresAt) <= Date.now()) return "lease_lost";
    return "valid";
  }

  const journal: DurableFilesystemJournalPort = {
    async reserve(scope, request) {
      const reservation = {
        ...scope,
        operationId: `operation-${++operationSequence}`,
        purpose: request.purpose,
        expiresAt: request.expiresAt
      } as ReservedFilesystemOperation;
      const claim = issueClaim(reservation.operationId, request.leaseOwner, 1, request.expiresAt);
      operationById.set(reservation.operationId, { reservation, state: "reserved", workVersion: 1, activeClaim: claim });
      observedEvents.push("reserved");
      return { operation: reservation, claim };
    },
    async attach(_database, reservation, candidate) {
      const operation = operationById.get(reservation.operationId);
      const publication = candidateByToken.get(candidate);
      if (!operation || operation.state !== "reserved") return { outcome: "stale" };
      if (!publication || publication.operationId !== reservation.operationId) {
        return { outcome: "candidate_mismatch" };
      }
      operation.state = "attached";
      const locator = `locator-${++locatorSequence}` as DatabaseIssuedStorageLocator;
      const scope: DurableFilesystemScope = reservation.resourceKind === "asset"
        ? { resourceKind: "asset", ownerUserId: reservation.ownerUserId, assetId: reservation.assetId }
        : { resourceKind: "portable", ownerUserId: reservation.ownerUserId, operationScopeId: reservation.operationScopeId };
      locatorByToken.set(locator, {
        scope,
        descriptor: publication.descriptor
      });
      const attached = {
        ...scope,
        operationId: reservation.operationId,
        purpose: reservation.purpose
      } as AttachedFilesystemOperation;
      observedEvents.push("attached");
      return { outcome: "attached", operation: attached, locator, claim: operation.activeClaim };
    },
    async finalizeAfterCommit(operation, claim) {
      const record = operationById.get(operation.operationId);
      const claimStatus = claimOutcome(record, operation, claim);
      if (claimStatus !== "valid") return { outcome: claimStatus };
      if (!record) return { outcome: "stale" };
      if (record.state === "finalized") return { outcome: "already_finalized" };
      if (record.state !== "attached") return { outcome: "stale" };
      record.state = "finalized";
      observedEvents.push("finalized");
      return { outcome: "finalized" };
    },
    async markCleanup(operation, claim) {
      const record = operationById.get(operation.operationId);
      const claimStatus = claimOutcome(record, operation, claim);
      if (claimStatus !== "valid") return { outcome: claimStatus };
      if (!record || record.state === "finalized") return { outcome: "stale" };
      if (record.state === "cleaned") return { outcome: "already_cleaned" };
      if (record.state === "cleanup_pending") return { outcome: "cleanup_pending" };
      record.state = "cleanup_pending";
      observedEvents.push("cleanup_pending");
      return { outcome: "cleanup_pending" };
    },
    async completeCleanup(operation, claim) {
      const record = operationById.get(operation.operationId);
      const claimStatus = claimOutcome(record, operation, claim);
      if (claimStatus !== "valid") return { outcome: claimStatus };
      if (!record) return { outcome: "stale" };
      if (record.state === "cleaned") return { outcome: "already_cleaned" };
      if (record.state !== "cleanup_pending") return { outcome: "stale" };
      record.state = "cleaned";
      observedEvents.push("cleaned");
      return { outcome: "cleaned" };
    },
    async recover(request) {
      const records: DurableFilesystemRecoveryRecord[] = [];
      for (const operation of operationById.values()) {
        if (operation.state === "finalized" || operation.state === "cleaned" || records.length >= request.limit) continue;
        operation.workVersion += 1;
        operation.activeClaim = issueClaim(
          operation.reservation.operationId,
          request.leaseOwner,
          operation.workVersion,
          new Date(Date.now() + request.leaseSeconds * 1_000).toISOString(),
        );
        if (operation.state === "attached") {
          const attached = {
            ...(operation.reservation.resourceKind === "asset"
              ? { resourceKind: "asset" as const, ownerUserId: operation.reservation.ownerUserId, assetId: operation.reservation.assetId }
              : { resourceKind: "portable" as const, ownerUserId: operation.reservation.ownerUserId, operationScopeId: operation.reservation.operationScopeId }),
            operationId: operation.reservation.operationId,
            purpose: operation.reservation.purpose
          } as AttachedFilesystemOperation;
          records.push({ action: "finalize", operation: attached, claim: operation.activeClaim });
        } else {
          records.push({ action: "cleanup", operation: operation.reservation, claim: operation.activeClaim });
        }
      }
      observedEvents.push("recovered");
      return records;
    }
  };

  return {
    journal,
    issuePublicationCandidate(reservation, descriptor) {
      const operation = operationById.get(reservation.operationId);
      if (!operation || operation.state !== "reserved") throw new Error("filesystem_operation_not_reserved");
      const candidate = `candidate-${++candidateSequence}` as AssetPublicationCandidate;
      candidateByToken.set(candidate, { operationId: reservation.operationId, descriptor });
      observedEvents.push("candidate_issued");
      return candidate;
    },
    async redeemStorageLocator(scope, locator) {
      const record = locatorByToken.get(locator);
      if (!record
        || record.scope.ownerUserId !== scope.ownerUserId
        || record.scope.resourceKind !== scope.resourceKind
        || (record.scope.resourceKind === "asset" && scope.resourceKind === "asset" && record.scope.assetId !== scope.assetId)
        || (record.scope.resourceKind === "portable" && scope.resourceKind === "portable" && record.scope.operationScopeId !== scope.operationScopeId)) return null;
      return record.descriptor;
    },
    events() {
      return [...observedEvents];
    }
  };
}
