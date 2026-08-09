import { createHash } from "node:crypto";
import {
  snapshotPrivateAssetPublicationCommand,
  verifyPrivateAssetPublicationContentHashes,
  type PrivateAssetPublicationCommand,
  type PrivateAssetPublicationIdentity,
  type PrivateAssetPublicationIdentityPort,
  type PrivatePreparedAssetPublication
} from "../../../packages/application/src/assets/private-asset-publication.js";
import type { PrivateFilesystemPublicationLockPort } from "../../../packages/application/src/assets/private-filesystem-repository.js";
import {
  fingerprintPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetFinalizationHandle,
  type PrivateNormalizedAssetPublicationPort,
  type PrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetReservationHandle,
  type SafeNormalizedAssetPublicationResult
} from "../../../packages/application/src/assets/private-normalized-asset-publication.js";
import {
  createPostgresNormalizedAssetMaterializationRepository,
  createPostgresNormalizedAssetPublicationRepository,
  type PrivateNormalizedAssetFinalizationLocator,
  type PrivateNormalizedAssetPublicationReservation
} from "../../../packages/database/src/normalized-asset-publication-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { createAssetImportStorageComposition } from "./asset-import-composition.js";

type ReservationState = {
  request: PrivateNormalizedAssetPublicationRequest;
  reservation: PrivateNormalizedAssetPublicationReservation;
  prepared: PrivatePreparedAssetPublication | null;
  contentHashes: readonly string[];
  contentLock: HeldPublicationContentLock | null;
  discarded: boolean;
};

type HeldPublicationContentLock = Readonly<{
  release(): Promise<void>;
}>;

const reservations = new WeakMap<object, ReservationState>();
const FINALIZATION_HANDLE_PATTERN = /^narp1\.([0-9a-f]{64})\.([0-9a-f]{64})$/u;

function opaqueReservationHandle(): PrivateNormalizedAssetReservationHandle {
  return Object.freeze({}) as PrivateNormalizedAssetReservationHandle;
}

function opaqueFinalizationHandle(
  request: PrivateNormalizedAssetPublicationRequest,
): PrivateNormalizedAssetFinalizationHandle {
  const fingerprint = fingerprintPrivateNormalizedAssetPublicationRequest(
    request,
    (canonicalRequest) => createHash("sha256").update(canonicalRequest).digest("hex"),
  );
  const idempotencyHash = createHash("sha256").update(request.idempotencyKey).digest("hex");
  return `narp1.${fingerprint}.${idempotencyHash}` as PrivateNormalizedAssetFinalizationHandle;
}

function finalizationLocator(
  handle: PrivateNormalizedAssetFinalizationHandle,
): PrivateNormalizedAssetFinalizationLocator {
  const match = FINALIZATION_HANDLE_PATTERN.exec(handle);
  if (!match?.[1] || !match[2]) {
    throw stableError("normalized_asset_publication_finalization_unavailable");
  }
  return Object.freeze({ requestFingerprint: match[1], idempotencyKeyHash: match[2] });
}

function stableError(code: string): Error {
  return new Error(code);
}

async function holdPublicationContentLocks(
  publicationLocks: PrivateFilesystemPublicationLockPort,
  contentHashes: readonly string[],
): Promise<HeldPublicationContentLock> {
  let releaseWork!: () => void;
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const held = new Promise<void>((resolve) => { releaseWork = resolve; });
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const completion = publicationLocks.withPublicationContentLocks(contentHashes, async () => {
    resolveAcquired();
    await held;
  });
  void completion.catch(rejectAcquired);
  await acquired;
  let released = false;
  return Object.freeze({
    async release() {
      if (!released) {
        released = true;
        releaseWork();
      }
      await completion;
    }
  });
}

function physicalProvenance(
  request: PrivateNormalizedAssetPublicationRequest,
): PrivateAssetPublicationCommand["provenance"] {
  const context = request.contextIntents[0];
  return Object.freeze({
    origin: request.provenance.kind === "illustration"
      ? "generated" as const
      : request.provenance.kind === "import" ? "imported" as const : "uploaded" as const,
    ...(context?.campaignId ? { campaignId: context.campaignId } : {}),
    ...(context?.turnId ? { turnId: context.turnId } : {}),
    ...(context?.worldId ? { worldId: context.worldId } : {}),
    ...(context?.worldVersionId ? { worldVersionId: context.worldVersionId } : {}),
    ...(context ? { targetType: context.targetType } : {})
  });
}

