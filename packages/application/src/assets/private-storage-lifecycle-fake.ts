import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DatabaseIssuedStorageLocator,
  DurableFilesystemJournalPort,
  DurableFilesystemOperationId,
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

type OperationState = "reserved" | "attached" | "finalized" | "cleanup_pending";

type OperationRecord = Readonly<{
  reservation: ReservedFilesystemOperation;
}> & { state: OperationState };

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

  const journal: DurableFilesystemJournalPort = {
    async reserve(scope, request) {
      const reservation = {
        ...scope,
        operationId: `operation-${++operationSequence}`,
        purpose: request.purpose,
        expiresAt: request.expiresAt
      } as ReservedFilesystemOperation;
      operationById.set(reservation.operationId, { reservation, state: "reserved" });
      observedEvents.push("reserved");
      return reservation;
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
      return { outcome: "attached", operation: attached, locator };
    },
    async finalizeAfterCommit(operation) {
      const record = operationById.get(operation.operationId);
      if (!record) return { outcome: "stale" };
      if (record.state === "finalized") return { outcome: "already_finalized" };
      if (record.state !== "attached") return { outcome: "stale" };
      record.state = "finalized";
      observedEvents.push("finalized");
      return { outcome: "finalized" };
    },
    async markCleanup(operation) {
      const record = operationById.get(operation.operationId);
      if (!record || record.state === "finalized") return { outcome: "stale" };
      if (record.state === "cleanup_pending") return { outcome: "cleanup_pending" };
      record.state = "cleanup_pending";
      observedEvents.push("cleanup_pending");
      return { outcome: "cleanup_pending" };
    },
    async recover(request) {
      const records: DurableFilesystemRecoveryRecord[] = [];
      for (const operation of operationById.values()) {
        if (operation.state === "finalized" || records.length >= request.limit) continue;
        if (operation.state === "attached") {
          const attached = {
            ...(operation.reservation.resourceKind === "asset"
              ? { resourceKind: "asset" as const, ownerUserId: operation.reservation.ownerUserId, assetId: operation.reservation.assetId }
              : { resourceKind: "portable" as const, ownerUserId: operation.reservation.ownerUserId, operationScopeId: operation.reservation.operationScopeId }),
            operationId: operation.reservation.operationId,
            purpose: operation.reservation.purpose
          } as AttachedFilesystemOperation;
          records.push({ action: "finalize", operation: attached });
        } else {
          records.push({ action: "cleanup", operation: operation.reservation });
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
