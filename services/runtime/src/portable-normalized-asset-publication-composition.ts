import { createHash } from "node:crypto";
import {
  bindPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetReservationHandle
} from "../../../packages/application/src/assets/private-normalized-asset-publication.js";
import type {
  PrivatePortableNormalizedAssetPublicationCoordinator,
  PrivatePortableNormalizedFinalizationOutcome,
  PrivatePortableNormalizedPublicationIntent,
  PrivatePortableNormalizedPublicationScope,
  PrivatePortableNormalizedReservationHandle
} from "../../../packages/application/src/imports/private-normalized-portable-publication.js";
import {
  createPostgresPortableNormalizedAssetPublicationRepository,
  type PostgresPortableNormalizedAssetPublicationRepository
} from "../../../packages/database/src/portable-normalized-asset-publication-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import {
  createPrivateNormalizedAssetPublicationComposition,
  type PrivateNormalizedAssetPublicationComposition
} from "./normalized-asset-publication-composition.js";
import {
  inspectPrivateImageArtifact,
  normalizePrivateImageArtifact
} from "./private-image-normalization.js";

const MAXIMUM_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAXIMUM_IMPORT_IMAGE_PIXELS = 40_000_000;
const MAXIMUM_IMPORT_IMAGE_AGGREGATE_PIXELS = 40_000_000;
const MAXIMUM_PORTABLE_PUBLICATION_BATCH = 256;
const MAXIMUM_NORMALIZED_PUBLICATION_BATCH = 100;

type ReservationState = {
  scope: PrivatePortableNormalizedPublicationScope;
  requests: readonly PrivateNormalizedAssetPublicationRequest[];
  reservations: readonly PrivateNormalizedAssetReservationHandle[];
  discarded: boolean;
  attachAttempted: boolean;
  retirementStarted: boolean;
};

const reservationStates = new WeakMap<object, ReservationState>();

