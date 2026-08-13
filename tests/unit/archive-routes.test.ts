import { EventEmitter } from "node:events";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { ZipArchive } from "archiver";
import { describe, expect, it, vi } from "vitest";
import { bindExportArtifactCleanup, commitPortableCampaignArchive, createLegacyArchiveAssetSource, openPortableCampaignExport, registerArchiveRoutes } from "../../services/api/src/archive-routes.js";
import { ArchiveError } from "../../services/api/src/archive-io.js";

const TEST_ARCHIVE_LIMITS = Object.freeze({
  maxCompressedBytes: 1024,
  maxUncompressedBytes: 4096,
  maxEntries: 10,
  maxExpansionRatio: 100,
  maxManifestBytes: 1024,
  maxJsonEntryBytes: 1024,
  maxOriginalImageBytes: 1024,
});

async function validZipBytes(): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const ended = once(archive, "end");
  archive.append(Buffer.from("{}", "utf8"), { name: "campaign.json" });
  await archive.finalize();
  await ended;
  return Buffer.concat(chunks);
}

function campaignArchiveMultipart(boundary: string, archive: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="campaign.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      "utf8",
    ),
    archive,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="destination"\r\n\r\n{"kind":"embedded"}\r\n--${boundary}--\r\n`,
      "utf8",
    ),
  ]);
}

describe("campaign archive route helpers", () => {
  it("routes direct Legacy Story imports through the durable private composition", async () => {
    const app = Fastify();
    await app.register(fastifyMultipart);
    const stageInput = vi.fn(async () => ({ stagedInput: "legacy-staged" as never }));
    const previewLegacyStory = vi.fn(async () => ({
      projection: { kind: "campaign", valid: true, title: "Legacy", duplicate: false, existingCampaignId: null, counts: { turns: 0, completeHistoryCharacters: 0, estimatedHistoryTokens: 0 }, warnings: [] },
      previewHandle: { token: "legacy-preview" as never, destination: { kind: "create_world" as const } },
      destination: { kind: "create_world" as const },
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const commit = vi.fn(async () => ({
      duplicate: false,
      result: { importId: "import", worldId: "world", worldVersionId: "version", campaignId: "campaign", stats: {} },
    }));
    try {
      await app.register(registerArchiveRoutes, {
        pool: { query: vi.fn() } as never,
        config: {
          archiveStorageRoot: "/tmp",
          security: { apiImportBodyLimitBytes: 1024 },
          campaignArchiveLimits: TEST_ARCHIVE_LIMITS,
        } as never,
        assetStore: {} as never,
        memory: {} as never,
        portable: { stageInput, previewLegacyStory, commit } as never,
        resolveOwner: async () => ({ ownerUserId: "44444444-4444-4444-8444-444444444444" }),
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story",
        payload: { sourceName: "legacy.story", story: { world: { title: "Legacy" }, turns: [] } },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ campaignId: "campaign", worldId: "world" });
      expect(previewLegacyStory).toHaveBeenCalledWith(expect.objectContaining({
        ownerUserId: "44444444-4444-4444-8444-444444444444",
        kind: "legacy_story",
        destination: { kind: "create_world" },
      }));
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({
        kind: "legacy_story",
        destination: { kind: "create_world" },
      }));
    } finally {
      await app.close();
    }
  });

  it("stages a multipart Campaign Archive preview into durable portable authority", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-campaign-preview-"));
    const app = Fastify();
    await app.register(fastifyMultipart);
    const stagedBytes: number[] = [];
    const stageInput = vi.fn(async (input: { source: AsyncIterable<Uint8Array> }) => {
      for await (const chunk of input.source) stagedBytes.push(...chunk);
      return { stagedInput: "staged-input" as never };
    });
    const previewCampaignZip = vi.fn(async () => ({
      projection: {
        valid: true,
        archiveType: "campaign",
        formatVersion: 1,
        contentFingerprint: "a".repeat(64),
        campaign: { title: "Preview campaign", sourceCampaignId: "11111111-1111-4111-8111-111111111111", acceptedTurnCount: 0, activeTurnNumber: 0, selectedCharacter: null },
        world: { title: "Preview world", sourceWorldId: "22222222-2222-4222-8222-222222222222", sourceWorldVersionId: "33333333-3333-4333-8333-333333333333", versionNumber: 1 },
        chronicle: { memoryCount: 0, summaryCount: 0 },
        assets: { originalCount: 0, totalBytes: 0 },
        destination: { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null },
        providerDataIncluded: false,
        warnings: [],
      },
      previewHandle: { token: "b".repeat(64) as never },
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    try {
      await app.register(registerArchiveRoutes, {
        pool: { query: vi.fn() } as never,
        config: {
          archiveStorageRoot: archiveRoot,
          security: { apiImportBodyLimitBytes: 1024 },
          campaignArchiveLimits: TEST_ARCHIVE_LIMITS,
        } as never,
        assetStore: {} as never,
        memory: {} as never,
        portable: { stageInput, previewCampaignZip } as never,
        resolveOwner: async () => ({ ownerUserId: "44444444-4444-4444-8444-444444444444" }),
      } as never);
      const boundary = "campaign-preview-boundary";
      const archive = await validZipBytes();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: campaignArchiveMultipart(boundary, archive),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ previewToken: "b".repeat(64), campaign: { title: "Preview campaign" } });
      expect(stagedBytes).toEqual([...archive]);
      expect(previewCampaignZip).toHaveBeenCalledWith(expect.objectContaining({
        ownerUserId: "44444444-4444-4444-8444-444444444444",
        kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" },
      }));
    } finally {
      await app.close();
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["archive_truncated", "archive-format-unrecognized"],
    ["archive_format_invalid", "archive-format-unrecognized"],
    ["archive_link_denied", "archive-entry-unsafe"],
    ["archive_path_invalid", "archive-entry-unsafe"],
    ["archive_entry_limit_exceeded", "archive-limit-exceeded"],
    ["archive_size_limit_exceeded", "archive-limit-exceeded"],
    ["archive_unavailable", "archive-checksum-mismatch"],
  ])("maps durable preview diagnostic %s to public archive error %s", async (diagnostic, publicCode) => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-campaign-preview-error-"));
    const app = Fastify();
    await app.register(fastifyMultipart);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ArchiveError) {
        return reply.code(error.statusCode).send({ error: error.code, details: error.details ?? {} });
      }
      throw error;
    });
    const stageInput = vi.fn(async (input: { source: AsyncIterable<Uint8Array> }) => {
      for await (const _chunk of input.source) {
        // Consume the upload exactly as the durable staging adapter does.
      }
      return { stagedInput: "staged-input" as never };
    });
    const previewCampaignZip = vi.fn(async () => {
      throw new Error(diagnostic);
    });
    try {
      await app.register(registerArchiveRoutes, {
        pool: { query: vi.fn() } as never,
        config: {
          archiveStorageRoot: archiveRoot,
          security: { apiImportBodyLimitBytes: 1024 },
          campaignArchiveLimits: TEST_ARCHIVE_LIMITS,
        } as never,
        assetStore: {} as never,
        memory: {} as never,
        portable: { stageInput, previewCampaignZip } as never,
        resolveOwner: async () => ({ ownerUserId: "44444444-4444-4444-8444-444444444444" }),
      } as never);
      const boundary = "campaign-preview-error-boundary";
      const archive = await validZipBytes();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: campaignArchiveMultipart(boundary, archive),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: publicCode, details: {} });
    } finally {
      await app.close();
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  it("redeems a durable Campaign Archive preview using its exact owner and destination", async () => {
    const commit = vi.fn(async () => ({
      duplicate: false,
      result: { campaignId: "campaign", worldId: "world", worldVersionId: "version", importId: "import", stats: {} },
    }));
    const destination = {
      kind: "existing_world_version" as const,
      worldId: "33333333-3333-4333-8333-333333333333",
      worldVersionId: "44444444-4444-4444-8444-444444444444",
    };

    const committed = await commitPortableCampaignArchive({
      portable: { commit } as never,
      owner: { ownerUserId: "11111111-1111-4111-8111-111111111111" },
      previewToken: "a".repeat(64),
      destination,
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      kind: "campaign_zip",
      destination,
      previewHandle: expect.objectContaining({ destination, token: "a".repeat(64) }),
      idempotencyKey: expect.stringMatching(new RegExp(`^campaign-archive:${"a".repeat(64)}:[0-9a-f-]{36}$`, "u")),
    }));
    expect(committed).toMatchObject({ duplicate: false, result: { campaignId: "campaign" } });
  });

  it("serves the live campaign export route from the private export capability", async () => {
    const app = Fastify();
    const createCampaignExport = vi.fn(async () => ({
      retrieval: "retrieval" as never,
      contentType: "application/zip" as const,
      byteLength: 3,
    }));
    const finalize = vi.fn(async () => undefined);
    const openExportSession = vi.fn(async () => ({
      chunks: (async function* () { yield new Uint8Array([4, 5, 6]); })(),
      finalize,
    }));
    await app.register(registerArchiveRoutes, {
      pool: { query: vi.fn(async () => ({ rows: [{ world_id: "33333333-3333-4333-8333-333333333333", world_version_id: "44444444-4444-4444-8444-444444444444" }] })) } as never,
      config: {
        security: { apiImportBodyLimitBytes: 1024 },
        campaignArchiveLimits: TEST_ARCHIVE_LIMITS,
      } as never,
      assetStore: {} as never,
      memory: {} as never,
      portable: { createCampaignExport, openExportSession } as never,
      resolveOwner: async () => ({ ownerUserId: "11111111-1111-4111-8111-111111111111" }),
    } as never);

    const response = await app.inject({ method: "GET", url: "/api/v1/campaigns/22222222-2222-4222-8222-222222222222/export" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="infinite-quest-campaign.zip"');
    expect(response.rawPayload).toEqual(Buffer.from([4, 5, 6]));
    expect(createCampaignExport).toHaveBeenCalledOnce();
    expect(openExportSession).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith("eof");
    await app.close();
  });

  it("redeems a campaign export through the owner-scoped private stream capability", async () => {
    const response = new EventEmitter();
    const finalize = vi.fn(async () => undefined);
    const createCampaignExport = vi.fn(async () => ({
      retrieval: "retrieval" as never,
      contentType: "application/zip" as const,
      byteLength: 3,
    }));
    const openExportSession = vi.fn(async () => ({
      chunks: (async function* () { yield new Uint8Array([1, 2, 3]); })(),
      finalize,
    }));

    const exportView = await openPortableCampaignExport({
      portable: { createCampaignExport, openExportSession } as never,
      owner: { ownerUserId: "11111111-1111-4111-8111-111111111111" },
      campaignId: "22222222-2222-4222-8222-222222222222",
      worldId: "33333333-3333-4333-8333-333333333333",
      worldVersionId: "44444444-4444-4444-8444-444444444444",
      response,
    });
    const bytes: Buffer[] = [];
    exportView.stream.on("data", (chunk: Buffer) => bytes.push(chunk));
    await once(exportView.stream, "end");

    expect(Buffer.concat(bytes)).toEqual(Buffer.from([1, 2, 3]));
    expect(createCampaignExport).toHaveBeenCalledWith({
      owner: { ownerUserId: "11111111-1111-4111-8111-111111111111" },
      campaignId: "22222222-2222-4222-8222-222222222222",
    });
    expect(openExportSession).toHaveBeenCalledWith({
      owner: { ownerUserId: "11111111-1111-4111-8111-111111111111" },
      exportKind: "campaign_zip",
      campaignId: "22222222-2222-4222-8222-222222222222",
      worldId: "33333333-3333-4333-8333-333333333333",
      worldVersionId: "44444444-4444-4444-8444-444444444444",
      retrieval: "retrieval",
    });
    expect(finalize).toHaveBeenCalledWith("eof");
    expect(exportView).toMatchObject({ contentType: "application/zip", byteLength: 3 });
  });

  it("defers each legacy ZIP asset read until the importer requests that asset", async () => {
    const reads: string[] = [];
    const assets = createLegacyArchiveAssetSource(
      ["assets/first.png", "assets/second.png"],
      async (path) => {
        reads.push(path);
        return Buffer.from(path, "utf8");
      }
    );

    expect([...assets.assetIds()]).toEqual(["first", "second"]);
    expect(reads).toEqual([]);

    await expect(assets.read("second")).resolves.toEqual(Buffer.from("assets/second.png", "utf8"));
    expect(reads).toEqual(["assets/second.png"]);
  });

  it("resolves nested legacy asset entries by UUID stem and original filename", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const assets = createLegacyArchiveAssetSource(
      ["backup/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg"],
      async () => bytes
    );

    expect([...assets.assetIds()]).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    await expect(assets.read("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).resolves.toEqual(bytes);
    await expect(assets.read("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg")).resolves.toEqual(bytes);
  });

  it("waits for the export stream to close after an aborted response and retries bounded cleanup", async () => {
    const stream = new Readable({ read() {}, emitClose: false });
    const response = new EventEmitter();
    let attempts = 0;

    bindExportArtifactCleanup(stream, response, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated Windows sharing violation");
    });

    response.emit("close");
    expect(stream.destroyed).toBe(true);
    expect(attempts).toBe(0);

    stream.emit("close");
    await expect.poll(() => attempts).toBe(2);
  });

  it("bounds failed export cleanup attempts and logs only a safe error code", async () => {
    const stream = new Readable({ read() {}, emitClose: false });
    const response = new EventEmitter();
    const logs: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    let attempts = 0;

    bindExportArtifactCleanup(
      stream,
      response,
      async () => {
        attempts += 1;
        throw Object.assign(new Error("C:\\private\\archive.zip"), { code: "EPERM" });
      },
      { warn: (bindings, message) => { logs.push({ bindings, message }); } }
    );

    stream.emit("close");
    await expect.poll(() => attempts).toBe(3);
    expect(logs).toEqual([
      { bindings: { attempt: 1, maxAttempts: 3, errorCode: "EPERM" }, message: "campaign export artifact cleanup failed" },
      { bindings: { attempt: 2, maxAttempts: 3, errorCode: "EPERM" }, message: "campaign export artifact cleanup failed" },
      { bindings: { attempt: 3, maxAttempts: 3, errorCode: "EPERM" }, message: "campaign export artifact cleanup failed" }
    ]);
    expect(JSON.stringify(logs)).not.toContain("private");
  });
});
