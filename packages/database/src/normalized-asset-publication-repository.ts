import { createHash } from "node:crypto";
import {
  bindPrivateNormalizedAssetRequestChildren,
  fingerprintPrivateNormalizedAssetPublicationRequest,
  projectSafeNormalizedAssetPublicationResult,
  type PrivateNormalizedAssetRequestAttachmentInput,
  type PrivateNormalizedAssetPublicationRequest,
  type SafeNormalizedAssetPublicationResult
} from "../../application/src/assets/private-normalized-asset-publication.js";
import type { DurableFilesystemTransactionContext } from "../../application/src/assets/private-storage-lifecycle.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

export type PrivateNormalizedAssetPublicationReservation = Readonly<{
  requestId: string;
  ownerUserId: string;
  canonicalAssetId: string | null;
  canonicalContentHash: string | null;
  lifecycle: "prepared" | "attached" | "published" | "cleanup_pending" | "failed";
  outcome: "reserved" | "recoverable";
}>;

export interface PrivateNormalizedAssetPublicationRepository {
  reserveRequest(
    request: PrivateNormalizedAssetPublicationRequest,
  ): Promise<PrivateNormalizedAssetPublicationReservation>;
  reserveRequestInTransaction(
    database: DurableFilesystemTransactionContext,
    request: PrivateNormalizedAssetPublicationRequest,
  ): Promise<PrivateNormalizedAssetPublicationReservation>;
  attachRequestInTransaction(
    database: DurableFilesystemTransactionContext,
    request: PrivateNormalizedAssetPublicationRequest,
    attachment: PrivateNormalizedAssetRequestAttachmentInput,
  ): Promise<Readonly<{ requestId: string; lifecycle: "attached" | "published" }>>;
  completeRequest(
    request: PrivateNormalizedAssetPublicationRequest,
  ): Promise<SafeNormalizedAssetPublicationResult>;
}

type RequestRow = Readonly<{
  id: string;
  owner_user_id: string;
  canonical_asset_id: string | null;
  canonical_content_hash: string | null;
  lifecycle: PrivateNormalizedAssetPublicationReservation["lifecycle"];
  identity_lifecycle: "legacy" | "prepared" | "attached" | "published" | "cleanup_pending" | null;
}>;

type ArbitrationRow = Readonly<{
  canonical_asset_id: string;
  verification_state: "verified" | "verification_required";
  lifecycle: "legacy" | "prepared" | "attached" | "published" | "cleanup_pending";
}>;

type AttachmentRequestRow = Readonly<{
  id: string;
  owner_user_id: string;
  request_fingerprint: string;
  canonical_asset_id: string | null;
  lifecycle: "prepared" | "attached" | "published" | "cleanup_pending" | "failed";
  result: unknown;
  identity_lifecycle: "attached" | "published" | "prepared" | "cleanup_pending" | "legacy" | null;
}>;

type DerivativeRow = Readonly<{
  id: string;
  derivative_kind: "thumbnail";
  transform_version: number;
  pixel_width: number;
  pixel_height: number;
  content_hash: string;
}>;

type ContextRow = Readonly<{
  id: string;
  target_type: string;
  variant_index: number;
  world_id: string | null;
  world_version_id: string | null;
  campaign_id: string | null;
  turn_id: string | null;
}>;

type ReferenceRow = Readonly<{
  id: string;
  asset_role: string;
  campaign_id: string;
  turn_id: string | null;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyKeyHash(request: PrivateNormalizedAssetPublicationRequest): string {
  return sha256(request.idempotencyKey);
}

function requestFingerprint(request: PrivateNormalizedAssetPublicationRequest): string {
  return fingerprintPrivateNormalizedAssetPublicationRequest(request, sha256);
}

async function callerTransaction(database: DurableFilesystemTransactionContext): Promise<DatabaseClient> {
  const client = database as Partial<DatabaseClient>;
  if (typeof client.query !== "function") throw new Error("normalized_asset_publication_transaction_unavailable");
  try {
    await client.query("SAVEPOINT normalized_asset_publication_repository_context");
    await client.query("RELEASE SAVEPOINT normalized_asset_publication_repository_context");
  } catch {
    throw new Error("normalized_asset_publication_transaction_unavailable");
  }
  return client as DatabaseClient;
}

async function lockRequestAndContent(
  client: DatabaseClient,
  request: PrivateNormalizedAssetPublicationRequest,
  keyHash: string,
): Promise<void> {
  // The key lock makes same-key mismatches deterministic even when two callers
  // supply different content. The content lock is shared with the legacy
  // publisher and serializes every physical-content reservation before the
  // owner-scoped arbitration row is inspected or created.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `infinite-quest-nexus:normalized-publication:key:${request.owner.ownerUserId}:${keyHash}`
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `infinite-quest-nexus:asset-content:${request.original.contentHash}`
  ]);
}

