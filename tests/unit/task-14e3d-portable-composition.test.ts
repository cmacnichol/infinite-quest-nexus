import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  PORTABLE_IMPORT_FAMILIES,
  canonicalPortableImportAuthority,
  safePortableImportProgress,
  type PortableCanonicalImportAuthority
} from "../../packages/application/src/imports/private-portable-composition.js";
import { toPortableStagedInput } from "../../packages/application/src/imports/types.js";
import { canonicalArchiveJson, canonicalizeWorldContent } from "../../packages/contracts/src/index.js";
import { calculateContentFingerprint } from "../../packages/contracts/src/archives-node.js";
import {
  createPortableFamilyPreviewAdapter,
  type PortableProviderWorldConversionPort
} from "../../services/runtime/src/portable-import-export-composition.js";

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const sourceCampaignId = "00000000-0000-4000-8000-000000000101";
const sourceWorldId = "00000000-0000-4000-8000-000000000102";
const sourceWorldVersionId = "00000000-0000-4000-8000-000000000103";
const sourceTurnId = "00000000-0000-4000-8000-000000000104";
const sourceAssetId = "00000000-0000-4000-8000-000000000105";
const duplicateSourceAssetId = "00000000-0000-4000-8000-000000000106";
const portableSetId = "00000000-0000-4000-8000-000000000107";
const transientSetId = "00000000-0000-4000-8000-000000000108";
const PNG_1X1 = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

async function archive(files: Readonly<Record<string, string | Uint8Array>>, permissions?: number): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) {
    zip.file(name, value, permissions === undefined ? undefined : { unixPermissions: permissions });
  }
  return zip.generateAsync({ type: "uint8array", platform: "UNIX" });
}

async function currentCampaignArchive(): Promise<Uint8Array> {
  const contentHash = createHash("sha256").update(PNG_1X1).digest("hex");
  const assetPath = `assets/sha256/${contentHash.slice(0, 2)}/${contentHash}.png`;
  const worldContent = canonicalizeWorldContent({
    world: { title: "Manifest world" },
    playableCharacters: [{ id: "hero", name: "Hero" }]
  });
  const worldHash = createHash("sha256")
    .update(canonicalArchiveJson(worldContent))
    .digest("hex");
  const campaign = {
    formatVersion: 3,
    campaign: { sourceCampaignId, sourceWorldVersionId, title: "Manifest campaign" },
    world: { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId },
    turns: [{ id: sourceTurnId, turnNumber: 1, action: "Look", narration: "A restored hall.", imageUrl: `/api/v1/assets/${sourceAssetId}` }],
    archiveRecords: {
      formatVersion: 1,
      characterProfileEdits: [],
      stateEdits: [],
      worldMigrations: [{
        from_world_version_id: "00000000-0000-4000-8000-000000000199",
        to_world_version_id: sourceWorldVersionId
      }],
      illustrationConfig: null,
      illustrationSets: [
        { id: portableSetId, turn_id: sourceTurnId },
        { id: transientSetId, turn_id: null }
      ],
      illustrationSegments: [
        { id: "00000000-0000-4000-8000-000000000109", illustration_set_id: portableSetId, turn_id: sourceTurnId },
        { id: "00000000-0000-4000-8000-000000000110", illustration_set_id: transientSetId, turn_id: null }
      ],
      costs: []
    }
  };
  const world = {
    canonicalHash: worldHash,
    sourceWorldId,
    sourceWorldVersionId,
    versionNumber: 1,
    content: worldContent
  };
  const chronicle = {
    formatVersion: 1,
    memories: [{ token_estimate: 6, token_count: 7 }],
    summaries: [{ token_estimate: 8 }]
  };
  const library = {
    title: "Archive hall", caption: "", notes: "", tags: ["hall"], origin: "imported",
    reviewStatus: "eligible", reuseScope: "campaign", automaticReuseEnabled: false,
    contentCategories: ["location"], favorite: true, archivedAt: null
  } as const;
  const createdAt = "2030-01-01T00:00:00.000Z";
  const assets = [
    {
      sourceAssetId, contentHash, archivePath: assetPath, mimeType: "image/png", byteLength: PNG_1X1.byteLength,
      pixelWidth: 1, pixelHeight: 1, technicalMetadata: { format: "png" }, library, createdAt,
      bindings: [{ role: "turn_illustration", campaignId: sourceCampaignId, turnId: sourceTurnId }]
    },
    {
      sourceAssetId: duplicateSourceAssetId, contentHash, archivePath: assetPath, mimeType: "image/png", byteLength: PNG_1X1.byteLength,
      pixelWidth: 1, pixelHeight: 1, technicalMetadata: { format: "png" }, library, createdAt,
      bindings: [{ role: "imported_attachment", campaignId: sourceCampaignId, turnId: null }]
    }
  ];
  const jsonEntries = [
    ["campaign.json", campaign, "campaign"],
    ["world.json", world, "world"],
    ["chronicle.json", chronicle, "chronicle"],
    ["assets/assets.json", { formatVersion: 1, assets }, "assets"]
  ] as const;
  const files: Record<string, string | Uint8Array> = { [assetPath]: PNG_1X1 };
  const entries: Array<{ path: string; logicalType: string; mediaType: string; byteLength: number; sha256: string }> = jsonEntries.map(([path, value, logicalType]) => {
    const body = canonicalArchiveJson(value);
    files[path] = body;
    return {
      path, logicalType, mediaType: "application/json", byteLength: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex")
    };
  });
  entries.push({
    path: assetPath, logicalType: "asset-original", mediaType: "image/png",
    byteLength: PNG_1X1.byteLength, sha256: contentHash
  });
  files["manifest.json"] = canonicalArchiveJson({
    format: "infinite-quest-archive",
    formatVersion: 1,
    archiveType: "campaign",
    createdAt,
    contentFingerprint: calculateContentFingerprint({
      payloadHashes: entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256),
      originalAssetHashes: [contentHash]
    }),
    campaignId: sourceCampaignId,
    worldId: sourceWorldId,
    worldVersionId: sourceWorldVersionId,
    entries,
    payloads: jsonEntries.map(([path, _value, kind]) => ({ kind, path, formatVersion: 1 })),
    assets
  });
  return archive(files);
}