function physicalCommand(
  request: PrivateNormalizedAssetPublicationRequest,
  leaseOwner: string,
  expiresAt: string,
): PrivateAssetPublicationCommand {
  if (request.original.technicalMetadata.state !== "verified"
    || request.derivatives.some((derivative) => derivative.artifact.technicalMetadata.state !== "verified")) {
    throw stableError("normalized_asset_publication_verification_required");
  }
  const command = snapshotPrivateAssetPublicationCommand(Object.freeze({
    owner: request.owner,
    idempotencyKey: request.idempotencyKey,
    leaseOwner,
    expiresAt,
    original: Object.freeze({
      bytes: request.original.bytes,
      mimeType: request.original.mimeType,
      byteLength: request.original.byteLength,
      contentHash: request.original.contentHash
    }),
    derivatives: Object.freeze(request.derivatives.map((derivative) => Object.freeze({
      bytes: derivative.artifact.bytes,
      mimeType: derivative.artifact.mimeType,
      byteLength: derivative.artifact.byteLength,
      contentHash: derivative.artifact.contentHash,
      derivativeKind: derivative.slot.derivativeKind,
      transformVersion: derivative.slot.transformVersion,
      pixelWidth: derivative.slot.pixelWidth,
      pixelHeight: derivative.slot.pixelHeight
    }))),
    provenance: physicalProvenance(request)
  }));
  verifyPrivateAssetPublicationContentHashes(
    command,
    (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  return command;
}

function preparedIdentity(
  reservation: PrivateNormalizedAssetPublicationReservation,
): PrivateAssetPublicationIdentity {
  if (!reservation.canonicalAssetId) {
    throw stableError("normalized_asset_publication_reservation_unavailable");
  }
  return Object.freeze({
    assetId: reservation.canonicalAssetId,
    ownerUserId: reservation.ownerUserId,
    lifecycle: "prepared"
  }) as PrivateAssetPublicationIdentity;
}

export type PrivateNormalizedAssetPublicationComposition = Readonly<{
  publication: PrivateNormalizedAssetPublicationPort;
  close(): Promise<void>;
}>;

/**
 * Private e2 publication graph. Reservation authority and post-commit locators
 * are retained in opaque handles; callers receive only normalized safe results.
 */
export async function createPrivateNormalizedAssetPublicationComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
): Promise<PrivateNormalizedAssetPublicationComposition> {
  let capturedPublicationIdentity: PrivateAssetPublicationIdentityPort | undefined;
  const storage = await createAssetImportStorageComposition(
    pool,
    roots,
    (publication) => { capturedPublicationIdentity = publication; },
  );
  if (!capturedPublicationIdentity) {
    await storage.close();
    throw stableError("normalized_asset_publication_composition_unavailable");
  }
  const publicationIdentity = capturedPublicationIdentity;
  const requestRepository = createPostgresNormalizedAssetPublicationRepository(pool);
  const materialization = createPostgresNormalizedAssetMaterializationRepository(pool, storage.candidate);
  const heldReservations = new Set<ReservationState>();
  const releaseReservationLock = async (state: ReservationState): Promise<void> => {
    const contentLock = state.contentLock;
    if (!contentLock) return;
    state.contentLock = null;
    heldReservations.delete(state);
    await contentLock.release();
  };

  const reserve: PrivateNormalizedAssetPublicationPort["reserve"] = async ({ request, leaseOwner, expiresAt }) => {
    let contentLock: HeldPublicationContentLock | null = null;
    try {
      const command = physicalCommand(request, leaseOwner, expiresAt);
      const initialReservation = await requestRepository.reserveRequest(request);
      if (initialReservation.outcome !== "reserved") {
        throw stableError("normalized_asset_publication_reservation_recoverable");
      }
      const contentHashes = Object.freeze([
        request.original.contentHash,
        ...request.derivatives.map((derivative) => derivative.artifact.contentHash)
      ]);
      contentLock = await holdPublicationContentLocks(storage.candidate, contentHashes);
      const reservation = await requestRepository.refreshReservedRequest(request);
      if (reservation.outcome !== "reserved"
        || reservation.requestId !== initialReservation.requestId
        || reservation.ownerUserId !== initialReservation.ownerUserId
        || reservation.canonicalAssetId !== initialReservation.canonicalAssetId
        || reservation.canonicalContentHash !== initialReservation.canonicalContentHash) {
        throw stableError("normalized_asset_publication_reservation_recoverable");
      }
      let prepared: PrivatePreparedAssetPublication | null = null;
      if (reservation.canonicalIdentityLifecycle === "prepared") {
        prepared = await storage.adapter.prepareAssetPublication(command, preparedIdentity(reservation));
      } else if (reservation.canonicalIdentityLifecycle !== "published") {
        throw stableError("normalized_asset_publication_reservation_recoverable");
      }
      const handle = opaqueReservationHandle();
      const state: ReservationState = {
        request,
        reservation,
        prepared,
        contentHashes,
        contentLock,
        discarded: false
      };
      reservations.set(handle, state);
      heldReservations.add(state);
      return handle;
    } catch {
      await contentLock?.release().catch(() => undefined);
      throw stableError("normalized_asset_publication_reservation_failed");
    }
  };

  const attachInTransaction: PrivateNormalizedAssetPublicationPort["attachInTransaction"] = async (
    database,
    reservationHandle,
    attachChildren,
  ) => {
    const state = reservations.get(reservationHandle);
    if (!state || state.discarded) {
      throw stableError("normalized_asset_publication_reservation_unavailable");
    }
    try {
      const result = state.prepared
        ? (await materialization.attachInTransaction(
          database,
          state.reservation,
          state.request,
          state.prepared,
        )).result
        : await materialization.readPublishedInTransaction(database, state.reservation, state.request);
      const children = await attachChildren(result);
      await requestRepository.attachRequestInTransaction(database, state.request, {
        result,
        contexts: children.contexts,
        references: children.references
      });
      return Object.freeze({
        result,
        finalization: opaqueFinalizationHandle(state.request)
      });
    } catch {
      throw stableError("normalized_asset_publication_attachment_failed");
    } finally {
      await releaseReservationLock(state).catch(() => undefined);
    }
  };

  const discardAfterRollback: PrivateNormalizedAssetPublicationPort["discardAfterRollback"] = async (
    reservationHandle,
  ) => {
    const state = reservations.get(reservationHandle);
    if (!state || state.discarded) {
      throw stableError("normalized_asset_publication_reservation_unavailable");
    }
    const discard = async (): Promise<void> => {
      const eligibility = await requestRepository.prepareRequestDiscard(state.reservation);
      if (eligibility.outcome !== "discardable") {
        throw stableError("normalized_asset_publication_discard_unavailable");
      }
      if (state.prepared) {
        await storage.adapter.discardPreparedAssetPublication(state.prepared);
      }
      state.discarded = true;
    };
    try {
      if (state.contentLock) {
        await discard();
      } else {
        await storage.candidate.withPublicationContentLocks(state.contentHashes, discard);
      }
    } catch (error) {
      if (error instanceof Error
        && error.message === "normalized_asset_publication_discard_unavailable") {
        throw stableError("normalized_asset_publication_discard_unavailable");
      }
      throw stableError("normalized_asset_publication_discard_recoverable");
    } finally {
      await releaseReservationLock(state).catch(() => undefined);
    }
  };

  const finalize: PrivateNormalizedAssetPublicationPort["finalize"] = async (
    finalizationHandle,
    recovery,
  ) => {
    const locator = finalizationLocator(finalizationHandle);
    try {
      const target = await materialization.readFinalizationTarget(locator);
      const requestId = target.requestId;
      if (target.requestLifecycle === "published") {
        return Object.freeze({
          outcome: "published" as const,
          result: await materialization.completeRequestById(requestId)
        });
      }
      const identities = await publicationIdentity.readPublicationIdentities(
        target.ownerUserId,
        [target.canonicalAssetId],
      );
      const identity = identities[0];
      if (!identity) throw stableError("normalized_asset_publication_finalization_unavailable");
      if (identity.lifecycle === "published") {
        return Object.freeze({
          outcome: "published" as const,
          result: await materialization.completeRequestById(requestId)
        });
      }
      const reconciliation = await publicationIdentity.reconcileAttachedPublication(identity, recovery);
      if (reconciliation.outcome === "recoverable") {
        return Object.freeze({
          outcome: "recoverable" as const,
          diagnostic: "asset_publication_finalization_recoverable" as const
        });
      }
      if (reconciliation.outcome === "ready_to_finalize") {
        await storage.adapter.finalizeAssetPublication(reconciliation.identity.finalization!);
        await publicationIdentity.completePublication(reconciliation.identity);
      }
      return Object.freeze({
        outcome: "published" as const,
        result: await materialization.completeRequestById(requestId)
      });
    } catch {
      return Object.freeze({
        outcome: "recoverable" as const,
        diagnostic: "asset_publication_finalization_recoverable" as const
      });
    }
  };

  const publication: PrivateNormalizedAssetPublicationPort = Object.freeze({
    reserve,
    attachInTransaction,
    discardAfterRollback,
    finalize
  });

  let closed: Promise<void> | undefined;
  return Object.freeze({
    publication,
    close() {
      closed ??= (async () => {
        await Promise.allSettled([...heldReservations].map(releaseReservationLock));
        await storage.close();
      })();
      return closed;
    }
  });
}
