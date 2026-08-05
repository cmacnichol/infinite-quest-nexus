import { describe, expect, it, vi } from "vitest";
import type { PortableWorldApplicationPort } from "../../packages/application/src/world-campaign/index.js";
import {
  createImportApplication,
  toPortableImportedRecordId,
  toPortablePreviewHandle,
  toPortableSourceInstallationId,
  type ImportApplicationDependencies,
  type ImportTransactionContext
} from "../../packages/application/src/imports/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const worldId = "33333333-3333-4333-8333-333333333333";

function portableWorld(): PortableWorldApplicationPort {
  return {
    exportWorld: vi.fn(async () => ({ format: "infinite-quest-world", formatVersion: 1, title: "World", content: { world: { title: "World" }, playableCharacters: [], eventTriggers: [], defaults: { trackers: [] } } })) as unknown as PortableWorldApplicationPort["exportWorld"],
    previewWorldImport: vi.fn(async () => ({ kind: "world", title: "World", duplicate: false, existingWorldId: null, counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: [] })) as unknown as PortableWorldApplicationPort["previewWorldImport"],
    importWorld: vi.fn(async () => ({ importId: "import-1", worldId, worldVersionId: "version-1", duplicate: false }))
  };
}

function dependencies(worlds = portableWorld()): ImportApplicationDependencies {
  return {
    worlds,
    archives: {
      previewPortableImport: vi.fn(async () => ({ previewHandle: toPortablePreviewHandle("preview-1"), kind: "campaign_zip" as const, expiresAt: "2026-08-05T13:00:00.000Z", cleanupOwner: "application" as const, diagnostics: [] })),
      commitPortableImport: vi.fn(async () => ({ importedRecordId: toPortableImportedRecordId("record-1"), duplicate: false, diagnostics: [] })),
      exportCampaignArchive: vi.fn(async () => ({ archiveId: "archive-1", contentType: "application/zip" as const, byteLength: 3 })),
      cleanupPreview: vi.fn(async () => undefined)
    }
  };
}

describe("portable import application contracts", () => {
  it("uses the existing owner-bound PortableWorldApplicationPort for World JSON export", async () => {
    const worlds = portableWorld();
    const application = createImportApplication(dependencies(worlds));

    await application.exportWorldJson({ ownerUserId, worldId });

    expect(worlds.exportWorld).toHaveBeenCalledWith({ worldId });
  });

  it("retains portable installation and imported-record IDs as opaque provenance through preview and commit", async () => {
    const archives = dependencies().archives;
    const application = createImportApplication({ worlds: portableWorld(), archives });
    const transaction = {} as ImportTransactionContext;
    const preview = await application.previewPortableImport({
      ownerUserId,
      kind: "campaign_zip",
      sourceInstallationId: toPortableSourceInstallationId("foreign-installation"),
      importedRecordId: toPortableImportedRecordId("foreign-record")
    });

    await application.commitPortableImport(transaction, {
      ownerUserId,
      campaignId,
      previewHandle: preview.previewHandle,
      idempotencyKey: "campaign-import-1"
    });

    expect(archives.commitPortableImport).toHaveBeenCalledWith(transaction, {
      ownerUserId,
      campaignId,
      previewHandle: preview.previewHandle,
      idempotencyKey: "campaign-import-1"
    });
  });

  it("rejects blank opaque handles before they reach an adapter", () => {
    expect(() => toPortablePreviewHandle("  ")).toThrow("portable_preview_handle_invalid");
    expect(() => toPortableSourceInstallationId("  ")).toThrow("portable_source_installation_id_invalid");
  });
});
