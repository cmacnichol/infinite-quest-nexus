import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssetApplication } from "../../packages/application/src/assets/index.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import {
  bindPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetPublicationRequest
} from "../../packages/application/src/assets/private-normalized-asset-publication.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresAssetPublicationRepository } from "../../packages/database/src/asset-publication-repository.js";
import { createPostgresAssetRepositories } from "../../packages/database/src/asset-repository.js";
import { createPostgresNormalizedAssetPublicationRepository } from "../../packages/database/src/normalized-asset-publication-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type RequestOptions = Readonly<{
  libraryTitle?: string;
  contextIntentKey?: string;
}>;

function request(
  ownerUserId: string,
  idempotencyKey: string,
  sourceAssetId: string,
  contentLabel = "default",
  options: RequestOptions = {},
): PrivateNormalizedAssetPublicationRequest {
  const bytes = new TextEncoder().encode(`14e3e1c:${contentLabel}`);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const libraryTitle = options.libraryTitle ?? "Moonlit archive";
  const contextIntents = options.contextIntentKey === undefined ? [] : [{
    intentKey: options.contextIntentKey,
    targetType: "other" as const,
    variantIndex: 0,
  }];
  return bindPrivateNormalizedAssetPublicationRequest({
    owner: { ownerUserId },
    idempotencyKey: toAssetMutationIdempotencyKey(idempotencyKey),
    original: {
      bytes,
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      contentHash,
      technicalMetadata: { state: "verified", pixelWidth: 1, pixelHeight: 1, format: "png", pages: 1 }
    },
    derivatives: [],
    requestedLibrary: {
      title: libraryTitle, caption: "", notes: "", tags: ["moon"], origin: "imported",
      reviewStatus: "eligible", reuseScope: "owner_library", automaticReuseEnabled: true,
      contentCategories: ["fantasy"], favorite: false
    },
    sourceRecords: [{
      sourceKind: "campaign_zip", sourceAssetId, sourceRecordId: null, sourceKey: null,
      requestedLibrary: {
        title: libraryTitle, caption: "", notes: "", tags: ["moon"], origin: "imported",
        reviewStatus: "eligible", reuseScope: "owner_library", automaticReuseEnabled: true,
        contentCategories: ["fantasy"], favorite: false
      },
      bindingIntentKeys: options.contextIntentKey === undefined ? [] : [options.contextIntentKey]
    }],
    provenance: { kind: "import", importKind: "campaign_zip", importOperationId: crypto.randomUUID() },
    contextIntents,
    referencePolicy: { mode: "omit" }
  });
}

function legacyCommand(ownerUserId: string, idempotencyKey: string, contentLabel: string) {
  const bytes = new TextEncoder().encode(`14e3e1c:${contentLabel}`);
  return {
    owner: { ownerUserId },
    idempotencyKey: toAssetMutationIdempotencyKey(idempotencyKey),
    leaseOwner: "14e3e1c-legacy",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    original: {
      bytes,
      mimeType: "image/png" as const,
      byteLength: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex")
    },
    derivatives: [],
    provenance: { origin: "imported" as const }
  };
}