function reservation(row: RequestRow): PrivateNormalizedAssetPublicationReservation {
  const recoverable = row.lifecycle === "cleanup_pending"
    || row.lifecycle === "failed"
    || row.identity_lifecycle === "attached"
    || row.identity_lifecycle === "cleanup_pending"
    || row.canonical_asset_id === null
    || row.canonical_content_hash === null;
  return Object.freeze({
    requestId: row.id,
    ownerUserId: row.owner_user_id,
    canonicalAssetId: row.canonical_asset_id,
    canonicalContentHash: row.canonical_content_hash,
    lifecycle: row.lifecycle,
    outcome: recoverable ? "recoverable" : "reserved"
  });
}

async function selectRequest(
  client: DatabaseClient,
  ownerUserId: string,
  keyHash: string,
): Promise<RequestRow | null> {
  const selected = await client.query<RequestRow>(
    `SELECT request.id,request.owner_user_id,request.canonical_asset_id,
            request.canonical_content_hash,request.lifecycle,identity.lifecycle AS identity_lifecycle
       FROM asset_publication_requests request
       LEFT JOIN asset_publication_identities identity
         ON identity.asset_id=request.canonical_asset_id
        AND identity.owner_user_id=request.owner_user_id
      WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2
      FOR UPDATE OF request`,
    [ownerUserId, keyHash]
  );
  const row = selected.rows[0];
  if (!row?.canonical_asset_id) return row ?? null;
  const identity = await client.query<Pick<RequestRow, "identity_lifecycle">>(
    `SELECT lifecycle AS identity_lifecycle
       FROM asset_publication_identities
      WHERE asset_id=$1 AND owner_user_id=$2
      FOR KEY SHARE`,
    [row.canonical_asset_id, row.owner_user_id]
  );
  return Object.freeze({
    ...row,
    identity_lifecycle: identity.rows[0]?.identity_lifecycle ?? null
  });
}

async function selectArbitration(
  client: DatabaseClient,
  ownerUserId: string,
  contentHash: string,
): Promise<ArbitrationRow | null> {
  const selected = await client.query<ArbitrationRow>(
    `SELECT arbitration.canonical_asset_id,arbitration.verification_state,identity.lifecycle
       FROM asset_publication_content_arbitrations arbitration
       JOIN asset_publication_identities identity
         ON identity.asset_id=arbitration.canonical_asset_id
        AND identity.owner_user_id=arbitration.owner_user_id
      WHERE arbitration.owner_user_id=$1 AND arbitration.content_hash=$2
      FOR UPDATE OF arbitration,identity`,
    [ownerUserId, contentHash]
  );
  return selected.rows[0] ?? null;
}

async function createCanonicalIdentity(
  client: DatabaseClient,
  request: PrivateNormalizedAssetPublicationRequest,
  keyHash: string,
  fingerprint: string,
): Promise<string> {
  const created = await client.query<{ asset_id: string }>(
    `INSERT INTO asset_publication_identities (
       asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle
     ) VALUES (gen_random_uuid(),$1,$2,$3,'prepared')
     RETURNING asset_id`,
    [request.owner.ownerUserId, keyHash, fingerprint]
  );
  const assetId = created.rows[0]?.asset_id;
  if (!assetId) throw new Error("normalized_asset_publication_identity_unavailable");
  await client.query(
    `INSERT INTO asset_publication_content_arbitrations (
       owner_user_id,content_hash,canonical_asset_id,verification_state
     ) VALUES ($1,$2,$3,'verified')`,
    [request.owner.ownerUserId, request.original.contentHash, assetId]
  );
  return assetId;
}