async function* chunks(bytes: Uint8Array, size: number, counter?: { value: number }): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    counter && (counter.value += 1);
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
  }
}

function campaignCommand() {
  return {
    ownerUserId,
    stagedInput: toPortableStagedInput("staged-campaign"),
    destination: { kind: "embedded", operation: "create_world" } as const,
    kind: "campaign_zip" as const
  };
}

const targetContent = canonicalizeWorldContent({
  world: { title: "Target world" },
  playableCharacters: [{ id: "hero", name: "Hero" }]
});

const providerAdapter: PortableProviderWorldConversionPort = {
  async convertTemplate(input) {
    return {
      world: {
        format: "infinite-quest-world",
        formatVersion: 1,
        title: input.template.title || "Converted world",
        content: canonicalizeWorldContent({
          world: { title: input.template.title || "Converted world" },
          playableCharacters: [{ id: "converted-character", name: "Converted character" }]
        })
      },
      providerConfigurationFingerprint: "b".repeat(64)
    };
  }
};

const previewAdapter = createPortableFamilyPreviewAdapter(providerAdapter, {
  async readTargetWorldVersion(input) {
    return { ...input, ownerUserId: input.owner.ownerUserId, content: targetContent };
  }
});

async function* utf8(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

describe("Task 14e3d private portable composition contract", () => {
  it("enumerates every import family without a generic parser escape hatch", () => {
    expect(PORTABLE_IMPORT_FAMILIES).toEqual([
      "campaign_zip",
      "legacy_story",
      "infinite_worlds",
      "cyoa",
      "world_json",
      "world_text",
      "story_text"
    ]);
  });

  it("canonicalizes replay authority independently of object key order", () => {
    const left: PortableCanonicalImportAuthority = {
      kind: "world_text",
      destination: { kind: "create_world" },
      normalizedPayload: { title: "Arden", sourceText: "A green world" },
      sourceInstallationId: "install-a",
      sourceRecordId: null,
      selectedCharacterId: null,
      providerConfigurationFingerprint: "a".repeat(64)
    };
    const right: PortableCanonicalImportAuthority = {
      providerConfigurationFingerprint: "a".repeat(64),
      selectedCharacterId: null,
      sourceRecordId: null,
      sourceInstallationId: "install-a",
      normalizedPayload: { sourceText: "A green world", title: "Arden" },
      destination: { kind: "create_world" },
      kind: "world_text"
    };

    expect(canonicalPortableImportAuthority(left)).toBe(canonicalPortableImportAuthority(right));
  });

  it("projects only bounded safe progress fields", () => {
    expect(safePortableImportProgress({
      operationId: "private-operation",
      ownerUserId: "private-owner",
      phase: "decoding",
      percentage: 37,
      diagnosticCode: "archive_format_invalid",
      workVersion: 4,
      status: "running",
      leaseOwner: "private-worker",
      leaseId: "private-lease",
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2029-01-01T00:00:00.000Z"
    })).toEqual({
      phase: "decoding",
      percentage: 37,
      diagnosticCode: "archive_format_invalid",
      workVersion: 4,
      status: "running",
      updatedAt: "2029-01-01T00:00:00.000Z"
    });
  });

  it("streams Campaign ZIP input across many chunks and drains ignored entries", async () => {
    const bytes = await archive({
      "campaign.json": JSON.stringify({ world: { title: "Arden" }, turns: [] }),
      "ignored.txt": "ignored-but-drained",
      "assets/assets.json": JSON.stringify({ assets: [] })
    });
    const counter = { value: 0 };
    const result = await previewAdapter.previewCampaignZip(chunks(bytes, 7, counter), campaignCommand());

    expect(counter.value).toBeGreaterThan(10);
    expect(result.authority.normalizedPayload).toMatchObject({ sourceName: "campaign.zip" });
    expect(result.projection).toMatchObject({ archiveType: "campaign", valid: true });
  });

  it("decodes the current manifest archive as authoritative rich payload and groups shared originals", async () => {
    const bytes = await currentCampaignArchive();
    const contentHash = createHash("sha256").update(PNG_1X1).digest("hex");
    const result = await previewAdapter.previewCampaignZip(chunks(bytes, 17), campaignCommand());

    expect(result.authority.normalizedPayload).toMatchObject({
      sourceName: "campaign.zip",
      archiveFormat: "manifest_v1",
      campaign: {
        campaign: { sourceCampaignId },
        archiveRecords: {
          formatVersion: 1,
          illustrationSets: [{ id: portableSetId }],
          illustrationSegments: [{ illustration_set_id: portableSetId }]
        }
      },
      world: { sourceWorldId, sourceWorldVersionId },
      chronicle: {
        formatVersion: 1,
        memories: [{ lexicalUnitEstimate: 6, lexicalUnitCount: 7 }],
        summaries: [{ lexicalUnitEstimate: 8 }]
      },
      assetRecords: [
        { sourceAssetId, bindings: [{ role: "turn_illustration", turnId: sourceTurnId }] },
        { sourceAssetId: duplicateSourceAssetId, bindings: [{ role: "imported_attachment" }] }
      ]
    });
    expect(JSON.stringify(result.authority.normalizedPayload)).not.toMatch(/(?:^|["_])token(?:["_]|$)/iu);
    expect(result.projection).toMatchObject({
      campaign: { sourceCampaignId, acceptedTurnCount: 1 },
      world: { sourceWorldId, sourceWorldVersionId },
      assets: { originalCount: 1, totalBytes: PNG_1X1.byteLength },
      warnings: [
        expect.stringContaining("Migration history references source world versions"),
        expect.stringContaining("Ignored 1 turnless illustration set and 1 turnless illustration segment")
      ]
    });

    const inventory = await previewAdapter.extractCampaignZipAssets(chunks(bytes, 19), result.authority);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      sourceAssetIds: [sourceAssetId, duplicateSourceAssetId],
      records: [
        { sourceAssetId, library: { title: "Archive hall" } },
        { sourceAssetId: duplicateSourceAssetId }
      ],
      artifact: { contentHash, byteLength: PNG_1X1.byteLength, mimeType: "image/png" }
    });
  });

  it("adapts a legacy Campaign ZIP with an explicit turn-image binding", async () => {
    const bytes = await archive({
      "campaign.json": JSON.stringify({
        campaign: { title: "Legacy ZIP", sourceCampaignId, sourceWorldVersionId },
        world: { title: "Legacy ZIP world" },
        turns: [{ id: sourceTurnId, narration: "Legacy image", imageUrl: `/api/v1/assets/${sourceAssetId}` }]
      }),
      [`assets/${sourceAssetId}.png`]: PNG_1X1
    });
    const preview = await previewAdapter.previewCampaignZip(chunks(bytes, 23), campaignCommand());
    const inventory = await previewAdapter.extractCampaignZipAssets(chunks(bytes, 29), preview.authority);

    expect(preview.authority.normalizedPayload).toMatchObject({ archiveFormat: "legacy_zip" });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      sourceAssetIds: [sourceAssetId],
      records: [{ bindings: [{ role: "turn_illustration", campaignId: sourceCampaignId, turnId: sourceTurnId }] }]
    });
  });

  it("maps malformed streaming parser failures to a safe archive diagnostic", async () => {
    await expect(previewAdapter.previewCampaignZip(
      chunks(new TextEncoder().encode("not-a-zip"), 2),
      campaignCommand(),
    )).rejects.toThrow("archive_truncated");
  });

  it("rejects traversal and Unix link entries before preview authority exists", async () => {
    const traversal = await archive({
      "campaign.json": JSON.stringify({ world: { title: "Arden" }, turns: [] }),
      "../outside.txt": "denied"
    });
    await expect(previewAdapter.previewCampaignZip(chunks(traversal, 11), campaignCommand()))
      .rejects.toThrow("archive_path_invalid");

    const link = await archive({
      "campaign.json": JSON.stringify({ world: { title: "Arden" }, turns: [] }),
      "assets/00000000-0000-4000-8000-000000000002.png": "target"
    }, 0o120777);
    await expect(previewAdapter.previewCampaignZip(chunks(link, 13), campaignCommand()))
      .rejects.toThrow("archive_link_denied");
  });

  it("guards the production Campaign ZIP decoder against full-archive buffering", async () => {
    const source = await readFile(new URL("../../services/runtime/src/portable-import-export-composition.ts", import.meta.url), "utf8");
    expect(source).not.toContain("JSZip.loadAsync");
    expect(source).not.toContain("campaignZip(await boundedBytes");
    expect(source).toContain("Readable.from(boundedArchiveSource(source, inspector))");
  });

  it("normalizes every non-ZIP import family through its explicit decoder", async () => {
    const existing = {
      kind: "existing_world_version" as const,
      worldId: "00000000-0000-4000-8000-000000000010",
      worldVersionId: "00000000-0000-4000-8000-000000000011"
    };
    const create = { kind: "create_world" as const };
    const base = { ownerUserId, stagedInput: toPortableStagedInput("staged-family") };
    const world = {
      format: "infinite-quest-world" as const,
      formatVersion: 1 as const,
      title: "Portable world",
      content: canonicalizeWorldContent({
        world: { title: "Portable world" },
        playableCharacters: [{ id: "hero", name: "Hero" }]
      })
    };
    const cyoa = await readFile(new URL("../fixtures/cyoa_writing_com_sample.json", import.meta.url), "utf8");
    const results = await Promise.all([
      previewAdapter.previewLegacyStory(utf8(JSON.stringify({ world: { title: "Legacy" }, turns: [] })), {
        ...base, kind: "legacy_story", destination: existing
      }),
      previewAdapter.previewInfiniteWorlds(utf8(JSON.stringify({
        title: "Infinite", background: "A setting", possibleCharacters: [{ name: "Hero" }]
      })), { ...base, kind: "infinite_worlds", destination: create }),
      previewAdapter.previewCyoa(utf8(cyoa), { ...base, kind: "cyoa", destination: create }),
      previewAdapter.previewWorldJson(utf8(JSON.stringify(world)), { ...base, kind: "world_json", destination: create }),
      previewAdapter.previewWorldText(utf8("A quiet archipelago beneath two moons."), {
        ...base, kind: "world_text", destination: create
      }),
      previewAdapter.previewStoryText(utf8(`-- Story Background --\nA remembered road.\n-- Character --\nHero\n-- Turn 1 --\nOutcome\n-------\nThe road opens.`), {
        ...base, kind: "story_text", destination: existing
      })
    ]);

    expect(results.map((result) => result.authority.kind)).toEqual([
      "legacy_story", "infinite_worlds", "cyoa", "world_json", "world_text", "story_text"
    ]);
    expect(results[2]!.authority.providerConfigurationFingerprint).toBe("b".repeat(64));
    expect(results[4]!.authority.providerConfigurationFingerprint).toBe("b".repeat(64));
  });

  it("extracts valid Legacy Story inline images while preserving external and malformed optional semantics", async () => {
    const story = {
      campaign: { sourceCampaignId, title: "Legacy image campaign" },
      world: { title: "Legacy images" },
      turns: [
        { id: sourceTurnId, narration: "Inline", imageUrl: `data:image/png;base64,${Buffer.from(PNG_1X1).toString("base64")}` },
        { id: crypto.randomUUID(), narration: "External", imageUrl: "https://images.example.test/safe.png" },
        { id: crypto.randomUUID(), narration: "Malformed", imageUrl: "data:image/png;base64,not-valid!" }
      ]
    };
    const command = {
      ownerUserId,
      stagedInput: toPortableStagedInput("legacy-inline"),
      kind: "legacy_story" as const,
      destination: {
        kind: "existing_world_version" as const,
        worldId: "00000000-0000-4000-8000-000000000030",
        worldVersionId: "00000000-0000-4000-8000-000000000031"
      }
    };
    const source = JSON.stringify(story);
    const preview = await previewAdapter.previewLegacyStory(utf8(source), command);

    expect(preview.authority.normalizedPayload).toMatchObject({
      assetRecords: [{ bindings: [{ role: "turn_illustration", turnId: sourceTurnId }] }]
    });
    expect(preview.authority.normalizedPayload.story).toMatchObject({
      turns: [
        { imageUrl: expect.stringMatching(/^data:image\/png/u) },
        { imageUrl: "https://images.example.test/safe.png" },
        { imageUrl: "data:image/png;base64,not-valid!" }
      ]
    });
    const extracted = await previewAdapter.extractLegacyStoryAssets(utf8(source), preview.authority);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      sourceAssetIds: [expect.any(String)],
      records: [{ bindings: [{ role: "turn_illustration", turnId: sourceTurnId }] }],
      artifact: { mimeType: "image/png", byteLength: PNG_1X1.byteLength }
    });
  });

  it("extracts test-injected Legacy Story companion assets without exposing a path or bearer", async () => {
    const contentHash = createHash("sha256").update(PNG_1X1).digest("hex");
    const story = {
      campaign: { sourceCampaignId, title: "Legacy bundle" },
      world: { title: "Legacy bundle world" },
      turns: [{ id: sourceTurnId, narration: "Bundled", imageUrl: "images/bundled.png" }]
    };
    const companions = [{
      sourceKey: "bundled.png",
      artifact: { mimeType: "image/png" as const, bytes: PNG_1X1, byteLength: PNG_1X1.byteLength, contentHash }
    }];
    const command = {
      ownerUserId,
      stagedInput: toPortableStagedInput("legacy-companion"),
      kind: "legacy_story" as const,
      destination: {
        kind: "existing_world_version" as const,
        worldId: "00000000-0000-4000-8000-000000000030",
        worldVersionId: "00000000-0000-4000-8000-000000000031"
      }
    };
    const source = JSON.stringify(story);
    const preview = await previewAdapter.previewLegacyStory(utf8(source), command, companions);
    const inventory = await previewAdapter.extractLegacyStoryAssets(
      utf8(source),
      preview.authority,
      companions,
    );

    expect(inventory).toMatchObject([{
      sourceKeys: expect.arrayContaining(["bundled.png", "bundled"]),
      records: [{ bindings: [{ role: "turn_illustration", turnId: sourceTurnId }] }],
      artifact: { contentHash }
    }]);
    expect(preview.authority.normalizedPayload).toMatchObject({
      assetRecords: [{ bindings: [{ role: "turn_illustration", turnId: sourceTurnId }] }]
    });
    expect(JSON.stringify(inventory)).not.toMatch(/(?:relativePath|storagePath|bearer)/u);
  });

  it("rejects Legacy Story companion count and byte limits before image decoding", async () => {
    const command = {
      ownerUserId,
      stagedInput: toPortableStagedInput("legacy-companion-limits"),
      kind: "legacy_story" as const,
      destination: {
        kind: "existing_world_version" as const,
        worldId: "00000000-0000-4000-8000-000000000030",
        worldVersionId: "00000000-0000-4000-8000-000000000031"
      }
    };
    const source = JSON.stringify({ world: { title: "Legacy limits" }, turns: [] });
    const smallHash = createHash("sha256").update(PNG_1X1).digest("hex");
    const largeBytes = new Uint8Array(17 * 1024 * 1024);
    const largeHash = createHash("sha256").update(largeBytes).digest("hex");
    const overLimitBytes = new Uint8Array((20 * 1024 * 1024) + 1);
    const overLimitHash = createHash("sha256").update(overLimitBytes).digest("hex");
    const capture = async (companions: Parameters<typeof previewAdapter.previewLegacyStory>[2]) => (
      previewAdapter.previewLegacyStory(utf8(source), command, companions)
        .then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))
    );

    await expect(Promise.all([
      capture(Array.from({ length: 257 }, (_, index) => ({
        sourceKey: `count-${index}.png`,
        artifact: { mimeType: "image/png" as const, bytes: PNG_1X1, byteLength: 0, contentHash: smallHash }
      }))),
      capture([{
        sourceKey: "nonpositive.png",
        artifact: { mimeType: "image/png" as const, bytes: new Uint8Array(), byteLength: 0, contentHash: smallHash }
      }]),
      capture([{
        sourceKey: "mismatch.png",
        artifact: { mimeType: "image/png" as const, bytes: PNG_1X1, byteLength: PNG_1X1.byteLength + 1, contentHash: smallHash }
      }]),
      capture([{
        sourceKey: "oversized.png",
        artifact: { mimeType: "image/png" as const, bytes: overLimitBytes, byteLength: overLimitBytes.byteLength, contentHash: overLimitHash }
      }]),
      capture([{
        sourceKey: "wrong-hash.png",
        artifact: { mimeType: "image/png" as const, bytes: PNG_1X1, byteLength: PNG_1X1.byteLength, contentHash: "f".repeat(64) }
      }]),
      capture(Array.from({ length: 4 }, (_, index) => ({
        sourceKey: `aggregate-${index}.png`,
        artifact: { mimeType: "image/png" as const, bytes: largeBytes, byteLength: largeBytes.byteLength, contentHash: largeHash }
      })))
    ])).resolves.toEqual([
      "archive_entry_limit_exceeded",
      "archive_size_limit_exceeded",
      "archive_size_limit_exceeded",
      "archive_size_limit_exceeded",
      "archive_unavailable",
      "archive_size_limit_exceeded"
    ]);
  });

  it("removes forbidden credential-like keys from durable normalized authority", async () => {
    const result = await previewAdapter.previewLegacyStory(utf8(JSON.stringify({
      world: { title: "Safe" },
      turns: [],
      settings: { api_token: "PRIVATE_MARKER", nested: { provider_response: "PRIVATE_MARKER" }, theme: "dark" }
    })), {
      ownerUserId,
      stagedInput: toPortableStagedInput("safe-authority"),
      kind: "legacy_story",
      destination: {
        kind: "existing_world_version",
        worldId: "00000000-0000-4000-8000-000000000030",
        worldVersionId: "00000000-0000-4000-8000-000000000031"
      }
    });
    expect(JSON.stringify(result.authority.normalizedPayload)).not.toContain("PRIVATE_MARKER");
    expect(result.authority.normalizedPayload).toMatchObject({
      story: { settings: { theme: "dark", nested: {} } }
    });
  });

  it("rejects foreign/mismatched target authority and never fabricates a story character", async () => {
    const destination = {
      kind: "existing_world_version" as const,
      worldId: "00000000-0000-4000-8000-000000000020",
      worldVersionId: "00000000-0000-4000-8000-000000000021"
    };
    const command = {
      ownerUserId,
      stagedInput: toPortableStagedInput("story-target"),
      kind: "story_text" as const,
      destination
    };
    const story = `-- Story Background --\nRoad.\n-- Character --\nHero\n-- Turn 1 --\nOutcome\n-------\nThe road opens.`;
    const foreign = createPortableFamilyPreviewAdapter(providerAdapter, {
      async readTargetWorldVersion(input) {
        return { ...input, ownerUserId: "00000000-0000-4000-8000-000000000099", content: targetContent };
      }
    });
    await expect(foreign.previewStoryText(utf8(story), command))
      .rejects.toThrow("portable_import_destination_invalid");

    const empty = createPortableFamilyPreviewAdapter(providerAdapter, {
      async readTargetWorldVersion(input) {
        return {
          ...input,
          ownerUserId: input.owner.ownerUserId,
          content: canonicalizeWorldContent({ world: { title: "Empty" }, playableCharacters: [] })
        };
      }
    });
    await expect(empty.previewStoryText(utf8(story), command))
      .rejects.toThrow("portable_story_character_required");
  });
});