integration("Task 14e3e1c normalized publication repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reserves one canonical identity and replays one immutable request for the same owner and key", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const command = request(ownerUserId, `14e3e1c-replay-${crypto.randomUUID()}`, "cover-a");

    const reserved = await repository.reserveRequest(command);
    const replayed = await repository.reserveRequest(command);

    expect(replayed).toEqual(reserved);
    expect(reserved).toMatchObject({
      ownerUserId,
      canonicalContentHash: command.original.contentHash,
      lifecycle: "prepared",
      outcome: "reserved"
    });
    await expect(pool.query(
      `SELECT request.id,request.canonical_asset_id,request.lifecycle,
              arbitration.canonical_asset_id AS arbitration_asset_id,
              identity.lifecycle AS identity_lifecycle
         FROM asset_publication_requests request
         JOIN asset_publication_content_arbitrations arbitration
           ON arbitration.owner_user_id=request.owner_user_id
          AND arbitration.content_hash=request.canonical_content_hash
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id
          AND identity.owner_user_id=request.owner_user_id
        WHERE request.id=$1 AND request.owner_user_id=$2`,
      [reserved.requestId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{
      id: reserved.requestId,
      canonical_asset_id: reserved.canonicalAssetId,
      arbitration_asset_id: reserved.canonicalAssetId,
      lifecycle: "prepared",
      identity_lifecycle: "prepared"
    }] });
  });

  it("creates a request-owned reservation while converging later same-owner content on the first canonical identity", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const first = await repository.reserveRequest(request(ownerUserId, `14e3e1c-first-${crypto.randomUUID()}`, "cover-a"));
    const later = await repository.reserveRequest(request(ownerUserId, `14e3e1c-later-${crypto.randomUUID()}`, "cover-b"));

    expect(later).toMatchObject({
      canonicalAssetId: first.canonicalAssetId,
      canonicalContentHash: first.canonicalContentHash,
      lifecycle: "prepared",
      outcome: "reserved"
    });
    expect(later.requestId).not.toBe(first.requestId);
    await expect(pool.query(
      `SELECT count(*)::integer AS requests,
              count(DISTINCT canonical_asset_id)::integer AS canonical_assets
         FROM asset_publication_requests
        WHERE owner_user_id=$1 AND id=ANY($2::uuid[])`,
      [ownerUserId, [first.requestId, later.requestId]]
    )).resolves.toMatchObject({ rows: [{ requests: 2, canonical_assets: 1 }] });
    await expect(pool.query(
      `SELECT count(*)::integer AS initializations
         FROM asset_publication_library_initializations
        WHERE owner_user_id=$1 AND canonical_asset_id=$2`,
      [ownerUserId, first.canonicalAssetId]
    )).resolves.toMatchObject({ rows: [{ initializations: 1 }] });
  });

  it("preserves an explicit canonical-library revision when a later request reuses its content", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const contentLabel = `library-authority-${crypto.randomUUID()}`;
    const first = request(
      ownerUserId,
      `14e3e1e-library-first-${crypto.randomUUID()}`,
      "first-cover",
      contentLabel,
      { libraryTitle: "First request title" },
    );
    const firstReservation = await repository.reserveRequest(first);
    await pool.query(
      `INSERT INTO assets (
         id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,$3,'filesystem',$4,$5,$6,1,1,$7::jsonb)`,
      [
        firstReservation.canonicalAssetId,
        ownerUserId,
        first.original.contentHash,
        `test/14e3e1e/library/${crypto.randomUUID()}`,
        first.original.mimeType,
        first.original.byteLength,
        JSON.stringify({ format: "png", pages: 1 }),
      ],
    );
    await pool.query(
      `UPDATE asset_publication_identities
          SET lifecycle='published',result='{}'::jsonb,published_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [firstReservation.canonicalAssetId, ownerUserId],
    );
    await expect(createAssetApplication(createPostgresAssetRepositories(pool)).updateAssetMetadata(
      { ownerUserId, assetId: firstReservation.canonicalAssetId! },
      {
        expectedRevision: 1,
        title: "Authoritative edited title",
        idempotencyKey: toAssetMutationIdempotencyKey(`14e3e1e-library-edit-${crypto.randomUUID()}`),
      },
    )).resolves.toEqual({ assetId: firstReservation.canonicalAssetId, metadataRevision: 2 });

    const later = await repository.reserveRequest(request(
      ownerUserId,
      `14e3e1e-library-later-${crypto.randomUUID()}`,
      "later-cover",
      contentLabel,
      { libraryTitle: "Later request title" },
    ));

    expect(later.canonicalAssetId).toBe(firstReservation.canonicalAssetId);
    await expect(pool.query(
      `SELECT title,metadata_revision FROM asset_library_entries
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [firstReservation.canonicalAssetId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ title: "Authoritative edited title", metadata_revision: 2 }] });
    await expect(pool.query(
      `SELECT count(*)::integer AS initializations
         FROM asset_publication_library_initializations
        WHERE owner_user_id=$1 AND canonical_asset_id=$2`,
      [ownerUserId, firstReservation.canonicalAssetId],
    )).resolves.toMatchObject({ rows: [{ initializations: 1 }] });
  });

  it("reports a later request as recoverable when its canonical identity is pending cleanup", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const first = await repository.reserveRequest(request(ownerUserId, `14e3e1c-cleanup-first-${crypto.randomUUID()}`, "cover-a", "cleanup"));
    await pool.query(
      `UPDATE asset_publication_identities
          SET lifecycle='cleanup_pending'
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [first.canonicalAssetId, ownerUserId]
    );

    const later = await repository.reserveRequest(request(ownerUserId, `14e3e1c-cleanup-later-${crypto.randomUUID()}`, "cover-b", "cleanup"));

    expect(later).toMatchObject({
      canonicalAssetId: first.canonicalAssetId,
      canonicalContentHash: first.canonicalContentHash,
      lifecycle: "prepared",
      outcome: "recoverable"
    });
  });

  it("defers normalized reuse of a legacy prepared identity until technical metadata is verified", async () => {
    const legacy = createPostgresAssetPublicationRepository(pool, {} as never);
    const legacyIdentity = await legacy.prepareIdentity(legacyCommand(
      ownerUserId,
      `14e3e1c-legacy-${crypto.randomUUID()}`,
      "legacy-prepared"
    ));

    const normalizedRequest = request(
      ownerUserId,
      `14e3e1c-normalized-after-legacy-${crypto.randomUUID()}`,
      "cover-a",
      "legacy-prepared",
    );
    await expect(createPostgresNormalizedAssetPublicationRepository(pool).reserveRequest(normalizedRequest))
      .rejects.toThrow("asset_publication_verification_required");
    await expect(pool.query(
      `SELECT canonical_asset_id,verification_state
         FROM asset_publication_content_arbitrations
        WHERE owner_user_id=$1 AND content_hash=$2`,
      [ownerUserId, normalizedRequest.original.contentHash]
    )).resolves.toMatchObject({ rows: [{
      canonical_asset_id: legacyIdentity.assetId,
      verification_state: "verification_required"
    }] });
  });

  it("serializes an in-flight legacy reservation before normalized reuse is deferred", async () => {
    const legacy = createPostgresAssetPublicationRepository(pool, {} as never);
    const normalizedRepository = createPostgresNormalizedAssetPublicationRepository(pool);
    const contentLabel = `legacy-race-${crypto.randomUUID()}`;
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      const legacyIdentity = await legacy.prepareIdentityInTransaction(
        caller,
        legacyCommand(ownerUserId, `14e3e1c-legacy-race-${crypto.randomUUID()}`, contentLabel)
      );
      const normalized = normalizedRepository.reserveRequest(
        request(ownerUserId, `14e3e1c-normalized-race-${crypto.randomUUID()}`, "cover-a", contentLabel)
      );

      await expect(Promise.race([
        normalized.then(() => "released"),
        new Promise<string>((resolveBlocked) => setTimeout(() => resolveBlocked("blocked"), 100))
      ])).resolves.toBe("blocked");
      await caller.query("COMMIT");
      await expect(normalized).rejects.toThrow("asset_publication_verification_required");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
  });

  it("serializes two normalized callers on one same-owner canonical identity", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const contentLabel = `normalized-race-${crypto.randomUUID()}`;
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      const first = await repository.reserveRequestInTransaction(
        caller,
        request(ownerUserId, `14e3e1c-normalized-race-first-${crypto.randomUUID()}`, "cover-a", contentLabel)
      );
      const later = repository.reserveRequest(
        request(ownerUserId, `14e3e1c-normalized-race-later-${crypto.randomUUID()}`, "cover-b", contentLabel)
      );

      await expect(Promise.race([
        later.then(() => "released"),
        new Promise<string>((resolveBlocked) => setTimeout(() => resolveBlocked("blocked"), 100))
      ])).resolves.toBe("blocked");
      await caller.query("COMMIT");
      await expect(later).resolves.toMatchObject({
        canonicalAssetId: first.canonicalAssetId,
        outcome: "reserved"
      });
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
  });

  it("fails closed when legacy preparation encounters a normalized canonical identity", async () => {
    const contentLabel = `normalized-first-${crypto.randomUUID()}`;
    const normalized = await createPostgresNormalizedAssetPublicationRepository(pool).reserveRequest(
      request(ownerUserId, `14e3e1c-normalized-first-${crypto.randomUUID()}`, "cover-a", contentLabel)
    );
    const legacy = createPostgresAssetPublicationRepository(pool, {} as never);

    await expect(legacy.prepareIdentity(legacyCommand(
      ownerUserId,
      `14e3e1c-legacy-after-normalized-${crypto.randomUUID()}`,
      contentLabel
    ))).rejects.toThrow("asset_publication_canonical_reuse_required");
    await expect(pool.query(
      `SELECT count(*)::integer AS canonical_identities
         FROM asset_publication_content_arbitrations arbitration
         JOIN asset_publication_identities identity
           ON identity.asset_id=arbitration.canonical_asset_id
          AND identity.owner_user_id=arbitration.owner_user_id
        WHERE arbitration.owner_user_id=$1 AND arbitration.content_hash=$2`,
      [ownerUserId, normalized.canonicalContentHash]
    )).resolves.toMatchObject({ rows: [{ canonical_identities: 1 }] });
  });

  it("keeps a caller-transaction reservation uncommitted until the caller commits", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const command = request(ownerUserId, `14e3e1c-rollback-${crypto.randomUUID()}`, "cover-a", "rollback");
    const caller = await pool.connect();
    let reservationId = "";
    try {
      await caller.query("BEGIN");
      const reservation = await repository.reserveRequestInTransaction(caller, command);
      reservationId = reservation.requestId;
      await caller.query("ROLLBACK");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }

    await expect(pool.query(
      "SELECT id FROM asset_publication_requests WHERE id=$1 AND owner_user_id=$2",
      [reservationId, ownerUserId]
    )).resolves.toMatchObject({ rows: [] });
    await expect(repository.reserveRequest(command)).resolves.toMatchObject({
      ownerUserId,
      canonicalContentHash: command.original.contentHash,
      outcome: "reserved"
    });
  });

  it("rolls back request children and result when the caller rolls back attachment", async () => {
    const command = request(ownerUserId, `14e3e1e-attachment-rollback-${crypto.randomUUID()}`, "cover-a", "attachment-rollback");
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const reservation = await repository.reserveRequest(command);
    await pool.query(
      `INSERT INTO assets (
         id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,$3,'filesystem',$4,$5,$6,1,1,$7::jsonb)`,
      [
        reservation.canonicalAssetId,
        ownerUserId,
        command.original.contentHash,
        `test/14e3e1e/${crypto.randomUUID()}`,
        command.original.mimeType,
        command.original.byteLength,
        JSON.stringify({ format: "png", pages: 1 })
      ]
    );
    await pool.query(
      `UPDATE asset_publication_identities
          SET lifecycle='published',result='{}'::jsonb,published_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [reservation.canonicalAssetId, ownerUserId]
    );
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      await repository.attachRequestInTransaction(caller, command, {
        contexts: [],
        references: [],
        result: {
          assetId: reservation.canonicalAssetId!,
          mimeType: command.original.mimeType,
          byteLength: command.original.byteLength,
          contentHash: command.original.contentHash,
          pixelWidth: command.original.technicalMetadata.pixelWidth,
          pixelHeight: command.original.technicalMetadata.pixelHeight,
          derivatives: []
        }
      });
      await caller.query("ROLLBACK");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
    await expect(pool.query(
      `SELECT request.lifecycle,request.result,
              (SELECT count(*)::integer FROM asset_publication_request_sources source
                WHERE source.request_id=request.id AND source.owner_user_id=request.owner_user_id) AS sources,
              (SELECT count(*)::integer FROM asset_publication_request_results result
                WHERE result.request_id=request.id AND result.owner_user_id=request.owner_user_id) AS results
         FROM asset_publication_requests request
        WHERE request.id=$1 AND request.owner_user_id=$2`,
      [reservation.requestId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "prepared", result: null, sources: 0, results: 0 }] });
    const retry = await pool.connect();
    try {
      await retry.query("BEGIN");
      await repository.attachRequestInTransaction(retry, command, {
        contexts: [],
        references: [],
        result: {
          assetId: reservation.canonicalAssetId!,
          mimeType: command.original.mimeType,
          byteLength: command.original.byteLength,
          contentHash: command.original.contentHash,
          pixelWidth: command.original.technicalMetadata.pixelWidth,
          pixelHeight: command.original.technicalMetadata.pixelHeight,
          derivatives: []
        }
      });
      await retry.query("COMMIT");
    } finally {
      await retry.query("ROLLBACK").catch(() => undefined);
      retry.release();
    }
    await expect(pool.query(
      `SELECT request.lifecycle,
              (SELECT count(*)::integer FROM asset_publication_request_references reference
                WHERE reference.request_id=request.id AND reference.owner_user_id=request.owner_user_id) AS references
         FROM asset_publication_requests request
        WHERE request.id=$1 AND request.owner_user_id=$2`,
      [reservation.requestId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ lifecycle: "published", references: 0 }] });
  });

  it("persists request children and recovers its safe result through a fresh repository after finalization", async () => {
    const bytes = new TextEncoder().encode(`14e3e1d:original:${crypto.randomUUID()}`);
    const derivativeBytes = new TextEncoder().encode(`14e3e1d:thumbnail:${crypto.randomUUID()}`);
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `14e3e1d world ${crypto.randomUUID()}`]
    );
    const worldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Attachment world" } })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, worldVersion.rows[0]!.id, "Attachment campaign"]
    );
    const command = bindPrivateNormalizedAssetPublicationRequest({
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(`14e3e1d-attach-${crypto.randomUUID()}`),
      original: {
        bytes,
        mimeType: "image/png",
        byteLength: bytes.byteLength,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        technicalMetadata: { state: "verified", pixelWidth: 2, pixelHeight: 2, format: "png", pages: 1 }
      },
      derivatives: [{
        slot: { derivativeKind: "thumbnail", transformVersion: 1, pixelWidth: 1, pixelHeight: 1 },
        artifact: {
          bytes: derivativeBytes,
          mimeType: "image/png",
          byteLength: derivativeBytes.byteLength,
          contentHash: createHash("sha256").update(derivativeBytes).digest("hex"),
          technicalMetadata: { state: "verified", pixelWidth: 1, pixelHeight: 1, format: "png", pages: 1 }
        }
      }],
      requestedLibrary: {
        title: "Attached archive", caption: "", notes: "", tags: ["moon"], origin: "imported",
        reviewStatus: "eligible", reuseScope: "owner_library", automaticReuseEnabled: true,
        contentCategories: ["fantasy"], favorite: false
      },
      sourceRecords: [{
        sourceKind: "campaign_zip", sourceAssetId: "attached-cover", sourceRecordId: null, sourceKey: null,
        requestedLibrary: {
          title: "Attached archive", caption: "", notes: "", tags: ["moon"], origin: "imported",
          reviewStatus: "eligible", reuseScope: "owner_library", automaticReuseEnabled: true,
          contentCategories: ["fantasy"], favorite: false
        },
        bindingIntentKeys: ["attachment-context", "attachment-reference"]
      }, {
        sourceKind: "campaign_zip", sourceAssetId: "attached-cover-mirror", sourceRecordId: "mirror", sourceKey: "same-bytes",
        requestedLibrary: {
          title: "Attached archive mirror", caption: "", notes: "", tags: ["moon"], origin: "imported",
          reviewStatus: "eligible", reuseScope: "owner_library", automaticReuseEnabled: true,
          contentCategories: ["fantasy"], favorite: false
        },
        bindingIntentKeys: ["attachment-context", "attachment-reference"]
      }],
      provenance: { kind: "import", importKind: "campaign_zip", importOperationId: crypto.randomUUID() },
      contextIntents: [{
        intentKey: "attachment-context", targetType: "other", variantIndex: 0,
        worldId: world.rows[0]!.id, worldVersionId: worldVersion.rows[0]!.id, campaignId: campaign.rows[0]!.id
      }],
      referencePolicy: { mode: "attach", intents: [{
        intentKey: "attachment-reference", assetRole: "import_attachment", campaignId: campaign.rows[0]!.id
      }] }
    });
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const reservation = await repository.reserveRequest(command);
    await pool.query(
      `INSERT INTO assets (
         id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,$3,'filesystem',$4,$5,$6,2,2,$7::jsonb)`,
      [
        reservation.canonicalAssetId,
        ownerUserId,
        command.original.contentHash,
        `test/14e3e1d/${crypto.randomUUID()}`,
        command.original.mimeType,
        command.original.byteLength,
        JSON.stringify({ format: "png", pages: 1 })
      ]
    );
    const derivative = await pool.query<{ id: string }>(
      `INSERT INTO asset_derivatives (
         owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
         storage_driver,storage_path,mime_type,byte_length,content_hash
       ) VALUES ($1,$2,'thumbnail',1,1,1,'filesystem',$3,'image/png',$4,$5)
       RETURNING id`,
      [
        ownerUserId,
        reservation.canonicalAssetId,
        `test/14e3e1d/thumbnail/${crypto.randomUUID()}`,
        command.derivatives[0]!.artifact.byteLength,
        command.derivatives[0]!.artifact.contentHash
      ]
    );
    const context = await pool.query<{ id: string }>(
      `INSERT INTO asset_generation_contexts (
         owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,campaign_id,target_type,fiction_prompt,model
       ) VALUES ($1,$2,$1,$3,$4,$5,'other','Attachment context','test') RETURNING id`,
      [ownerUserId, reservation.canonicalAssetId, world.rows[0]!.id, worldVersion.rows[0]!.id, campaign.rows[0]!.id]
    );
    const reference = await pool.query<{ id: string }>(
      `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,asset_role)
       VALUES ($1,$2,$3,'import_attachment') RETURNING id`,
      [ownerUserId, reservation.canonicalAssetId, campaign.rows[0]!.id]
    );
    await pool.query(
      `UPDATE asset_publication_identities
          SET lifecycle='attached',result='{}'::jsonb,pending_finalization='[]'::jsonb
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [reservation.canonicalAssetId, ownerUserId]
    );
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      await repository.attachRequestInTransaction(caller, command, {
        contexts: [{ intentKey: "attachment-context", contextId: context.rows[0]!.id }],
        references: [{ intentKey: "attachment-reference", referenceId: reference.rows[0]!.id }],
        result: {
          assetId: reservation.canonicalAssetId!,
          mimeType: command.original.mimeType,
          byteLength: command.original.byteLength,
          contentHash: command.original.contentHash,
          pixelWidth: command.original.technicalMetadata.pixelWidth,
          pixelHeight: command.original.technicalMetadata.pixelHeight,
          derivatives: [{
            derivativeId: derivative.rows[0]!.id,
            derivativeKind: "thumbnail",
            transformVersion: 1,
            pixelWidth: 1,
            pixelHeight: 1
          }]
        }
      });
      await caller.query("COMMIT");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
    await pool.query(
      `UPDATE asset_publication_identities
          SET lifecycle='published',pending_finalization=NULL,published_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [reservation.canonicalAssetId, ownerUserId]
    );
    const restartedRepository = createPostgresNormalizedAssetPublicationRepository(pool);
    await expect(restartedRepository.completeRequest(command)).resolves.toMatchObject({
      assetId: reservation.canonicalAssetId,
      contentHash: command.original.contentHash
    });
    await expect(pool.query(
      `SELECT request.lifecycle,request.result,
              (SELECT count(*)::integer FROM asset_publication_request_sources source
                WHERE source.request_id=request.id AND source.owner_user_id=request.owner_user_id) AS sources,
              (SELECT count(*)::integer FROM asset_publication_request_contexts context
                WHERE context.request_id=request.id AND context.owner_user_id=request.owner_user_id) AS contexts,
              (SELECT count(*)::integer FROM asset_publication_request_references reference
                WHERE reference.request_id=request.id AND reference.owner_user_id=request.owner_user_id) AS references,
              (SELECT derivative_id FROM asset_publication_request_derivatives derivative
                WHERE derivative.request_id=request.id AND derivative.owner_user_id=request.owner_user_id) AS derivative_id
         FROM asset_publication_requests request
        WHERE request.id=$1 AND request.owner_user_id=$2`,
      [reservation.requestId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{
      lifecycle: "published",
      sources: 2,
      contexts: 1,
      references: 1,
      derivative_id: derivative.rows[0]!.id
    }] });
  });

  it("keeps same-content canonical identities owner-scoped", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const foreignOwner = (await pool.query<{ id: string }>(
      `INSERT INTO users (system_key,display_name,status)
       VALUES ($1,$2,'active') RETURNING id`,
      [`14e3e1c-owner:${crypto.randomUUID()}`, "14e3e1c owner"]
    )).rows[0]!.id;
    const contentLabel = `cross-owner-${crypto.randomUUID()}`;
    const local = await repository.reserveRequest(
      request(ownerUserId, `14e3e1c-local-${crypto.randomUUID()}`, "cover-a", contentLabel)
    );
    const foreign = await repository.reserveRequest(
      request(foreignOwner, `14e3e1c-foreign-${crypto.randomUUID()}`, "cover-a", contentLabel)
    );

    expect(foreign).toMatchObject({
      ownerUserId: foreignOwner,
      canonicalContentHash: local.canonicalContentHash,
      outcome: "reserved"
    });
    expect(foreign.canonicalAssetId).not.toBe(local.canonicalAssetId);
    await expect(pool.query(
      `SELECT count(*)::integer AS canonical_assets
         FROM asset_publication_content_arbitrations
        WHERE content_hash=$1`,
      [local.canonicalContentHash]
    )).resolves.toMatchObject({ rows: [{ canonical_assets: 2 }] });
  });

  it("rejects a foreign owner's generation-context child without persisting request children", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const localCommand = request(
      ownerUserId,
      `14e3e1e-local-context-${crypto.randomUUID()}`,
      "local-cover",
      `local-context-${crypto.randomUUID()}`,
    );
    const local = await repository.reserveRequest(localCommand);
    await pool.query(
      `INSERT INTO assets (
         id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,$3,'filesystem',$4,$5,$6,1,1,$7::jsonb)`,
      [
        local.canonicalAssetId,
        ownerUserId,
        localCommand.original.contentHash,
        `test/14e3e1e/local-context/${crypto.randomUUID()}`,
        localCommand.original.mimeType,
        localCommand.original.byteLength,
        JSON.stringify({ format: "png", pages: 1 }),
      ],
    );
    const foreignContext = await pool.query<{ id: string }>(
      `INSERT INTO asset_generation_contexts (
         owner_user_id,asset_id,created_by_user_id,target_type,fiction_prompt,model
       ) VALUES ($1,$2,$1,'other','Foreign context fence','test') RETURNING id`,
      [ownerUserId, local.canonicalAssetId],
    );
    const foreignOwner = (await pool.query<{ id: string }>(
      `INSERT INTO users (system_key,display_name,status)
       VALUES ($1,$2,'active') RETURNING id`,
      [`14e3e1e-foreign-context:${crypto.randomUUID()}`, "14e3e1e foreign context"],
    )).rows[0]!.id;
    const foreignCommand = request(
      foreignOwner,
      `14e3e1e-foreign-context-${crypto.randomUUID()}`,
      "foreign-cover",
      `foreign-context-${crypto.randomUUID()}`,
      { contextIntentKey: "foreign-context" },
    );
    const foreign = await repository.reserveRequest(foreignCommand);
    await pool.query(
      `INSERT INTO assets (
         id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,$3,'filesystem',$4,$5,$6,1,1,$7::jsonb)`,
      [
        foreign.canonicalAssetId,
        foreignOwner,
        foreignCommand.original.contentHash,
        `test/14e3e1e/foreign-context/${crypto.randomUUID()}`,
        foreignCommand.original.mimeType,
        foreignCommand.original.byteLength,
        JSON.stringify({ format: "png", pages: 1 }),
      ],
    );
    await pool.query(
      `UPDATE asset_publication_identities
          SET lifecycle='published',result='{}'::jsonb,published_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [foreign.canonicalAssetId, foreignOwner],
    );

    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      await expect(repository.attachRequestInTransaction(caller, foreignCommand, {
        contexts: [{ intentKey: "foreign-context", contextId: foreignContext.rows[0]!.id }],
        references: [],
        result: {
          assetId: foreign.canonicalAssetId!,
          mimeType: foreignCommand.original.mimeType,
          byteLength: foreignCommand.original.byteLength,
          contentHash: foreignCommand.original.contentHash,
          pixelWidth: foreignCommand.original.technicalMetadata.pixelWidth,
          pixelHeight: foreignCommand.original.technicalMetadata.pixelHeight,
          derivatives: [],
        },
      })).rejects.toThrow("asset_publication_request_children_mismatch");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
    await expect(pool.query(
      `SELECT
          (SELECT count(*)::integer FROM asset_publication_request_sources source
            WHERE source.request_id=request.id AND source.owner_user_id=request.owner_user_id) AS sources,
          (SELECT count(*)::integer FROM asset_publication_request_contexts context
            WHERE context.request_id=request.id AND context.owner_user_id=request.owner_user_id) AS contexts
         FROM asset_publication_requests request
        WHERE request.id=$1 AND request.owner_user_id=$2`,
      [foreign.requestId, foreignOwner],
    )).resolves.toMatchObject({ rows: [{ sources: 0, contexts: 0 }] });
  });

  it("rejects an idempotency-key replay whose immutable request fingerprint differs", async () => {
    const repository = createPostgresNormalizedAssetPublicationRepository(pool);
    const key = `14e3e1c-mismatch-${crypto.randomUUID()}`;
    await repository.reserveRequest(request(ownerUserId, key, "cover-a"));

    await expect(repository.reserveRequest(request(ownerUserId, key, "cover-b")))
      .rejects.toThrow("asset_publication_idempotency_mismatch");
  });
});
