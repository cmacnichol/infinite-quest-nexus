import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DatabaseIssuedStorageLocator,
  DurableFilesystemJournalPort,
  DurableFilesystemOperationId,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemScope,
  PrivateFilesystemCapabilityPersistencePort,
  PrivateStorageLocatorRedemptionPort,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "./private-storage-lifecycle.js";
import type {
  ImportOwnerScope,
  PortableArchiveExportRetrieval,
  PortableStagedInput
} from "../imports/types.js";
import {
  toPortableArchiveExportRetrieval,
  toPortableStagedInput
} from "../imports/types.js";

export interface FakePublicationCandidateIssuer {
  issuePublicationCandidate(
    reservation: ReservedFilesystemOperation,
    descriptor: PrivateStorageDescriptor,
  ): Promise<AssetPublicationCandidate>;
}

export type FakeDurableFilesystemLifecycle = FakePublicationCandidateIssuer
  & PrivateStorageLocatorRedemptionPort
  & PrivateFilesystemCapabilityPersistencePort
  & Readonly<{
  events(): readonly string[];
  persistedTokenHashes(): readonly string[];
}>;

type OperationState = "reserved" | "attached" | "finalized" | "cleanup_pending" | "cleaned";

type OperationRecord = Readonly<{
  reservation: ReservedFilesystemOperation;
}> & {
  state: OperationState;
  workVersion: number;
  activeClaim: DurableFilesystemRecoveryClaim;
  descriptor?: PrivateStorageDescriptor;
};

type PersistedCapabilityState = "ready" | "cleanup_pending" | "cleaned";

type PersistedCapabilityRecord = {
  ownerUserId: string;
  descriptor: PrivateStorageDescriptor;
  state: PersistedCapabilityState;
};