function stableError(code: string): Error {
  return new Error(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function opaqueReservationHandle(): PrivatePortableNormalizedReservationHandle {
  return Object.freeze({}) as PrivatePortableNormalizedReservationHandle;
}

function boundedBatches<T>(values: readonly T[]): readonly (readonly T[])[] {
  const batches: (readonly T[])[] = [];
  for (let offset = 0; offset < values.length; offset += MAXIMUM_NORMALIZED_PUBLICATION_BATCH) {
    batches.push(Object.freeze(values.slice(offset, offset + MAXIMUM_NORMALIZED_PUBLICATION_BATCH)));
  }
  return Object.freeze(batches);
}

async function finalizeRows(
  rows: Awaited<ReturnType<PostgresPortableNormalizedAssetPublicationRepository["loadFinalizations"]>>,
  repository: PostgresPortableNormalizedAssetPublicationRepository,
  normalized: PrivateNormalizedAssetPublicationComposition,
  recovery: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
): Promise<PrivatePortableNormalizedFinalizationOutcome> {
  if (rows.length === 0) return Object.freeze({ outcome: "noop" as const });
  try {
    for (const row of rows) {
      if (row.publicationState === "published") continue;
      const outcome = await normalized.publication.finalize(row.finalization, recovery);
      if (outcome.outcome === "published") {
        await repository.markFinalizationPublished(row);
      } else {
        await repository.recordFinalizationRecoverable(row);
      }
    }
    const refreshed = await repository.loadFinalizations(
      rows[0]!.ownerUserId,
      rows[0]!.operationId,
    );
    return refreshed.length === rows.length
      && refreshed.every((row) => row.publicationState === "published")
      ? Object.freeze({
        outcome: "published" as const,
        assets: Object.freeze(refreshed.map(({ result }) => result))
      })
      : Object.freeze({
        outcome: "committed_finalization_pending" as const,
        diagnostic: "asset_publication_finalization_recoverable" as const
      });
  } catch {
    return Object.freeze({
      outcome: "committed_finalization_pending" as const,
      diagnostic: "asset_publication_finalization_recoverable" as const
    });
  }
}

/** Additive e4 graph. It is consumed only by the still-private portable composition. */
export type PrivatePortableNormalizedAssetPublicationComposition = Readonly<{
  coordinator: PrivatePortableNormalizedAssetPublicationCoordinator;
  portableStorage: PrivateNormalizedAssetPublicationComposition["portableStorage"];
  close(): Promise<void>;
}>;

export async function createPrivatePortableNormalizedAssetPublicationComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
): Promise<PrivatePortableNormalizedAssetPublicationComposition> {
  const normalized = await createPrivateNormalizedAssetPublicationComposition(pool, roots);
  const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);

  const reserve: PrivatePortableNormalizedAssetPublicationCoordinator["reserve"] = async (input) => {
    if (!input.leaseOwner.trim() || input.leaseOwner.length > 512
      || !Number.isFinite(Date.parse(input.expiresAt))
      || input.assets.length > MAXIMUM_PORTABLE_PUBLICATION_BATCH) {
      throw stableError("portable_normalized_publication_reservation_invalid");
    }
    let reservedForCleanup: readonly PrivateNormalizedAssetReservationHandle[] = Object.freeze([]);
    let optionalIntents: readonly PrivatePortableNormalizedPublicationIntent[] = Object.freeze([]);
    try {
      let aggregatePixels = 0;
      for (const { artifact } of input.assets) {
        if (artifact.byteLength !== artifact.bytes.byteLength
          || artifact.contentHash !== sha256(artifact.bytes)) {
          throw stableError("portable_import_image_content_mismatch");
        }
        const inspected = await inspectPrivateImageArtifact({
          bytes: artifact.bytes,
          declaredMimeType: artifact.declaredMimeType,
          maximumBytes: MAXIMUM_IMPORT_IMAGE_BYTES,
          maximumPixels: MAXIMUM_IMPORT_IMAGE_PIXELS,
          diagnosticPrefix: "portable_import_image"
        });
        aggregatePixels += inspected.pixelCount;
        if (aggregatePixels > MAXIMUM_IMPORT_IMAGE_AGGREGATE_PIXELS) {
          throw stableError("portable_import_image_batch_pixels_invalid");
        }
      }
      const normalizedArtifacts: Awaited<ReturnType<typeof normalizePrivateImageArtifact>>[] = [];
      for (const { artifact } of input.assets) {
        normalizedArtifacts.push(await normalizePrivateImageArtifact({
          bytes: artifact.bytes,
          declaredMimeType: artifact.declaredMimeType,
          maximumBytes: MAXIMUM_IMPORT_IMAGE_BYTES,
          maximumPixels: MAXIMUM_IMPORT_IMAGE_PIXELS,
          diagnosticPrefix: "portable_import_image"
        }));
      }
      const requests = Object.freeze(input.assets.map((asset, index) => (
        bindPrivateNormalizedAssetPublicationRequest({
          owner: { ownerUserId: input.scope.ownerUserId },
          idempotencyKey: asset.idempotencyKey,
          original: normalizedArtifacts[index]!.original,
          derivatives: [normalizedArtifacts[index]!.thumbnail],
          requestedLibrary: asset.requestedLibrary,
          sourceRecords: asset.sourceRecords,
          provenance: {
            kind: "import",
            importKind: input.scope.importKind,
            importOperationId: input.scope.operationId,
            importId: null,
            sourceInstallationId: asset.sourceInstallationId
          },
          contextIntents: asset.contextIntents,
          referencePolicy: asset.referencePolicy
        })
      )));
      const intents: readonly PrivatePortableNormalizedPublicationIntent[] = Object.freeze(
        requests.map((request) => Object.freeze({ request })),
      );
      optionalIntents = intents;

      if (requests.length > 0) {
        await repository.recordAndBindReservedRequests(
          input.scope,
          intents,
          (database, exactRequests) => normalized.publication.reserveRequestsInTransaction(
            database,
            exactRequests,
          ),
        );
      }
      // The operation-owned mapping is now bound before e2 may write bytes.
      const reservations = requests.length === 0
        ? Object.freeze([])
        : (await normalized.publication.reserveAggregate(boundedBatches(requests.map((request) => ({
            request,
            leaseOwner: input.leaseOwner,
            expiresAt: input.expiresAt
          }))))).flat();
      reservedForCleanup = reservations;
      const handle = opaqueReservationHandle();
      reservationStates.set(handle, {
        scope: input.scope,
        requests,
        reservations,
        discarded: false,
        attachAttempted: false,
        retirementStarted: false
      });
      return handle;
    } catch (error) {
      await Promise.allSettled(reservedForCleanup.map((reservation) => (
        normalized.publication.discardAfterRollback(reservation)
      )));
      if (input.scope.importKind !== "legacy_story") throw error;
      await repository.beginOptionalOmission(input.scope, optionalIntents);
      const handle = opaqueReservationHandle();
      reservationStates.set(handle, {
        scope: input.scope,
        requests: Object.freeze([]),
        reservations: Object.freeze([]),
        discarded: false,
        attachAttempted: false,
        retirementStarted: false
      });
      return handle;
    }
  };

  const attachInTransaction: PrivatePortableNormalizedAssetPublicationCoordinator["attachInTransaction"] = async (
    database,
    handle,
    attachDomain,
  ) => {
    const state = reservationStates.get(handle);
    if (!state || state.discarded || state.attachAttempted) {
      throw stableError("portable_normalized_publication_reservation_unavailable");
    }
    state.attachAttempted = true;
    if (state.reservations.length === 0) {
      const domain = await attachDomain(Object.freeze([]));
      if (domain.childBindings.length !== 0) {
        throw stableError("portable_normalized_publication_attachment_invalid");
      }
      return Object.freeze({ value: domain.value, publications: Object.freeze([]) });
    }
    let domainResult: Awaited<ReturnType<typeof attachDomain>> | undefined;
    const attached = await normalized.publication.attachAggregateInTransaction(
      database,
      boundedBatches(state.reservations),
      async (results) => {
        const domain = await attachDomain(results);
        if (domain.childBindings.length !== results.length) {
          throw stableError("portable_normalized_publication_attachment_invalid");
        }
        domainResult = domain;
        return domain.childBindings;
      },
    );
    if (!domainResult) {
      throw stableError("portable_normalized_publication_attachment_invalid");
    }
    const publications = Object.freeze(attached.map((publication, assetOrdinal) => Object.freeze({
      assetOrdinal,
      result: publication.result,
      finalization: publication.finalization
    })));
    await repository.recordAttachedInTransaction(
      database,
      state.scope,
      domainResult.importId,
      publications,
    );
    return Object.freeze({ value: domainResult.value, publications });
  };

  const coordinator: PrivatePortableNormalizedAssetPublicationCoordinator = Object.freeze({
    reserve,
    attachInTransaction,
    async beginRetirementInTransaction(
      database: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["beginRetirementInTransaction"]>[0],
      handle: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["beginRetirementInTransaction"]>[1],
      reason: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["beginRetirementInTransaction"]>[2],
    ) {
      const state = reservationStates.get(handle);
      if (!state || state.discarded || state.attachAttempted) {
        throw stableError("portable_normalized_publication_reservation_unavailable");
      }
      if (state.reservations.length === 0) {
        state.retirementStarted = true;
        return;
      }
      await repository.beginRetirementInTransaction(database, state.scope, reason);
      state.retirementStarted = true;
    },
    retireAbandonedOperationInTransaction(
      database: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator[
        "retireAbandonedOperationInTransaction"
      ]>[0],
      input: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator[
        "retireAbandonedOperationInTransaction"
      ]>[1],
    ) {
      return repository.retireAbandonedOperationInTransaction(database, input);
    },
    async completeRetirement(
      handle: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["completeRetirement"]>[0],
    ) {
      const state = reservationStates.get(handle);
      if (!state || !state.retirementStarted) {
        throw stableError("portable_normalized_publication_retirement_unavailable");
      }
      for (const reservation of state.reservations) {
        await normalized.publication.retireAfterTerminal(reservation);
      }
      state.discarded = true;
      const reconciled = await repository.reconcileRetirements(
        state.scope.ownerUserId,
        state.scope.operationId,
      );
      if (reconciled.pending !== 0) {
        throw stableError("portable_normalized_publication_retirement_recoverable");
      }
    },
    async discardAfterRollback(
      handle: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["discardAfterRollback"]>[0],
    ) {
      const state = reservationStates.get(handle);
      if (!state || state.discarded) {
        throw stableError("portable_normalized_publication_reservation_unavailable");
      }
      await Promise.all(state.reservations.map((reservation) => (
        normalized.publication.discardAfterRollback(reservation)
      )));
      state.discarded = true;
      const reconciled = await repository.reconcileRetirements(
        state.scope.ownerUserId,
        state.scope.operationId,
      );
      if (reconciled.pending !== 0) {
        throw stableError("portable_normalized_publication_retirement_recoverable");
      }
    },
    async finalizeOperation(
      input: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["finalizeOperation"]>[0],
    ) {
      const rows = await repository.loadFinalizations(input.ownerUserId, input.operationId);
      return finalizeRows(rows, repository, normalized, {
        leaseOwner: input.leaseOwner,
        leaseSeconds: input.leaseSeconds
      });
    },
    async recoverCommitted(
      input: Parameters<PrivatePortableNormalizedAssetPublicationCoordinator["recoverCommitted"]>[0],
    ) {
      const reconciled = await repository.reconcileCommittedRetirements(
        input.ownerUserId,
        input.previewToken,
      );
      if (reconciled.pending !== 0) {
        return Object.freeze({
          outcome: "committed_finalization_pending" as const,
          diagnostic: "asset_publication_finalization_recoverable" as const
        });
      }
      const rows = await repository.loadCommittedFinalizations(input.ownerUserId, input.previewToken);
      return finalizeRows(rows, repository, normalized, {
        leaseOwner: input.leaseOwner,
        leaseSeconds: input.leaseSeconds
      });
    }
  });

  let closed: Promise<void> | undefined;
  return Object.freeze({
    coordinator,
    portableStorage: normalized.portableStorage,
    close() {
      closed ??= normalized.close();
      return closed;
    }
  });
}
