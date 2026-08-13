import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { canonicalArchiveJson } from "../../packages/contracts/src/archives.js";
import { sha256 } from "../../packages/domain/src/text.js";
import type { FilesystemAssetStore } from "../legacy-api/src/asset-service.js";

const cleanupArchivePreviewStaging = vi.fn();
const cleanupExpiredArchivePreviews = vi.fn();
const decodeCampaignArchive = vi.fn();
const rehydratePersistedStagedArchive = vi.fn();

vi.mock("../legacy-api/src/campaign-archive-service.js", () => ({
  campaignArchiveApplicationVersion: () => "test-archive-version",
  cleanupArchivePreviewStaging,
  cleanupExpiredArchivePreviews,
  decodeCampaignArchive,
  portableWorldContentHash: () => "portable-world-content-hash"
}));

vi.mock("../../services/api/src/archive-io.js", () => ({
  ArchiveError: class ArchiveError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "ArchiveError";
      this.code = code;
    }
  },
  rehydratePersistedStagedArchive
}));

describe("campaign archive import cleanup lifecycle", () => {
  beforeEach(() => {
    cleanupArchivePreviewStaging.mockReset();
    cleanupExpiredArchivePreviews.mockReset().mockResolvedValue({ expiredCount: 0, cleanupFailureCount: 0 });
    decodeCampaignArchive.mockReset().mockResolvedValue({ contentFingerprint: "f".repeat(64) });
    rehydratePersistedStagedArchive.mockReset().mockResolvedValue({ path: "staging/archive.zip", compressedBytes: 12 });
  });

  it("releases the transaction client before post-commit duplicate import cleanup reacquires the pool", async () => {
    const { importCampaignArchive } = await import("../legacy-api/src/import-service.js");
    let released = false;
    let releasedBeforeCleanup = false;
    const ownerUserId = "00000000-0000-4000-8000-000000000001";
    const destination = { kind: "embedded" } as const;
    const preview = {
      id: "11111111-1111-4111-8111-111111111111",
      owner_user_id: ownerUserId,
      content_fingerprint: "f".repeat(64),
      destination_hash: sha256(`campaign-archive-destination-v1\0${canonicalArchiveJson(destination)}`),
      application_version: "test-archive-version",
      staged_archive_path: "staging/archive.zip",
      source_name: "archive.zip",
      preview: { stagedCompressedBytes: 12 },
      status: "previewed",
      expires_at: new Date(Date.now() + 60_000)
    };
    const completedImport = {
      id: "22222222-2222-4222-8222-222222222222",
      world_id: "33333333-3333-4333-8333-333333333333",
      world_version_id: "44444444-4444-4444-8444-444444444444",
      campaign_id: "55555555-5555-4555-8555-555555555555",
      status: "completed",
      stats: { turnCount: 1, memoryCount: 0, summaryCount: 0, assetCount: 0, assetBytes: 0 }
    };
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM users")) return { rows: [{ id: ownerUserId }], rowCount: 1 };
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.includes("FROM archive_previews")) return { rows: [preview], rowCount: 1 };
      if (text.includes("FROM imports")) return { rows: [completedImport], rowCount: 1 };
      if (text.includes("UPDATE archive_previews")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client = {
      query,
      release: vi.fn(() => {
        released = true;
      })
    };
    const pool = {
      query,
      connect: vi.fn(async () => client)
    } as unknown as DatabasePool;
    cleanupArchivePreviewStaging.mockImplementation(async () => {
      releasedBeforeCleanup = released;
      return 0;
    });

    await importCampaignArchive(
      pool,
      { archiveStorageRoot: "C:\\tmp", campaignArchiveLimits: {} } as RuntimeConfig,
      {} as FilesystemAssetStore,
      { previewToken: "t".repeat(40), destination }
    );

    expect(releasedBeforeCleanup).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