async function insertRequest(
  client: DatabaseClient,
  request: PrivateNormalizedAssetPublicationRequest,
  keyHash: string,
  fingerprint: string,
  canonicalAssetId: string,
  identityLifecycle: ArbitrationRow["lifecycle"],
): Promise<RequestRow> {
  const inserted = await client.query<RequestRow>(
    `INSERT INTO asset_publication_requests (
       owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,
       canonical_asset_id,lifecycle,requested_library_snapshot,provenance_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'prepared',$6::jsonb,$7::jsonb)
     RETURNING id,owner_user_id,canonical_asset_id,canonical_content_hash,lifecycle`,
    [
      request.owner.ownerUserId,
      keyHash,
      fingerprint,
      request.original.contentHash,
      canonicalAssetId,
      JSON.stringify(request.requestedLibrary),
      JSON.stringify(request.provenance)
    ]
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("normalized_asset_publication_request_unavailable");
  return Object.freeze({ ...row, identity_lifecycle: identityLifecycle });
}

async function reserveWithClient(
  client: DatabaseClient,
  request: PrivateNormalizedAssetPublicationRequest,
): Promise<PrivateNormalizedAssetPublicationReservation> {
  const keyHash = idempotencyKeyHash(request);
  const fingerprint = requestFingerprint(request);
  await lockRequestAndContent(client, request, keyHash);

  const existing = await selectRequest(client, request.owner.ownerUserId, keyHash);
  if (existing) {
    const stored = await client.query<{ request_fingerprint: string }>(
      `SELECT request_fingerprint FROM asset_publication_requests
        WHERE id=$1 AND owner_user_id=$2 FOR KEY SHARE`,
      [existing.id, existing.owner_user_id]
    );
    if (stored.rows[0]?.request_fingerprint !== fingerprint) {
      throw new Error("asset_publication_idempotency_mismatch");
    }
    return reservation(existing);
  }

  const existingArbitration = await selectArbitration(
    client,
    request.owner.ownerUserId,
    request.original.contentHash,
  );
  if (existingArbitration?.verification_state === "verification_required") {
    throw new Error("asset_publication_verification_required");
  }
  const canonicalAssetId = existingArbitration?.canonical_asset_id
    ?? await createCanonicalIdentity(client, request, keyHash, fingerprint);
  const created = await insertRequest(
    client,
    request,
    keyHash,
    fingerprint,
    canonicalAssetId,
    existingArbitration?.lifecycle ?? "prepared"
  );

  if (!existingArbitration) {
    await client.query(
      `INSERT INTO asset_publication_library_initializations (
         request_id,owner_user_id,canonical_asset_id,library_snapshot
       ) VALUES ($1,$2,$3,$4::jsonb)`,
      [
        created.id,
        request.owner.ownerUserId,
        canonicalAssetId,
        JSON.stringify(request.canonicalLibraryInitialization.library)
      ]
    );
  }
  return reservation(created);
}

function derivativeSlotKey(value: Readonly<{
  derivativeKind: "thumbnail";
  transformVersion: number;
  pixelWidth: number;
  pixelHeight: number;
}>): string {
  return `${value.derivativeKind}:${value.transformVersion}:${value.pixelWidth}:${value.pixelHeight}`;
}

function sameSafeResult(left: ReturnType<typeof projectSafeNormalizedAssetPublicationResult>, right: ReturnType<typeof projectSafeNormalizedAssetPublicationResult>): boolean {
  return left.assetId === right.assetId
    && left.mimeType === right.mimeType
    && left.byteLength === right.byteLength
    && left.contentHash === right.contentHash
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && JSON.stringify(left.derivatives) === JSON.stringify(right.derivatives);
}

async function attachWithClient(
  client: DatabaseClient,
  request: PrivateNormalizedAssetPublicationRequest,
  attachment: PrivateNormalizedAssetRequestAttachmentInput,
): Promise<Readonly<{ requestId: string; lifecycle: "attached" | "published" }>> {
  const keyHash = idempotencyKeyHash(request);
  const stored = await client.query<AttachmentRequestRow>(
    `SELECT request.id,request.owner_user_id,request.request_fingerprint,request.canonical_asset_id,
            request.lifecycle,request.result,identity.lifecycle AS identity_lifecycle
       FROM asset_publication_requests request
      LEFT JOIN asset_publication_identities identity
        ON identity.asset_id=request.canonical_asset_id
        AND identity.owner_user_id=request.owner_user_id
      WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2
      FOR UPDATE OF request`,
    [request.owner.ownerUserId, keyHash]
  );
  const row = stored.rows[0];
  if (!row || row.request_fingerprint !== requestFingerprint(request)
    || !row.canonical_asset_id || !row.identity_lifecycle) {
    throw new Error("asset_publication_request_attachment_unavailable");
  }
  const lockedIdentity = await client.query<Pick<AttachmentRequestRow, "identity_lifecycle">>(
    `SELECT lifecycle AS identity_lifecycle
       FROM asset_publication_identities
      WHERE asset_id=$1 AND owner_user_id=$2 FOR SHARE`,
    [row.canonical_asset_id, row.owner_user_id]
  );
  const identityLifecycle = lockedIdentity.rows[0]?.identity_lifecycle;
  if (!identityLifecycle) throw new Error("asset_publication_request_attachment_unavailable");
  const projectedResult = projectSafeNormalizedAssetPublicationResult(attachment.result);
  const result = Object.freeze({
    ...projectedResult,
    derivatives: Object.freeze([...projectedResult.derivatives].sort((left, right) => (
      derivativeSlotKey(left) < derivativeSlotKey(right) ? -1
        : derivativeSlotKey(left) > derivativeSlotKey(right) ? 1 : 0
    )))
  });
  const bindings = bindPrivateNormalizedAssetRequestChildren(request, {
    requestId: row.id,
    ownerUserId: row.owner_user_id,
    assetId: row.canonical_asset_id,
    requestFingerprint: row.request_fingerprint
  }, attachment);
  if (result.assetId !== row.canonical_asset_id
    || result.mimeType !== request.original.mimeType
    || result.byteLength !== request.original.byteLength
    || result.contentHash !== request.original.contentHash
    || result.pixelWidth !== request.original.technicalMetadata.pixelWidth
    || result.pixelHeight !== request.original.technicalMetadata.pixelHeight) {
    throw new Error("asset_publication_request_result_mismatch");
  }
  if (row.lifecycle === "attached" || row.lifecycle === "published") {
    if (!row.result || !sameSafeResult(projectSafeNormalizedAssetPublicationResult(row.result), result)) {
      throw new Error("asset_publication_request_result_mismatch");
    }
    return Object.freeze({ requestId: row.id, lifecycle: row.lifecycle });
  }
  if (row.lifecycle !== "prepared" || !["attached", "published"].includes(identityLifecycle)) {
    throw new Error("asset_publication_request_attachment_unavailable");
  }

  const canonical = await client.query<Readonly<{ id: string }>>(
    `SELECT id FROM assets WHERE id=$1 AND owner_user_id=$2
      AND content_hash=$3 AND mime_type=$4 AND byte_length=$5 FOR KEY SHARE`,
    [row.canonical_asset_id, row.owner_user_id, request.original.contentHash, request.original.mimeType, request.original.byteLength]
  );
  if (canonical.rowCount !== 1) throw new Error("asset_publication_request_result_mismatch");

  const expectedDerivatives = new Map(request.derivatives.map((derivative) => [
    derivativeSlotKey(derivative.slot), derivative
  ]));
  if (result.derivatives.length !== expectedDerivatives.size
    || new Set(result.derivatives.map((derivative) => derivative.derivativeId)).size !== result.derivatives.length) {
    throw new Error("asset_publication_request_derivative_mismatch");
  }
  const derivativeIds = result.derivatives.map((derivative) => derivative.derivativeId);
  const derivatives = derivativeIds.length === 0 ? [] : (await client.query<DerivativeRow>(
    `SELECT id,derivative_kind,transform_version,pixel_width,pixel_height,content_hash
       FROM asset_derivatives
      WHERE owner_user_id=$1 AND source_asset_id=$2 AND id=ANY($3::uuid[])
      FOR KEY SHARE`,
    [row.owner_user_id, row.canonical_asset_id, derivativeIds]
  )).rows;
  if (derivatives.length !== derivativeIds.length) throw new Error("asset_publication_request_derivative_mismatch");
  const storedDerivatives = new Map(derivatives.map((derivative) => [derivative.id, derivative]));
  for (const derivative of result.derivatives) {
    const expected = expectedDerivatives.get(derivativeSlotKey(derivative));
    const actual = storedDerivatives.get(derivative.derivativeId);
    if (!expected || !actual
      || actual.derivative_kind !== derivative.derivativeKind
      || actual.transform_version !== derivative.transformVersion
      || actual.pixel_width !== derivative.pixelWidth
      || actual.pixel_height !== derivative.pixelHeight
      || actual.content_hash !== expected.artifact.contentHash) {
      throw new Error("asset_publication_request_derivative_mismatch");
    }
  }

  const contextIds = bindings.contexts.map((context) => context.contextId);
  if (contextIds.length > 0) {
    const contexts = await client.query<ContextRow>(
      `SELECT id,target_type,variant_index,world_id,world_version_id,campaign_id,turn_id
         FROM asset_generation_contexts
        WHERE owner_user_id=$1 AND asset_id=$2 AND id=ANY($3::uuid[]) FOR KEY SHARE`,
      [row.owner_user_id, row.canonical_asset_id, contextIds]
    );
    if (contexts.rows.length !== contextIds.length) throw new Error("asset_publication_request_children_mismatch");
    const storedContexts = new Map(contexts.rows.map((context) => [context.id, context]));
    for (const intent of request.contextIntents) {
      const binding = bindings.contexts.find((value) => value.intentKey === intent.intentKey);
      const context = binding ? storedContexts.get(binding.contextId) : undefined;
      if (!context || context.target_type !== intent.targetType || context.variant_index !== intent.variantIndex
        || context.world_id !== intent.worldId || context.world_version_id !== intent.worldVersionId
        || context.campaign_id !== intent.campaignId || context.turn_id !== intent.turnId) {
        throw new Error("asset_publication_request_children_mismatch");
      }
    }
  }
  const referenceIds = bindings.references.map((reference) => reference.referenceId);
  if (referenceIds.length > 0) {
    const references = await client.query<ReferenceRow>(
      `SELECT id,asset_role,campaign_id,turn_id FROM asset_references
        WHERE owner_user_id=$1 AND asset_id=$2 AND id=ANY($3::uuid[]) FOR KEY SHARE`,
      [row.owner_user_id, row.canonical_asset_id, referenceIds]
    );
    if (references.rows.length !== referenceIds.length) throw new Error("asset_publication_request_children_mismatch");
    const storedReferences = new Map(references.rows.map((reference) => [reference.id, reference]));
    for (const intent of request.referencePolicy.intents) {
      const binding = bindings.references.find((value) => value.intentKey === intent.intentKey);
      const reference = binding ? storedReferences.get(binding.referenceId) : undefined;
      if (!reference || reference.asset_role !== intent.assetRole
        || reference.campaign_id !== intent.campaignId || reference.turn_id !== intent.turnId) {
        throw new Error("asset_publication_request_children_mismatch");
      }
    }
  }

  for (const [ordinal, source] of request.sourceRecords.entries()) {
    await client.query(
      `INSERT INTO asset_publication_request_sources (
         request_id,owner_user_id,ordinal,source_kind,source_asset_id,source_record_id,source_key,
         requested_library_snapshot,binding_intent_keys
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      [row.id, row.owner_user_id, ordinal, source.sourceKind, source.sourceAssetId, source.sourceRecordId,
        source.sourceKey, JSON.stringify(source.requestedLibrary), JSON.stringify(source.bindingIntentKeys)]
    );
  }
  for (const context of request.contextIntents) {
    const bound = bindings.contexts.find((value) => value.intentKey === context.intentKey);
    await client.query(
      `INSERT INTO asset_publication_request_contexts (
         request_id,owner_user_id,intent_key,context_snapshot,context_id
       ) VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [row.id, row.owner_user_id, context.intentKey, JSON.stringify(context), bound?.contextId ?? null]
    );
  }
  for (const reference of request.referencePolicy.intents) {
    const bound = bindings.references.find((value) => value.intentKey === reference.intentKey);
    await client.query(
      `INSERT INTO asset_publication_request_references (
         request_id,owner_user_id,intent_key,reference_snapshot,reference_id
       ) VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [row.id, row.owner_user_id, reference.intentKey, JSON.stringify(reference), bound?.referenceId ?? null]
    );
  }
  for (const [ordinal, derivative] of request.derivatives.entries()) {
    const resultDerivative = result.derivatives.find((value) => derivativeSlotKey(value) === derivativeSlotKey(derivative.slot));
    if (!resultDerivative) throw new Error("asset_publication_request_derivative_mismatch");
    await client.query(
      `INSERT INTO asset_publication_request_derivatives (
         request_id,owner_user_id,ordinal,slot_snapshot,content_hash,technical_metadata,derivative_id
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)`,
      [row.id, row.owner_user_id, ordinal, JSON.stringify(derivative.slot), derivative.artifact.contentHash,
        JSON.stringify(derivative.artifact.technicalMetadata), resultDerivative.derivativeId]
    );
  }
  const lifecycle = identityLifecycle === "published" ? "published" : "attached";
  const updated = await client.query(
    `UPDATE asset_publication_requests
        SET lifecycle=$3,result=$4::jsonb,published_at=CASE WHEN $3='published' THEN clock_timestamp() ELSE NULL END,
            updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND lifecycle='prepared'`,
    [row.id, row.owner_user_id, lifecycle, JSON.stringify(result)]
  );
  if (updated.rowCount !== 1) throw new Error("asset_publication_request_attachment_unavailable");
  await client.query(
    `INSERT INTO asset_publication_request_results (request_id,owner_user_id,result)
     VALUES ($1,$2,$3::jsonb)`,
    [row.id, row.owner_user_id, JSON.stringify(result)]
  );
  return Object.freeze({ requestId: row.id, lifecycle });
}

async function completeWithClient(
  client: DatabaseClient,
  request: PrivateNormalizedAssetPublicationRequest,
): Promise<SafeNormalizedAssetPublicationResult> {
  const keyHash = idempotencyKeyHash(request);
  const stored = await client.query<AttachmentRequestRow>(
    `SELECT request.id,request.owner_user_id,request.request_fingerprint,request.canonical_asset_id,
            request.lifecycle,request.result,identity.lifecycle AS identity_lifecycle
       FROM asset_publication_requests request
       JOIN asset_publication_identities identity
         ON identity.asset_id=request.canonical_asset_id
        AND identity.owner_user_id=request.owner_user_id
      WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2
      FOR UPDATE OF request,identity`,
    [request.owner.ownerUserId, keyHash]
  );
  const row = stored.rows[0];
  if (!row || row.request_fingerprint !== requestFingerprint(request) || !row.result) {
    throw new Error("asset_publication_request_completion_unavailable");
  }
  const result = projectSafeNormalizedAssetPublicationResult(row.result);
  if (row.lifecycle === "published") return result;
  if (row.lifecycle !== "attached" || row.identity_lifecycle !== "published") {
    throw new Error("asset_publication_finalization_pending");
  }
  const updated = await client.query(
    `UPDATE asset_publication_requests
        SET lifecycle='published',published_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$2 AND lifecycle='attached'`,
    [row.id, row.owner_user_id]
  );
  if (updated.rowCount !== 1) throw new Error("asset_publication_request_completion_unavailable");
  return result;
}

/**
 * Private normalized request authority. It deliberately reserves an existing
 * 0060 canonical identity rather than treating its asset ID or result as this
 * request's identity or result.
 */
export function createPostgresNormalizedAssetPublicationRepository(
  pool: DatabasePool,
): PrivateNormalizedAssetPublicationRepository {
  return Object.freeze({
    reserveRequest: (request: PrivateNormalizedAssetPublicationRequest) => (
      withTransaction(pool, (client) => reserveWithClient(client, request))
    ),
    reserveRequestInTransaction: async (
      database: DurableFilesystemTransactionContext,
      request: PrivateNormalizedAssetPublicationRequest,
    ) => (
      reserveWithClient(await callerTransaction(database), request)
    ),
    attachRequestInTransaction: async (
      database: DurableFilesystemTransactionContext,
      request: PrivateNormalizedAssetPublicationRequest,
      attachment: PrivateNormalizedAssetRequestAttachmentInput,
    ) => attachWithClient(await callerTransaction(database), request, attachment),
    completeRequest: (request: PrivateNormalizedAssetPublicationRequest) => (
      withTransaction(pool, (client) => completeWithClient(client, request))
    )
  });
}
