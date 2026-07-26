import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import { stageArchiveUpload, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { adaptLegacyCampaignZip, decodeCampaignArchive } from "../../services/api/src/campaign-archive-service.js";

const temporaryRoots: string[] = [];
const limits: ArchiveLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxUncompressedBytes: 10 * 1024 * 1024,
  maxEntries: 100,
  maxExpansionRatio: 100,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 1024 * 1024,
  maxOriginalImageBytes: 1024 * 1024
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "infinite-quest-campaign-archive-"));
  temporaryRoots.push(root);
  return root;
}

async function writeLegacyZip(path: string, entries: readonly { name: string; content: string }[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const output = createWriteStream(path, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const completed = once(output, "close");
  archive.pipe(output);
  for (const entry of entries) archive.append(Buffer.from(entry.content, "utf8"), { name: entry.name });
  await archive.finalize();
  await completed;
}

describe("legacy campaign ZIP adaptation", () => {
  it("rejects duplicate legacy entries through the shared strict archive validation", async () => {
    const root = await temporaryRoot();
    const path = join(root, "duplicate-campaign.zip");
    const campaign = JSON.stringify({ world: { schemaVersion: 4, world: { title: "Legacy archive" } }, turns: [] });
    await writeLegacyZip(path, [
      { name: "campaign.json", content: campaign },
      { name: "campaign.json", content: campaign }
    ]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(adaptLegacyCampaignZip(staged, limits)).rejects.toMatchObject({ code: "archive-entry-duplicate" });
  });

  it("adapts a manifest-less legacy ZIP and reports compatibility warnings", async () => {
    const root = await temporaryRoot();
    const path = join(root, "legacy-campaign.zip");
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({ world: { schemaVersion: 4, world: { title: "Legacy archive" } }, turns: [] })
    }]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(decodeCampaignArchive(staged, limits)).resolves.toMatchObject({
      warnings: expect.arrayContaining([expect.stringMatching(/no archive manifest/i)])
    });
  });

  it("rejects a legacy turn image pointer without a declared asset binding", async () => {
    const root = await temporaryRoot();
    const path = join(root, "legacy-pointer.zip");
    const missingAssetId = "11111111-1111-4111-8111-111111111111";
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({
        world: { schemaVersion: 4, world: { title: "Legacy archive" } },
        turns: [{ id: "22222222-2222-4222-8222-222222222222", imageUrl: `/api/v1/assets/${missingAssetId}` }]
      })
    }]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(adaptLegacyCampaignZip(staged, limits)).rejects.toMatchObject({ code: "archive-asset-missing" });
  });

  it("rejects a world portable asset pointer without a declared world-version binding", async () => {
    const root = await temporaryRoot();
    const path = join(root, "legacy-world-pointer.zip");
    const missingAssetId = "33333333-3333-4333-8333-333333333333";
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({
        world: { schemaVersion: 4, world: { title: "Legacy archive", firstAction: `/api/v1/assets/${missingAssetId}` } },
        turns: []
      })
    }]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(adaptLegacyCampaignZip(staged, limits)).rejects.toMatchObject({ code: "archive-asset-missing" });
  });
});
