import { createHash } from "node:crypto";
import {
  snapshotPrivateAssetPublicationCommand,
  verifyPrivateAssetPublicationContentHashes,
  type PrivateAssetPublicationCommand,
  type PrivateAssetPublicationIdentity,
  type PrivateAssetPublicationIdentityPort,
  type PrivatePreparedAssetPublication
} from "../../../packages/application/src/assets/private-asset-publication.js";
import type {
  PrivateNormalizedAssetFinalizationHandle,
  PrivateNormalizedAssetPublicationPort,
  PrivateNormalizedAssetPublicationRequest,
  PrivateNormalizedAssetReservationHandle,
  SafeNormalizedAssetPublicationResult
} from "../../../packages/application/src/assets/private-normalized-asset-publication.js";
import {
  createPostgresNormalizedAssetMaterializationRepository,
  createPostgresNormalizedAssetPublicationRepository,
  type PrivateNormalizedAssetPublicationReservation
} from "../../../packages/database/src/normalized-asset-publication-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { createAssetImportStorageComposition } from "./asset-import-composition.js";

type ReservationState = {
  request: PrivateNormalizedAssetPublicationRequest;
  reservation: PrivateNormalizedAssetPublicationReservation;
  prepared: PrivatePreparedAssetPublication | null;
  discarded: boolean;
};

const reservations = new WeakMap<object, ReservationState>();
const finalizations = new WeakMap<object, string>();

function opaqueReservationHandle(): PrivateNormalizedAssetReservationHandle {
  return Object.freeze({}) as PrivateNormalizedAssetReservationHandle;
}

function opaqueFinalizationHandle(requestId: string): PrivateNormalizedAssetFinalizationHandle {
  const handle = Object.freeze({}) as PrivateNormalizedAssetFinalizationHandle;
  finalizations.set(handle, requestId);
  return handle;
}

function stableError(code: string): Error {
  return new Error(code);
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

  const reserve: PrivateNormalizedAssetPublicationPort["reserve"] = async ({ request, leaseOwner, expiresAt }) => {
    try {
      const command = physicalCommand(request, leaseOwner, expiresAt);
      const reservation = await requestRepository.reserveRequest(request);
      if (reservation.outcome !== "reserved") {
        throw stableError("normalized_asset_publication_reservation_recoverable");
      }
      let prepared: PrivatePreparedAssetPublication | null = null;
      if (reservation.canonicalIdentityLifecycle === "prepared") {
        prepared = await storage.adapter.prepareAssetPublication(command, preparedIdentity(reservation));
      } else if (reservation.canonicalIdentityLifecycle !== "published") {
        throw stableError("normalized_asset_publication_reservation_recoverable");
      }
      const handle = opaqueReservationHandle();
      reservations.set(handle, { request, reservation, prepared, discarded: false });
      return handle;
    } catch {
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
        finalization: opaqueFinalizationHandle(state.reservation.requestId)
      });
    } catch {
      throw stableError("normalized_asset_publication_attachment_failed");
    }
  };

  const discardAfterRollback: PrivateNormalizedAssetPublicationPort["discardAfterRollback"] = async (
    reservationHandle,
  ) => {
      const state = reservations.get(reservationHandle);
      if (!state || state.discarded) {
        throw stableError("normalized_asset_publication_reservation_unavailable");
      }
      state.discarded = true;
      if (!state.prepared) return;
      const outcomes = await Promise.allSettled([
        state.prepared.original.rollback(),
        ...state.prepared.derivatives.map((derivative) => derivative.rollback())
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        throw stableError("normalized_asset_publication_discard_recoverable");
      }
    };

  const finalize: PrivateNormalizedAssetPublicationPort["finalize"] = async (
    finalizationHandle,
    recovery,
  ) => {
      const requestId = finalizations.get(finalizationHandle);
      if (!requestId) throw stableError("normalized_asset_publication_finalization_unavailable");
      try {
        const target = await materialization.readFinalizationTarget(requestId);
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

  return Object.freeze({ publication, close: storage.close });
}
