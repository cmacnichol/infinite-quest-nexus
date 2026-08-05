import { describe, expect, it, vi } from "vitest";
import type { WorldImportRequest } from "../../packages/application/src/world-campaign/index.js";
import type {
  OwnerBoundIdempotentPortableWorldApplicationPort,
  PortableWorldApplicationPort
} from "../../packages/application/src/world-campaign/index.js";
import {
  createImportApplication,
  toPortableArchiveExportRetrieval,
  toPortableImportedRecordId,
  toPortablePreviewHandle,
  toPortableSourceInstallationId,
  toPortableStagedInput,
  type ImportApplicationDependencies,
  type ImportTransactionContext,
  type PortableImportCommitCommand,
  type PortableImportPreviewCommand
} from "../../packages/application/src/imports/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const worldId = "33333333-3333-4333-8333-333333333333";
const worldVersionId = "44444444-4444-4444-8444-444444444444";
const stagedInput = toPortableStagedInput("staged-import-1");

function portableWorld(): OwnerBoundIdempotentPortableWorldApplicationPort {
  const imports = new Map<string, { request: unknown; result: { importId: string; worldId: string; worldVersionId: string; duplicate: boolean } }>();
  return {
    exportWorld: vi.fn(async () => ({ format: "infinite-quest-world", formatVersion: 1, title: "World", content: { world: { title: "World" }, playableCharacters: [], eventTriggers: [], defaults: { trackers: [] } } })) as unknown as PortableWorldApplicationPort["exportWorld"],
    previewWorldImport: vi.fn(async () => ({ kind: "world", title: "World", duplicate: false, existingWorldId: null, counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: [] })) as unknown as PortableWorldApplicationPort["previewWorldImport"],
    importWorld: vi.fn(async () => ({ importId: "import-1", worldId, worldVersionId, duplicate: false })),
    importWorldIdempotent: vi.fn(async (command) => {
      const prior = imports.get(command.idempotencyKey);
      if (prior && prior.request !== command.request) throw Object.assign(new Error("idempotency_mismatch"), { code: "idempotency_mismatch" });
      if (prior) return { ...prior.result, duplicate: true };
      const result = { importId: "import-1", worldId, worldVersionId, duplicate: false };
      imports.set(command.idempotencyKey, { request: command.request, result });
      return result;
    })
  };
}

function preview(kind: PortableImportPreviewCommand["kind"]): PortableImportPreviewCommand {
  return {
    ownerUserId,
    kind,
    stagedInput,
    sourceInstallationId: toPortableSourceInstallationId("foreign-installation"),
    importedRecordId: toPortableImportedRecordId("foreign-record")
  };
}

function commit(kind: PortableImportCommitCommand["kind"]): PortableImportCommitCommand {
  const previewHandle = toPortablePreviewHandle(`preview-${kind}`);
  if (kind === "legacy_story" || kind === "campaign_zip") {
    return { ownerUserId, kind, destination: { kind: "campaign", campaignId }, previewHandle, idempotencyKey: `${kind}-1` };
  }
  if (kind === "infinite_worlds") {
    return { ownerUserId, kind, destination: { kind: "world", worldId }, previewHandle, idempotencyKey: `${kind}-1` };
  }
  return { ownerUserId, kind, destination: { kind: "world_version", worldId, worldVersionId }, previewHandle, idempotencyKey: `${kind}-1` };
}

function dependencies(worlds = portableWorld()): ImportApplicationDependencies {
  return {
    worlds,
    archives: {
      previewPortableImport: vi.fn(async (command) => ({ previewHandle: toPortablePreviewHandle(`preview-${command.kind}`), kind: command.kind, expiresAt: "2026-08-05T13:00:00.000Z", cleanupOwner: "application" as const, diagnostics: [] })),
      commitPortableImport: vi.fn(async () => ({ importedRecordId: toPortableImportedRecordId("record-1"), duplicate: false, diagnostics: [] })),
      exportCampaignArchive: vi.fn(async () => ({ retrieval: toPortableArchiveExportRetrieval("archive-retrieval-1"), contentType: "application/zip" as const, byteLength: 3 })),
      downloadPortableExport: vi.fn(async () => ({ content: new Uint8Array([1, 2, 3]), contentType: "application/zip" as const })),
      cleanupPreview: vi.fn(async () => undefined)
    }
  };
}