async function tokenHash(token: string): Promise<string> {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const bytes = [...token].map((value) => value.charCodeAt(0));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56; shift >= 32; shift -= 8) bytes.push(0);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((bitLength >>> shift) & 0xff);
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const byte = offset + index * 4;
      words[index] = ((bytes[byte]! << 24) | (bytes[byte + 1]! << 16) | (bytes[byte + 2]! << 8) | bytes[byte + 3]!) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + sigma1 + choice + constants[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

async function ownedCapability(
  records: ReadonlyMap<string, PersistedCapabilityRecord>,
  owner: ImportOwnerScope,
  token: string,
): Promise<PersistedCapabilityRecord | undefined> {
  const record = records.get(await tokenHash(token));
  return record?.ownerUserId === owner.ownerUserId ? record : undefined;
}

/** Pure test fake for the private durable publication protocol. */
export function createFakeDurableFilesystemLifecycle(): FakeDurableFilesystemLifecycle {
  const operationById = new Map<DurableFilesystemOperationId, OperationRecord>();
  const candidateByHash = new Map<string, Readonly<{
    operationId: DurableFilesystemOperationId;
    descriptor: PrivateStorageDescriptor;
  }>>();
  const locatorByHash = new Map<string, Readonly<{
    scope: DurableFilesystemScope;
    descriptor: PrivateStorageDescriptor;
  }>>();
  const stagedByHash = new Map<string, PersistedCapabilityRecord>();
  const exportByHash = new Map<string, PersistedCapabilityRecord>();
  const observedEvents: string[] = [];
  let operationSequence = 0;
  let leaseSequence = 0;
  let capabilitySequence = 0;

  function nextCapabilityToken(): string {
    capabilitySequence += 1;
    return `fake-capability-${capabilitySequence}-${operationSequence}-${leaseSequence}`;
  }

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
      const publication = candidateByHash.get(await tokenHash(candidate));
      if (!operation || operation.state !== "reserved") return { outcome: "stale" };
      if (!publication || publication.operationId !== reservation.operationId) {
        return { outcome: "candidate_mismatch" };
      }
      operation.state = "attached";
      operation.descriptor = publication.descriptor;
      const locator = nextCapabilityToken() as DatabaseIssuedStorageLocator;
      const scope: DurableFilesystemScope = reservation.resourceKind === "asset"
        ? { resourceKind: "asset", ownerUserId: reservation.ownerUserId, assetId: reservation.assetId }
        : { resourceKind: "portable", ownerUserId: reservation.ownerUserId, operationScopeId: reservation.operationScopeId };
      locatorByHash.set(await tokenHash(locator), {
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

  async function issueCapability<T extends string>(
    records: Map<string, PersistedCapabilityRecord>,
    owner: ImportOwnerScope,
    descriptor: PrivateStorageDescriptor,
    toHandle: (token: string) => T,
    event: string,
  ): Promise<T> {
    const token = nextCapabilityToken();
    records.set(await tokenHash(token), {
      ownerUserId: owner.ownerUserId,
      descriptor,
      state: "ready"
    });
    observedEvents.push(event);
    return toHandle(token);
  }

  async function beginCapabilityCleanup(
    records: Map<string, PersistedCapabilityRecord>,
    owner: ImportOwnerScope,
    token: string,
    event: string,
  ) {
    const record = await ownedCapability(records, owner, token);
    if (!record) return { outcome: "stale" as const };
    if (record.state === "cleaned") return { outcome: "already_cleaned" as const };
    if (record.state === "ready") {
      record.state = "cleanup_pending";
      observedEvents.push(event);
    }
    return { outcome: "cleanup_required" as const, descriptor: record.descriptor };
  }

  async function completeCapabilityCleanup(
    records: Map<string, PersistedCapabilityRecord>,
    owner: ImportOwnerScope,
    token: string,
    event: string,
  ) {
    const record = await ownedCapability(records, owner, token);
    if (!record) return { outcome: "stale" as const };
    if (record.state === "cleaned") return { outcome: "already_cleaned" as const };
    if (record.state !== "cleanup_pending") return { outcome: "stale" as const };
    record.state = "cleaned";
    observedEvents.push(event);
    return { outcome: "cleaned" as const };
  }

  return {
    journal,
    async issuePublicationCandidate(reservation, descriptor) {
      const operation = operationById.get(reservation.operationId);
      if (!operation || operation.state !== "reserved") throw new Error("filesystem_operation_not_reserved");
      const candidate = nextCapabilityToken() as AssetPublicationCandidate;
      candidateByHash.set(await tokenHash(candidate), { operationId: reservation.operationId, descriptor });
      operation.descriptor = descriptor;
      observedEvents.push("candidate_issued");
      return candidate;
    },
    async redeemStorageLocator(scope, locator) {
      const record = locatorByHash.get(await tokenHash(locator));
      if (!record
        || record.scope.ownerUserId !== scope.ownerUserId
        || record.scope.resourceKind !== scope.resourceKind
        || (record.scope.resourceKind === "asset" && scope.resourceKind === "asset" && record.scope.assetId !== scope.assetId)
        || (record.scope.resourceKind === "portable" && scope.resourceKind === "portable" && record.scope.operationScopeId !== scope.operationScopeId)) return null;
      return record.descriptor;
    },
    async issueStagedInput(owner, descriptor) {
      return issueCapability(stagedByHash, owner, descriptor, toPortableStagedInput, "staged_issued");
    },
    async redeemStagedInput(owner, stagedInput) {
      const record = await ownedCapability(stagedByHash, owner, stagedInput);
      return record?.state === "ready" ? record.descriptor : null;
    },
    async beginStagedCleanup(owner, stagedInput) {
      return beginCapabilityCleanup(stagedByHash, owner, stagedInput, "staged_cleanup_pending");
    },
    async completeStagedCleanup(owner, stagedInput) {
      return completeCapabilityCleanup(stagedByHash, owner, stagedInput, "staged_cleaned");
    },
    async issueExportRetrieval(owner, descriptor) {
      return issueCapability(
        exportByHash,
        owner,
        descriptor,
        toPortableArchiveExportRetrieval,
        "export_issued",
      );
    },
    async redeemExportRetrieval(owner, retrieval) {
      const record = await ownedCapability(exportByHash, owner, retrieval);
      return record?.state === "ready" ? record.descriptor : null;
    },
    async beginExportCleanup(owner, retrieval) {
      return beginCapabilityCleanup(exportByHash, owner, retrieval, "export_cleanup_pending");
    },
    async completeExportCleanup(owner, retrieval) {
      return completeCapabilityCleanup(exportByHash, owner, retrieval, "export_cleaned");
    },
    async preparePublicationCleanup(operation, claim) {
      const record = operationById.get(operation.operationId);
      const status = claimOutcome(record, operation, claim);
      if (status !== "valid") return { outcome: status };
      if (!record) return { outcome: "stale" };
      if (record.state === "cleaned") return { outcome: "already_cleaned" };
      if (record.state !== "cleanup_pending") return { outcome: "stale" };
      return { outcome: "cleanup_required", descriptor: record.descriptor ?? null };
    },
    events() {
      return [...observedEvents];
    },
    persistedTokenHashes() {
      return [
        ...candidateByHash.keys(),
        ...locatorByHash.keys(),
        ...stagedByHash.keys(),
        ...exportByHash.keys()
      ];
    }
  };
}
