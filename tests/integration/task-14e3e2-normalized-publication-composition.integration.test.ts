import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bindPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetRequestChildBindingsInput,
  type SafeNormalizedAssetPublicationResult
} from "../../packages/application/src/assets/private-normalized-asset-publication.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type OpaqueHandle = Readonly<Record<never, never>>;
type OpaqueFinalizationHandle = string;
type TestComposition = Readonly<{
  publication: Readonly<{
    reserve(input: Readonly<{
      request: PrivateNormalizedAssetPublicationRequest;
      leaseOwner: string;
      expiresAt: string;
    }>): Promise<OpaqueHandle>;
    attachInTransaction(
      database: DatabaseClient,
      reservation: OpaqueHandle,
      attachChildren: (
        result: SafeNormalizedAssetPublicationResult,
      ) => Promise<PrivateNormalizedAssetRequestChildBindingsInput>,
    ): Promise<Readonly<{
      result: SafeNormalizedAssetPublicationResult;
      finalization: OpaqueFinalizationHandle;
    }>>;
    discardAfterRollback(reservation: OpaqueHandle): Promise<void>;
    finalize(
      finalization: OpaqueFinalizationHandle,
      recovery?: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
    ): Promise<Readonly<{
      outcome: "published";
      result: SafeNormalizedAssetPublicationResult;
    }> | Readonly<{
      outcome: "recoverable";
      diagnostic: "asset_publication_finalization_recoverable";
    }>>;
  }>;
  close(): Promise<void>;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function request(
  ownerUserId: string,
  label: string,
  contentLabel = label,
): PrivateNormalizedAssetPublicationRequest {
  const bytes = new TextEncoder().encode(`14e3e2:${contentLabel}`);
  return bindPrivateNormalizedAssetPublicationRequest({
    owner: { ownerUserId },
    idempotencyKey: toAssetMutationIdempotencyKey(`14e3e2-${label}-${crypto.randomUUID()}`),
    original: {
      bytes,
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      contentHash: sha256(bytes),
      technicalMetadata: {
        state: "verified",
        pixelWidth: 1,
        pixelHeight: 1,
        format: "png",
        pages: 1
      }
    },
    derivatives: [],
    requestedLibrary: {
      title: `Asset ${label}`,
      caption: "",
      notes: "",
      tags: ["verified"],
      origin: "imported",
      reviewStatus: "eligible",
      reuseScope: "owner_library",
      automaticReuseEnabled: true,
      contentCategories: ["fantasy"],
      favorite: false
    },
    sourceRecords: [{
      sourceKind: "campaign_zip",
      sourceAssetId: label,
      sourceRecordId: null,
      sourceKey: null,
      requestedLibrary: {
        title: `Asset ${label}`,
        caption: "",
        notes: "",
        tags: ["verified"],
        origin: "imported",
        reviewStatus: "eligible",
        reuseScope: "owner_library",
        automaticReuseEnabled: true,
        contentCategories: ["fantasy"],
        favorite: false
      },
      bindingIntentKeys: []
    }],
    provenance: {
      kind: "import",
      importKind: "campaign_zip",
      importOperationId: crypto.randomUUID()
    },
    contextIntents: [],
    referencePolicy: { mode: "omit" }
  });
}

integration("Task 14e3e2 normalized publication composition", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<TestComposition>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e2-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e2-assets-"));
    await mkdir(join(assetRoot, "assets"));
  });

  afterEach(async () => {
    await Promise.all([...compositions].map((composition) => composition.close().catch(() => undefined)));
    compositions.clear();
  });

  afterAll(async () => {
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function compose(): Promise<TestComposition> {
    const loading = import("../../services/runtime/src/normalized-asset-publication-composition.js");
    await expect(loading).resolves.toHaveProperty("createPrivateNormalizedAssetPublicationComposition");
    const module = await loading;
    const composition = await module.createPrivateNormalizedAssetPublicationComposition(
      pool,
      { archiveRoot, assetRoot },
    ) as TestComposition;
    compositions.add(composition);
    return composition;
  }

  async function attachAndCommit(
    composition: TestComposition,
    command: PrivateNormalizedAssetPublicationRequest,
    leaseOwner: string,
  ): Promise<Awaited<ReturnType<TestComposition["publication"]["attachInTransaction"]>>> {
    const reservation = await composition.publication.reserve({
      request: command,
      leaseOwner,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      const attached = await composition.publication.attachInTransaction(
        caller,
        reservation,
        async () => ({ contexts: [], references: [] }),
      );
      await caller.query("COMMIT");
      return attached;
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
  }

  it("reserves verified work before a caller transaction and discards only its prepared filesystem work after rollback", async () => {
    const composition = await compose();
    const command = request(ownerUserId, `rollback-${crypto.randomUUID()}`);
    const reservation = await composition.publication.reserve({
      request: command,
      leaseOwner: "14e3e2-rollback",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(Object.keys(reservation)).toEqual([]);
    expect(Object.isFrozen(reservation)).toBe(true);
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      await composition.publication.attachInTransaction(
        caller,
        reservation,
        async () => ({ contexts: [], references: [] }),
      );
      await caller.query("ROLLBACK");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
    await composition.publication.discardAfterRollback(reservation);

    await expect(pool.query(
      `SELECT request.lifecycle,request.result,identity.lifecycle AS identity_lifecycle,
              (SELECT count(*)::integer FROM assets asset
                WHERE asset.id=request.canonical_asset_id AND asset.owner_user_id=request.owner_user_id) AS assets,
              (SELECT count(*)::integer FROM durable_filesystem_operations operation
                WHERE operation.asset_id=request.canonical_asset_id
                  AND operation.owner_user_id=request.owner_user_id
                  AND operation.lifecycle<>'cleaned') AS unfinished_operations
         FROM asset_publication_requests request
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id
          AND identity.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [ownerUserId, sha256(new TextEncoder().encode(command.idempotencyKey))],
    )).resolves.toMatchObject({ rows: [{
      lifecycle: "prepared",
      result: null,
      identity_lifecycle: "prepared",
      assets: 0,
      unfinished_operations: 0
    }] });
  });

  it("finalizes an exact opaque post-commit handle after recreating the composition", async () => {
    const first = await compose();
    const command = request(ownerUserId, `restart-${crypto.randomUUID()}`);
    const reservation = await first.publication.reserve({
      request: command,
      leaseOwner: "14e3e2-restart",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const caller = await pool.connect();
    let attached: Awaited<ReturnType<TestComposition["publication"]["attachInTransaction"]>>;
    try {
      await caller.query("BEGIN");
      attached = await first.publication.attachInTransaction(
        caller,
        reservation,
        async () => ({ contexts: [], references: [] }),
      );
      await caller.query("COMMIT");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }

    expect(typeof attached.finalization).toBe("string");
    expect(attached.finalization).not.toContain(attached.result.assetId);
    expect(attached.finalization).not.toContain(command.owner.ownerUserId);
    expect(attached.finalization).not.toContain(command.idempotencyKey);
    await first.close();
    compositions.delete(first);
    vi.resetModules();
    const restarted = await compose();
    const finalized = await restarted.publication.finalize(attached.finalization);

    expect(finalized).toEqual({ outcome: "published", result: attached.result });
    const stored = await pool.query<Readonly<{
      request_lifecycle: string;
      identity_lifecycle: string;
      storage_path: string;
      title: string;
      origin: string;
      initialization_state: string;
      unfinished_operations: number;
    }>>(
      `SELECT request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle,
              asset.storage_path,library.title,library.origin,initialization.state AS initialization_state,
              (SELECT count(*)::integer FROM durable_filesystem_operations operation
                WHERE operation.asset_id=asset.id AND operation.owner_user_id=asset.owner_user_id
                  AND operation.lifecycle<>'finalized') AS unfinished_operations
         FROM asset_publication_requests request
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
         JOIN assets asset ON asset.id=request.canonical_asset_id AND asset.owner_user_id=request.owner_user_id
         JOIN asset_library_entries library ON library.asset_id=asset.id AND library.owner_user_id=asset.owner_user_id
         JOIN asset_publication_library_initializations initialization
           ON initialization.request_id=request.id AND initialization.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [ownerUserId, sha256(new TextEncoder().encode(command.idempotencyKey))],
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      request_lifecycle: "published",
      identity_lifecycle: "published",
      title: command.requestedLibrary.title,
      origin: command.requestedLibrary.origin,
      initialization_state: "applied",
      unfinished_operations: 0
    })]);
    await expect(readFile(join(assetRoot, stored.rows[0]!.storage_path))).resolves.toEqual(
      Buffer.from(command.original.bytes),
    );
  });

  it("reuses one same-owner canonical asset without overwriting its first library initialization", async () => {
    const composition = await compose();
    const contentLabel = `reuse-content-${crypto.randomUUID()}`;
    const firstRequest = request(ownerUserId, `reuse-first-${crypto.randomUUID()}`, contentLabel);
    const secondRequest = request(ownerUserId, `reuse-second-${crypto.randomUUID()}`, contentLabel);
    const first = await attachAndCommit(composition, firstRequest, "14e3e2-reuse-first");
    expect(await composition.publication.finalize(first.finalization)).toEqual({
      outcome: "published",
      result: first.result
    });
    const second = await attachAndCommit(composition, secondRequest, "14e3e2-reuse-second");
    expect(await composition.publication.finalize(second.finalization)).toEqual({
      outcome: "published",
      result: second.result
    });

    expect(second.result.assetId).toBe(first.result.assetId);
    const stored = await pool.query<Readonly<{
      assets: number;
      requests: number;
      initializations: number;
      operations: number;
      title: string;
    }>>(
      `SELECT (SELECT count(*)::integer FROM assets
                WHERE owner_user_id=$1 AND content_hash=$2) AS assets,
              (SELECT count(*)::integer FROM asset_publication_requests
                WHERE owner_user_id=$1 AND canonical_asset_id=$3 AND lifecycle='published') AS requests,
              (SELECT count(*)::integer FROM asset_publication_library_initializations
                WHERE owner_user_id=$1 AND canonical_asset_id=$3) AS initializations,
              (SELECT count(*)::integer FROM durable_filesystem_operations
                WHERE owner_user_id=$1 AND asset_id=$3 AND purpose='asset_original') AS operations,
              (SELECT title FROM asset_library_entries
                WHERE owner_user_id=$1 AND asset_id=$3) AS title`,
      [ownerUserId, firstRequest.original.contentHash, first.result.assetId],
    );
    expect(stored.rows).toEqual([{
      assets: 1,
      requests: 2,
      initializations: 1,
      operations: 1,
      title: firstRequest.requestedLibrary.title
    }]);
  });

  it("keeps owner identities distinct while retaining one shared physical content target", async () => {
    const composition = await compose();
    const secondOwner = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('14e3e2 second owner') RETURNING id`,
    );
    const secondOwnerId = secondOwner.rows[0]!.id;
    const contentLabel = `cross-owner-${crypto.randomUUID()}`;
    const firstRequest = request(ownerUserId, `cross-first-${crypto.randomUUID()}`, contentLabel);
    const secondRequest = request(secondOwnerId, `cross-second-${crypto.randomUUID()}`, contentLabel);
    const first = await attachAndCommit(composition, firstRequest, "14e3e2-cross-first");
    await composition.publication.finalize(first.finalization);
    const second = await attachAndCommit(composition, secondRequest, "14e3e2-cross-second");
    await composition.publication.finalize(second.finalization);

    expect(second.result.assetId).not.toBe(first.result.assetId);
    const stored = await pool.query<Readonly<{
      id: string;
      owner_user_id: string;
      storage_path: string;
      lifecycle: string;
    }>>(
      `SELECT asset.id,asset.owner_user_id,asset.storage_path,identity.lifecycle
         FROM assets asset
         JOIN asset_publication_identities identity
           ON identity.asset_id=asset.id AND identity.owner_user_id=asset.owner_user_id
        WHERE asset.content_hash=$1
          AND asset.owner_user_id=ANY($2::uuid[])
        ORDER BY asset.owner_user_id`,
      [firstRequest.original.contentHash, [ownerUserId, secondOwnerId]],
    );
    expect(stored.rows).toHaveLength(2);
    expect(new Set(stored.rows.map((row) => row.owner_user_id))).toEqual(new Set([ownerUserId, secondOwnerId]));
    expect(new Set(stored.rows.map((row) => row.id)).size).toBe(2);
    expect(new Set(stored.rows.map((row) => row.storage_path)).size).toBe(1);
    expect(stored.rows.every((row) => row.lifecycle === "published")).toBe(true);
    await expect(readFile(join(assetRoot, stored.rows[0]!.storage_path))).resolves.toEqual(
      Buffer.from(firstRequest.original.bytes),
    );
  });

  it("retains another owner's committed shared bytes when the creating reservation later rolls back", async () => {
    const composition = await compose();
    const secondOwner = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('14e3e2 interleaving owner') RETURNING id`,
    );
    const secondOwnerId = secondOwner.rows[0]!.id;
    const contentLabel = `cross-owner-interleaving-${crypto.randomUUID()}`;
    const creatingRequest = request(ownerUserId, `interleaving-first-${crypto.randomUUID()}`, contentLabel);
    const retainedRequest = request(secondOwnerId, `interleaving-second-${crypto.randomUUID()}`, contentLabel);
    const creatingReservation = await composition.publication.reserve({
      request: creatingRequest,
      leaseOwner: "14e3e2-interleaving-first",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const retainedPublication = attachAndCommit(
      composition,
      retainedRequest,
      "14e3e2-interleaving-second",
    );

    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      await composition.publication.attachInTransaction(
        caller,
        creatingReservation,
        async () => ({ contexts: [], references: [] }),
      );
      await caller.query("ROLLBACK");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
    const retained = await retainedPublication;
    await composition.publication.finalize(retained.finalization);
    await composition.publication.discardAfterRollback(creatingReservation);

    const stored = await pool.query<Readonly<{
      storage_path: string;
      request_lifecycle: string;
      identity_lifecycle: string;
    }>>(
      `SELECT asset.storage_path,request.lifecycle AS request_lifecycle,
              identity.lifecycle AS identity_lifecycle
         FROM asset_publication_requests request
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
         JOIN assets asset
           ON asset.id=request.canonical_asset_id AND asset.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [secondOwnerId, sha256(new TextEncoder().encode(retainedRequest.idempotencyKey))],
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      request_lifecycle: "published",
      identity_lifecycle: "published"
    })]);
    await expect(readFile(join(assetRoot, stored.rows[0]!.storage_path))).resolves.toEqual(
      Buffer.from(retainedRequest.original.bytes),
    );
  });

  it("rejects discard after the caller commits the attachment and preserves its bytes", async () => {
    const composition = await compose();
    const command = request(ownerUserId, `committed-discard-${crypto.randomUUID()}`);
    const reservation = await composition.publication.reserve({
      request: command,
      leaseOwner: "14e3e2-committed-discard",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const caller = await pool.connect();
    let attached: Awaited<ReturnType<TestComposition["publication"]["attachInTransaction"]>>;
    try {
      await caller.query("BEGIN");
      attached = await composition.publication.attachInTransaction(
        caller,
        reservation,
        async () => ({ contexts: [], references: [] }),
      );
      await caller.query("COMMIT");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }

    await expect(composition.publication.discardAfterRollback(reservation))
      .rejects.toThrow("normalized_asset_publication_discard_unavailable");
    const stored = await pool.query<Readonly<{ storage_path: string; lifecycle: string }>>(
      `SELECT asset.storage_path,request.lifecycle
         FROM asset_publication_requests request
         JOIN assets asset
           ON asset.id=request.canonical_asset_id AND asset.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [ownerUserId, sha256(new TextEncoder().encode(command.idempotencyKey))],
    );
    expect(stored.rows).toEqual([expect.objectContaining({ lifecycle: "attached" })]);
    await expect(readFile(join(assetRoot, stored.rows[0]!.storage_path))).resolves.toEqual(
      Buffer.from(command.original.bytes),
    );
    await expect(composition.publication.finalize(attached.finalization)).resolves.toEqual({
      outcome: "published",
      result: attached.result
    });
  });

  it("keeps a post-commit finalization fault durable and recovers only through the exact handle", async () => {
    const first = await compose();
    const command = request(ownerUserId, `fault-${crypto.randomUUID()}`);
    const attached = await attachAndCommit(first, command, "14e3e2-fault");
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE owner_user_id=$1 AND asset_id=$2 AND lifecycle='attached'`,
      [ownerUserId, attached.result.assetId],
    );

    await expect(first.publication.finalize(attached.finalization)).resolves.toEqual({
      outcome: "recoverable",
      diagnostic: "asset_publication_finalization_recoverable"
    });
    await expect(pool.query(
      `SELECT request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle,
              (SELECT count(*)::integer FROM assets asset
                WHERE asset.id=request.canonical_asset_id AND asset.owner_user_id=request.owner_user_id) AS assets
         FROM asset_publication_requests request
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [ownerUserId, sha256(new TextEncoder().encode(command.idempotencyKey))],
    )).resolves.toMatchObject({ rows: [{
      request_lifecycle: "attached",
      identity_lifecycle: "attached",
      assets: 1
    }] });

    await first.close();
    compositions.delete(first);
    const restarted = await compose();
    await expect(restarted.publication.finalize(attached.finalization, {
      leaseOwner: "14e3e2-fault-recovery",
      leaseSeconds: 30
    })).resolves.toEqual({ outcome: "published", result: attached.result });
    await expect(pool.query(
      `SELECT request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle
         FROM asset_publication_requests request
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [ownerUserId, sha256(new TextEncoder().encode(command.idempotencyKey))],
    )).resolves.toMatchObject({ rows: [{
      request_lifecycle: "published",
      identity_lifecycle: "published"
    }] });
  });

  it("attaches only caller-created context and reference children in the parent transaction", async () => {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'14e3e2 child world') RETURNING id",
      [ownerUserId],
    );
    const worldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId],
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,'14e3e2 child campaign') RETURNING id",
      [ownerUserId, worldVersion.rows[0]!.id],
    );
    const base = request(ownerUserId, `children-${crypto.randomUUID()}`);
    const derivativeBytes = new TextEncoder().encode(`14e3e2:child-derivative:${crypto.randomUUID()}`);
    const command = bindPrivateNormalizedAssetPublicationRequest({
      owner: base.owner,
      idempotencyKey: base.idempotencyKey,
      original: base.original,
      derivatives: [{
        slot: { derivativeKind: "thumbnail", transformVersion: 1, pixelWidth: 1, pixelHeight: 1 },
        artifact: {
          bytes: derivativeBytes,
          mimeType: "image/png",
          byteLength: derivativeBytes.byteLength,
          contentHash: sha256(derivativeBytes),
          technicalMetadata: {
            state: "verified",
            pixelWidth: 1,
            pixelHeight: 1,
            format: "png",
            pages: 1
          }
        }
      }],
      requestedLibrary: base.requestedLibrary,
      sourceRecords: [{
        ...base.sourceRecords[0]!,
        bindingIntentKeys: ["child-context", "child-reference"]
      }],
      provenance: base.provenance,
      contextIntents: [{
        intentKey: "child-context",
        targetType: "other",
        variantIndex: 0,
        worldId: world.rows[0]!.id,
        worldVersionId: worldVersion.rows[0]!.id,
        campaignId: campaign.rows[0]!.id
      }],
      referencePolicy: { mode: "attach", intents: [{
        intentKey: "child-reference",
        assetRole: "import_attachment",
        campaignId: campaign.rows[0]!.id
      }] }
    });
    const composition = await compose();
    const reservation = await composition.publication.reserve({
      request: command,
      leaseOwner: "14e3e2-children",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const caller = await pool.connect();
    let contextId = "";
    let referenceId = "";
    let attached: Awaited<ReturnType<TestComposition["publication"]["attachInTransaction"]>>;
    try {
      await caller.query("BEGIN");
      attached = await composition.publication.attachInTransaction(caller, reservation, async (result) => {
        contextId = (await caller.query<{ id: string }>(
          `INSERT INTO asset_generation_contexts (
             owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,campaign_id,
             target_type,fiction_prompt,model
           ) VALUES ($1,$2,$1,$3,$4,$5,'other','14e3e2 child context','test') RETURNING id`,
          [ownerUserId, result.assetId, world.rows[0]!.id, worldVersion.rows[0]!.id, campaign.rows[0]!.id],
        )).rows[0]!.id;
        referenceId = (await caller.query<{ id: string }>(
          `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,asset_role)
           VALUES ($1,$2,$3,'import_attachment') RETURNING id`,
          [ownerUserId, result.assetId, campaign.rows[0]!.id],
        )).rows[0]!.id;
        return {
          contexts: [{ intentKey: "child-context", contextId }],
          references: [{ intentKey: "child-reference", referenceId }]
        };
      });
      await caller.query("COMMIT");
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
    await composition.publication.finalize(attached.finalization);
    expect(attached.result.derivatives).toEqual([expect.objectContaining({
      derivativeKind: "thumbnail",
      transformVersion: 1,
      pixelWidth: 1,
      pixelHeight: 1
    })]);

    await expect(pool.query(
      `SELECT context.context_id,reference.reference_id,derivative.derivative_id
         FROM asset_publication_requests request
         JOIN asset_publication_request_contexts context
           ON context.request_id=request.id AND context.owner_user_id=request.owner_user_id
         JOIN asset_publication_request_references reference
           ON reference.request_id=request.id AND reference.owner_user_id=request.owner_user_id
         JOIN asset_publication_request_derivatives derivative
           ON derivative.request_id=request.id AND derivative.owner_user_id=request.owner_user_id
        WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
      [ownerUserId, sha256(new TextEncoder().encode(command.idempotencyKey))],
    )).resolves.toMatchObject({ rows: [{
      context_id: contextId,
      reference_id: referenceId,
      derivative_id: attached.result.derivatives[0]!.derivativeId
    }] });
  });
});