describe("portable import application contracts", () => {
  it("uses the existing owner-bound portable world port for World JSON export", async () => {
    const worlds = portableWorld();
    const application = createImportApplication(dependencies(worlds));

    await application.exportWorldJson({ ownerUserId, worldId });

    expect(worlds.exportWorld).toHaveBeenCalledWith({ worldId });
  });

  it.each([
    ["legacy_story", { kind: "campaign", campaignId }],
    ["campaign_zip", { kind: "campaign", campaignId }],
    ["infinite_worlds", { kind: "world", worldId }],
    ["cyoa", { kind: "world_version", worldId, worldVersionId }]
  ] as const)("preserves opaque staged input and required destination for %s", async (kind, destination) => {
    const archives = dependencies().archives;
    const application = createImportApplication({ worlds: portableWorld(), archives });
    const transaction = {} as ImportTransactionContext;
    const previewCommand = preview(kind);
    const commitCommand = commit(kind);

    await expect(application.previewPortableImport(previewCommand)).resolves.toMatchObject({ kind });
    await application.commitPortableImport(transaction, commitCommand);

    expect(archives.previewPortableImport).toHaveBeenCalledWith(previewCommand);
    expect(archives.commitPortableImport).toHaveBeenCalledWith(transaction, expect.objectContaining({ destination }));
  });

  it("returns and consumes an opaque safe export retrieval capability", async () => {
    const archives = dependencies().archives;
    const application = createImportApplication({ worlds: portableWorld(), archives });
    const scope = { ownerUserId, campaignId, worldId, worldVersionId };
    const exported = await application.exportCampaignArchive(scope);

    await expect(application.downloadPortableExport(scope, exported.retrieval))
      .resolves.toEqual({ content: new Uint8Array([1, 2, 3]), contentType: "application/zip" });
    expect(archives.downloadPortableExport).toHaveBeenCalledWith(scope, exported.retrieval);
  });

  it("replays same-key World JSON imports and rejects mismatched key reuse through the owner-bound extension", async () => {
    const worlds = portableWorld();
    const application = createImportApplication(dependencies(worlds));
    const request = { sourceName: "world.json", worldExport: { format: "infinite-quest-world", formatVersion: 1, title: "World", content: { schemaVersion: 1, world: { title: "World", premise: "", genre: "", tone: "", setting: "", rules: "" }, entities: [], relationships: [], playableCharacters: [], eventTriggers: [], locationTemplates: [], customFields: [], defaults: {} } } } as unknown as WorldImportRequest;
    const command = { ownerUserId, request, idempotencyKey: "world-import-1" };

    await expect(application.commitWorldJson(command)).resolves.toMatchObject({ duplicate: false });
    await expect(application.commitWorldJson(command)).resolves.toMatchObject({ duplicate: true });
    await expect(application.commitWorldJson({ ...command, request: { ...request, sourceName: "other-world.json" } }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(worlds.importWorldIdempotent).toHaveBeenCalledWith({ request, idempotencyKey: "world-import-1" });
  });

  it("rejects invalid input through each Promise-returning import operation", async () => {
    const application = createImportApplication(dependencies());
    const transaction = {} as ImportTransactionContext;
    const request = {} as never;

    await expect(application.previewPortableImport({ ...preview("legacy_story"), ownerUserId: "" })).rejects.toMatchObject({ code: "owner_scope_required" });
    await expect(application.commitPortableImport(transaction, {
      ownerUserId,
      kind: "campaign_zip",
      destination: { kind: "campaign", campaignId: "" },
      previewHandle: toPortablePreviewHandle("invalid-campaign"),
      idempotencyKey: "invalid-campaign"
    })).rejects.toMatchObject({ code: "import_scope_required" });
    await expect(application.exportCampaignArchive({ ownerUserId, campaignId: "", worldId, worldVersionId })).rejects.toMatchObject({ code: "import_scope_required" });
    await expect(application.downloadPortableExport({ ownerUserId, campaignId: "", worldId, worldVersionId }, toPortableArchiveExportRetrieval("download"))).rejects.toMatchObject({ code: "import_scope_required" });
    await expect(application.cleanupPreview({ ownerUserId: "", previewHandle: toPortablePreviewHandle("cleanup") })).rejects.toMatchObject({ code: "owner_scope_required" });
    await expect(application.exportWorldJson({ ownerUserId, worldId: "" })).rejects.toMatchObject({ code: "import_scope_required" });
    await expect(application.previewWorldJson({ ownerUserId: "", request })).rejects.toMatchObject({ code: "owner_scope_required" });
    await expect(application.commitWorldJson({ ownerUserId, request, idempotencyKey: "" })).rejects.toMatchObject({ code: "idempotency_key_required" });
  });

  it("rejects blank opaque handles before they reach an adapter", () => {
    expect(() => toPortablePreviewHandle("  ")).toThrow("portable_preview_handle_invalid");
    expect(() => toPortableSourceInstallationId("  ")).toThrow("portable_source_installation_id_invalid");
  });
});
