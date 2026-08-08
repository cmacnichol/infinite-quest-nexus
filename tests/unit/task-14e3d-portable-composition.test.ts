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
import { canonicalizeWorldContent } from "../../packages/contracts/src/index.js";
import {
  createPortableFamilyPreviewAdapter,
  type PortableProviderWorldConversionPort
} from "../../services/runtime/src/portable-import-export-composition.js";

const ownerUserId = "00000000-0000-4000-8000-000000000001";

async function archive(files: Readonly<Record<string, string | Uint8Array>>, permissions?: number): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) {
    zip.file(name, value, permissions === undefined ? undefined : { unixPermissions: permissions });
  }
  return zip.generateAsync({ type: "uint8array", platform: "UNIX" });
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
