import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { systemRecordEnvelopeSchema } from "../../packages/contracts/src/system-archives.js";
import { stageArchiveUpload } from "../../services/api/src/archive-io.js";
import { inspectSystemArchiveForPreview } from "../../services/runtime/src/system-archive-composition.js";
import { SystemArchivePreviewIndex } from "../../services/runtime/src/system-archive-preview-index.js";

const roots: string[] = [];
const ownerId = "11111111-1111-4111-8111-111111111111";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const limits = {
  maxCompressedBytes: 1024 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024,
  maxEntries: 20,
  maxManifestBytes: 4 * 1024,
  maxJsonEntryBytes: 1024 * 1024 * 1024,
  maxExpansionRatio: 1_000,
  maxOriginalImageBytes: 1024 * 1024,
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function oversizedMetadataArchive(path: "system.json" | "assets/assets.json"): Promise<Buffer> {
  const system = JSON.stringify({
    formatVersion: 1,
    sourceInstallationId: ownerId,
    sourceOwnerCount: 1,
    sourceOwner: { sourceId: ownerId, displayName: "Initial owner" },
    records: [],
  });
  const assets = JSON.stringify({ formatVersion: 1, assets: [] });
  const payloads = new Map<string, Buffer>([
    ["system.json", Buffer.from(system, "utf8")],
    ["assets/assets.json", Buffer.from(assets, "utf8")],
  ]);
  const original = payloads.get(path)!;
  payloads.set(path, Buffer.concat([
    original,
    Buffer.alloc(limits.maxManifestBytes + 1 - original.byteLength, 0x20),
  ]));
  const entries = [...payloads].map(([entryPath, bytes]) => ({
    path: entryPath,
    logicalType: entryPath === "system.json" ? "system" : "assets",
    mediaType: "application/json",
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
  }));
  const contentFingerprint = hash(JSON.stringify({
    originalAssetHashes: [],
    payloadHashes: entries.map((entry) => entry.sha256).sort(),
  }));
  const manifest = {
    format: "infinite-quest-archive",
    formatVersion: 1,
    archiveType: "system",
    createdAt: "2026-08-25T12:00:00.000Z",
    contentFingerprint,
    sourceApplication: "0.1.0",
    sourceMigration: "0079_resumable_system_archive_uploads",
    sourceInstallationId: ownerId,
    sourceOwnerCount: 1,
    sourceOwner: { sourceId: ownerId, displayName: "Initial owner" },
    omittedOperationalRows: 0,
    entries,
    payloads: entries.map((entry) => ({
      kind: entry.logicalType,
      path: entry.path,
      formatVersion: 1,
    })),
    assets: [],
  };
  const zip = new JSZip();
  for (const [entryPath, bytes] of payloads) zip.file(entryPath, bytes);
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function inspect(bytes: Buffer): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "infinitequest-system-preview-hardening-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  const staged = await stageArchiveUpload(Readable.from(bytes), root, limits);
  try {
    return await inspectSystemArchiveForPreview(staged, limits);
  } finally {
    await rm(staged.absolutePath, { force: true });
  }
}

describe("System Archive bounded preview metadata", () => {
  it.each(["system.json", "assets/assets.json"] as const)(
    "rejects oversized %s before allocating the configured 1 GiB generic JSON allowance",
    async (path) => {
      await expect(inspect(await oversizedMetadataArchive(path))).rejects.toMatchObject({
        code: "archive-limit-exceeded",
      });
    },
  );
});

describe("System Archive preview restore keys", () => {
  const worldContent = {
    schemaVersion: 1,
    world: {
      title: "Restore-key world",
      genre: "",
      tone: "",
      premise: "",
      backgroundStory: "",
      firstAction: "",
      rules: "",
    },
    entities: [],
    relationships: [],
    playableCharacters: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: { selectedCharacterId: null, initialLocation: "" },
  };
  const worldDraftEnvelope = (sourceId: string, worldId: string) => systemRecordEnvelopeSchema.parse({
    domain: "world-drafts",
    formatVersion: 1,
    sourceId,
    record: {
      sourceId,
      worldId,
      basedOnWorldVersionId: null,
      title: "Restore-key draft",
      revision: 0,
      content: worldContent,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    },
  });

  it("rejects a campaign-scoped prompt whose campaign is absent from the archive", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      const promptId = randomUUID();
      index.add(systemRecordEnvelopeSchema.parse({
        domain: "prompts",
        formatVersion: 1,
        sourceId: promptId,
        record: {
          sourceId: promptId,
          campaignId: randomUUID(),
          templateKey: "story_system",
          overrideText: "Campaign-specific guidance.",
          updatedAt: "2026-08-25T12:00:00.000Z",
        },
      }), new Set());

      expect(() => index.validate([])).toThrow(expect.objectContaining({
        code: "archive-world-mismatch",
      }));
    } finally {
      await index.close();
    }
  });

  it("rejects Chronicle memory turn authority from another campaign", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      const content = {
        entities: [], relationships: [], playableCharacters: [], assets: [],
        defaults: { selectedCharacterId: null },
      };
      index.add({ domain: "worlds", sourceId: "world-1", record: {} } as never, new Set());
      index.add({
        domain: "world-versions", sourceId: "version-1",
        record: { worldId: "world-1", versionNumber: 1, content },
      } as never, new Set());
      index.add({
        domain: "campaigns", sourceId: "campaign-1", record: { worldVersionId: "version-1" },
      } as never, new Set());
      index.add({
        domain: "campaigns", sourceId: "campaign-2", record: { worldVersionId: "version-1" },
      } as never, new Set());
      index.add({
        domain: "turns", sourceId: "turn-1", record: { campaignId: "campaign-1", turnNumber: 1 },
      } as never, new Set());
      index.add({
        domain: "chronicle", sourceId: "memory-1",
        record: { campaignId: "campaign-2", kind: "memory", turnId: "turn-1", memoryKind: "turn_fiction" },
      } as never, new Set());

      expect(() => index.validate([])).toThrow(expect.objectContaining({
        code: "archive-world-mismatch",
      }));
    } finally {
      await index.close();
    }
  });

  it("rejects duplicate narration-correction revisions for one turn", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      index.add({
        domain: "turn-corrections", sourceId: "correction-1",
        record: { turnId: "turn-1", revision: 3 },
      } as never, new Set());

      expect(() => index.add({
        domain: "turn-corrections", sourceId: "correction-2",
        record: { turnId: "turn-1", revision: 3 },
      } as never, new Set())).toThrow(expect.objectContaining({
        code: "archive-json-invalid",
      }));
    } finally {
      await index.close();
    }
  });

  it("rejects duplicate world-version numbers within a world", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      index.add({ domain: "worlds", sourceId: "world-1", record: {} } as never, new Set());
      const content = {
        entities: [], relationships: [], playableCharacters: [], assets: [],
        defaults: { selectedCharacterId: null },
      };
      index.add({
        domain: "world-versions",
        sourceId: "version-1",
        record: { worldId: "world-1", versionNumber: 3, content },
      } as never, new Set());
      expect(() => index.add({
        domain: "world-versions",
        sourceId: "version-2",
        record: { worldId: "world-1", versionNumber: 3, content },
      } as never, new Set())).toThrow(expect.objectContaining({ code: "archive-json-invalid" }));
    } finally {
      await index.close();
    }
  });

  it("rejects duplicate turn numbers within a campaign", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      index.add({
        domain: "turns",
        sourceId: randomUUID(),
        record: { campaignId: "campaign-1", turnNumber: 8 },
      } as never, new Set());
      expect(() => index.add({
        domain: "turns",
        sourceId: randomUUID(),
        record: { campaignId: "campaign-1", turnNumber: 8 },
      } as never, new Set())).toThrow(expect.objectContaining({ code: "archive-json-invalid" }));
    } finally {
      await index.close();
    }
  });

  it("rejects campaign-state authority whose source ID is not its campaign ID", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      expect(() => index.add({
        domain: "campaign-state",
        sourceId: "state-identity",
        record: { campaignId: "campaign-identity" },
      } as never, new Set())).toThrow(expect.objectContaining({ code: "archive-world-mismatch" }));
    } finally {
      await index.close();
    }
  });

  it("rejects a world draft whose source ID is not its destination world ID", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      const worldId = randomUUID();
      const sourceId = randomUUID();
      expect(() => index.add(
        worldDraftEnvelope(sourceId, worldId),
        new Set(),
      )).toThrow(expect.objectContaining({ code: "archive-world-mismatch" }));
    } finally {
      await index.close();
    }
  });

  it("rejects a second world-draft source ID for the same destination restore key", async () => {
    const index = await SystemArchivePreviewIndex.create();
    try {
      const worldId = randomUUID();
      index.add(worldDraftEnvelope(worldId, worldId), new Set());
      const secondSourceId = randomUUID();
      expect(() => index.add(
        worldDraftEnvelope(secondSourceId, worldId),
        new Set(),
      )).toThrow(expect.objectContaining({ code: "archive-world-mismatch" }));
    } finally {
      await index.close();
    }
  });
});
