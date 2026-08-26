import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDataTransferApi,
  sha256File,
  type DataTransferApi,
  type CreateSystemUploadOptions,
  type SystemArchiveJobView,
  type SystemImportPreviewView,
  type SystemUploadView
} from "../../apps/web-next/src/data-transfer-api.js";
import { mountDataTransferPage } from "../../apps/web-next/src/data-transfer-page.js";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";
const EXPORT_JOB_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-25T12:00:00.000Z";
const LATER = "2026-08-26T12:00:00.000Z";

const recordsByDomain = {
  providers: 2,
  prompts: 4,
  worlds: 1,
  "world-versions": 1,
  "world-drafts": 1,
  campaigns: 2,
  turns: 8,
  "turn-corrections": 0,
  "campaign-state": 2,
  "campaign-history": 2,
  "canonical-facts": 3,
  chronicle: 8,
  illustrations: 4,
  imports: 1,
  "cost-events": 2,
  "activity-events": 3
} as const;

const operationalOmissions = {
  generation: 1,
  illustration: 2,
  chronicle: 3,
  imports: 0,
  "system-archive": 0
} as const;

function upload(overrides: Partial<SystemUploadView> = {}): SystemUploadView {
  return {
    id: UPLOAD_ID,
    status: "completed",
    byteLength: 6,
    receivedBytes: 6,
    expiresAt: LATER,
    ...overrides
  };
}

function preview(): SystemImportPreviewView {
  return {
    valid: true,
    previewHandle: "opaque-preview-authority",
    versions: {
      archiveFormat: 1,
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      destinationApplication: "0.1.0",
      destinationMigration: "0079_resumable_system_archive_uploads"
    },
    sourceOwnerCount: 1,
    archiveFingerprint: "a".repeat(64),
    recordsByDomain: { ...recordsByDomain },
    assets: { originalCount: 4, totalBytes: 2048 },
    destinationEmpty: true,
    ownerMapping: { sourceOwnerId: OWNER_A, destinationOwnerId: OWNER_B },
    disabledProviders: 2,
    omittedOperationalRows: 6,
    operationalOmissions: { ...operationalOmissions },
    invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
    normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
    rebuilds: {
      chronicleIndex: { category: "chronicle-index", status: "pending", itemCount: 2 },
      assetThumbnails: { category: "asset-thumbnails", status: "pending", itemCount: 4 }
    },
    space: {
      staging: { requiredBytes: 4096, availableBytes: 8192, verified: true, sufficient: true, overrideUsed: false },
      assetRoot: { requiredBytes: 2048, availableBytes: 8192, verified: true, sufficient: true, overrideUsed: false }
    },
    warnings: ["Provider credentials must be entered again."],
    errors: [],
    expiresAt: LATER
  };
}

function importJob(status: SystemArchiveJobView["status"] = "completed"): SystemArchiveJobView {
  return {
    id: JOB_ID,
    kind: "import",
    status,
    createdAt: NOW,
    updatedAt: NOW,
    report: status === "completed" ? {
      completedAt: NOW,
      archiveFingerprint: "a".repeat(64),
      recordsByDomain: { ...recordsByDomain },
      assetCount: 4,
      assetBytes: 2048,
      omittedOperationalRows: 6,
      operationalOmissions: { ...operationalOmissions },
      warnings: [],
      errors: [],
      versions: preview().versions,
      sourceOwnerCount: 1,
      ownerMapping: { sourceOwnerId: OWNER_A, destinationOwnerId: OWNER_B },
      disabledProviders: 2,
      normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
      invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
      integrityReconciliation: {
        archiveFingerprintVerified: true,
        recordsMatched: true,
        assetsMatched: true
      },
      rebuildState: {
        chronicleIndex: { category: "chronicle-index", status: "queued", itemCount: 2 },
        assetThumbnails: { category: "asset-thumbnails", status: "queued", itemCount: 4 }
      }
    } : null
  };
}

function fakeApi(overrides: Partial<DataTransferApi> = {}): DataTransferApi {
  return {
    capability: vi.fn(async () => ({ systemArchive: true })),
    sessionOwnerId: vi.fn(async () => OWNER_B),
    createExport: vi.fn(async () => ({
      id: JOB_ID,
      kind: "export",
      status: "published",
      report: null,
      createdAt: NOW,
      updatedAt: NOW
    })),
    getJob: vi.fn(async () => importJob()),
    cancelJob: vi.fn(async () => importJob("cancelled")),
    downloadUrl: (jobId) => `/api/v1/system-exports/${encodeURIComponent(jobId)}/download`,
    createUpload: vi.fn(async () => upload()),
    getUpload: vi.fn(async () => upload()),
    cancelUpload: vi.fn(async () => upload({ status: "failed" })),
    preview: vi.fn(async () => preview()),
    commit: vi.fn(async () => importJob("queued")),
    ...overrides
  };
}

function memoryStorage(): Storage & { entries(): Array<[string, string]> } {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
    entries() { return [...values.entries()]; }
  };
}

afterEach(() => vi.restoreAllMocks());

describe("web-next Data Transfer API", () => {
  it("hashes files incrementally and uploads resumable bounded chunks without opening ZIP entries", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/v1/system-imports/uploads") {
        return new Response(JSON.stringify(upload({ status: "created", receivedBytes: 0 })), { status: 201 });
      }
      if (url.endsWith("/chunks/0")) return new Response(JSON.stringify(upload({ status: "uploading", receivedBytes: 4 })));
      if (url.endsWith("/chunks/1")) return new Response(JSON.stringify(upload({ status: "uploading", receivedBytes: 6 })));
      if (url.endsWith("/complete")) return new Response(JSON.stringify(upload()));
      throw new Error(`Unexpected request ${url}`);
    });
    const file = new File([new Uint8Array([0, 1, 2, 3, 4, 5])], "archive.zip", { type: "application/zip" });
    const api = createDataTransferApi({ fetchImpl, chunkBytes: 4, storage: null });
    const progress: Array<[string, number]> = [];

    expect(await sha256File(new File(["abc"], "known.bin"), 2)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    await expect(api.createUpload(file, { onProgress: (value) => progress.push([value.phase, value.receivedBytes]) }))
      .resolves.toMatchObject({ status: "completed", receivedBytes: 6 });

    expect(calls.map((call) => [call.init.method ?? "GET", call.url])).toEqual([
      ["POST", "/api/v1/system-imports/uploads"],
      ["PUT", `/api/v1/system-imports/uploads/${UPLOAD_ID}/chunks/0`],
      ["PUT", `/api/v1/system-imports/uploads/${UPLOAD_ID}/chunks/1`],
      ["POST", `/api/v1/system-imports/uploads/${UPLOAD_ID}/complete`]
    ]);
    expect(calls[1]?.init.headers).toMatchObject({
      "Content-Range": "bytes 0-3/6",
      "Content-Length": "4"
    });
    expect(calls[2]?.init.headers).toMatchObject({
      "Content-Range": "bytes 4-5/6",
      "Content-Length": "2"
    });
    expect(progress).toEqual([
      ["hashing", 0], ["hashing", 4], ["hashing", 6],
      ["uploading", 0], ["uploading", 4], ["uploading", 6],
      ["completing", 6], ["completing", 6]
    ]);
    const browserSources = [
      readFileSync("apps/web-next/src/data-transfer-api.ts", "utf8"),
      readFileSync("apps/web-next/src/data-transfer-page.ts", "utf8")
    ].join("\n");
    expect(browserSources).not.toMatch(/JSZip|loadAsync|unzipper|\.file\(["']manifest\.json/);
  });

  it("uses only the capability and opaque System Archive JSON contract", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ application: { name: "Infinite Quest Nexus", version: "0.1.0", commit: "test", builtAt: NOW }, capabilities: { systemArchive: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(importJob("queued")), { status: 202 }));
    const api = createDataTransferApi({ fetchImpl, storage: null });

    await expect(api.capability()).resolves.toEqual({ systemArchive: false });
    await expect(api.commit("opaque-preview", "commit-key")).resolves.toMatchObject({ kind: "import", status: "queued" });
    expect(fetchImpl.mock.calls[1]).toEqual([
      "/api/v1/system-imports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          previewHandle: "opaque-preview",
          idempotencyKey: "commit-key",
          acknowledgeSensitiveArchive: true,
          acknowledgeEmptyDestination: true,
          acknowledgeInvalidatedAccess: true,
          acknowledgeProviderReentry: true,
          acknowledgeNonCancellableBoundary: true
        })
      })
    ]);
  });
});

describe("web-next Data Transfer page", () => {
  it("unifies every transfer purpose while leaving contextual formats available", async () => {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = document.querySelector<HTMLElement>("#app")!;

    mountDataTransferPage(root, { api: fakeApi(), storage: null, wait: async () => undefined });
    await vi.waitFor(() => expect(root.querySelector('[data-system-archive-state="available"]')).not.toBeNull());

    expect(root.querySelector("h1")?.textContent).toContain("Data Transfer");
    expect([...root.querySelectorAll("[data-transfer-purpose] h2")].map((heading) => heading.textContent)).toEqual([
      "System Archive",
      "World & Campaign Archives",
      "Legacy & External Imports",
      "Readable Story Exports"
    ]);
    expect(root.querySelector('a[href="/nexus/#world-library"]')).not.toBeNull();
    expect(root.querySelector('a[href="/nexus/#campaigns"]')).not.toBeNull();
    expect(root.querySelector('a[href="/nexus/#imports"]')).not.toBeNull();
    expect(root.querySelector('nav a[href="/app/data-transfer"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps specialized transfers usable while the System Archive capability is off", async () => {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = document.querySelector<HTMLElement>("#app")!;
    mountDataTransferPage(root, {
      api: fakeApi({ capability: vi.fn(async () => ({ systemArchive: false })) }),
      storage: null
    });

    await vi.waitFor(() => expect(root.querySelector('[data-system-archive-state="disabled"]')).not.toBeNull());
    expect(root.textContent).toContain("System Archive is not enabled on this instance");
    expect(root.querySelector<HTMLInputElement>('#system-archive-file')?.disabled).toBe(true);
    expect(root.querySelectorAll("[data-transfer-purpose] a")).toHaveLength(4);
  });

  it("renders the server preview, focuses the first missing acknowledgement, and shows the durable report", async () => {
    const api = fakeApi();
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    mountDataTransferPage(root, { api, storage: null, wait: async () => undefined });
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#system-archive-file")?.disabled).toBe(false));
    const input = root.querySelector<HTMLInputElement>("#system-archive-file")!;
    const selected = new File(["system"], "owner-system.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { configurable: true, value: [selected] });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(root.querySelector('[data-system-preview="ready"]')).not.toBeNull());
    expect(input.files?.[0]).toBe(selected);
    expect(root.textContent).toContain("Destination must be empty");
    expect(root.textContent).toContain("2 disabled providers");
    expect(root.textContent).toContain("External access will be invalidated");
    expect(root.textContent).toContain("Chronicle index");
    expect(root.textContent).toContain("Asset thumbnails");

    root.querySelector<HTMLButtonElement>('[data-action="commit-system-import"]')!.click();
    const firstAcknowledgement = root.querySelector<HTMLInputElement>('input[name="acknowledgeSensitiveArchive"]')!;
    expect(firstAcknowledgement.getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Review every acknowledgement");

    for (const checkbox of root.querySelectorAll<HTMLInputElement>('[data-system-acknowledgements] input[type="checkbox"]')) {
      checkbox.checked = true;
    }
    root.querySelector<HTMLButtonElement>('[data-action="commit-system-import"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-system-import-state="completed"]')).not.toBeNull());
    expect(api.commit).toHaveBeenCalledWith("opaque-preview-authority", expect.any(String), expect.any(AbortSignal));
    expect(root.textContent).toContain("Import Report");
    expect(root.textContent).toContain("Integrity verified");
    expect(root.textContent).toContain("Provider recovery");
    expect(root.textContent).toContain("Create new access relationships");
    expect(root.textContent).toContain("Rebuilds queued");
  });

  it("announces disconnects without discarding the selected file or leaving controls busy", async () => {
    const api = fakeApi({ createUpload: vi.fn(async () => { throw new Error("Network connection lost"); }) });
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    mountDataTransferPage(root, { api, storage: null });
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#system-archive-file")?.disabled).toBe(false));
    const input = root.querySelector<HTMLInputElement>("#system-archive-file")!;
    const selected = new File(["system"], "resume-me.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { configurable: true, value: [selected] });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain("Network connection lost"));
    expect(input.files?.[0]).toBe(selected);
    expect(root.querySelector<HTMLButtonElement>('[data-action="upload-system-archive"]')?.disabled).toBe(false);
  });

  it("keeps cancellation available while a durable export is being monitored", async () => {
    const operationStorage = memoryStorage();
    operationStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${OWNER_B}:import`, JSON.stringify({
      kind: "import",
      idempotencyKey: "prior-import-key",
      jobId: EXPORT_JOB_ID,
      previewHandle: "prior-preview-authority"
    }));
    let releaseWait!: () => void;
    let releasePriorImportRecovery!: () => void;
    const api = fakeApi({
      createExport: vi.fn(async () => ({
        id: JOB_ID,
        kind: "export",
        status: "queued",
        report: null,
        createdAt: NOW,
        updatedAt: NOW
      })),
      getJob: vi.fn(async (kind) => kind === "import"
        ? new Promise<SystemArchiveJobView>((resolve) => {
            releasePriorImportRecovery = () => resolve({
              id: EXPORT_JOB_ID,
              kind: "import",
              status: "completed",
              report: null,
              createdAt: NOW,
              updatedAt: NOW
            });
          })
        : {
            id: JOB_ID,
            kind: "export",
            status: "cancelled",
            report: null,
            createdAt: NOW,
            updatedAt: NOW
          }),
      cancelJob: vi.fn(async () => ({
        id: JOB_ID,
        kind: "export",
        status: "cancelled",
        report: null,
        createdAt: NOW,
        updatedAt: NOW
      }))
    });
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, {
      api,
      storage: null,
      operationStorage,
      wait: async () => new Promise<void>((resolve) => { releaseWait = resolve; })
    });
    await vi.waitFor(() => expect(root.querySelector('[data-system-archive-state="available"]')).not.toBeNull());
    await vi.waitFor(() => expect(api.getJob).toHaveBeenCalledWith("import", EXPORT_JOB_ID, expect.any(AbortSignal)));
    root.querySelector<HTMLButtonElement>('[data-action="create-system-export"]')!.click();
    const cancel = root.querySelector<HTMLButtonElement>('[data-action="cancel-system-operation"]')!;

    await vi.waitFor(() => expect(cancel.disabled).toBe(false));
    await vi.waitFor(() => expect(releaseWait).toBeTypeOf("function"));
    cancel.click();
    await vi.waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith("export", JOB_ID, expect.any(AbortSignal)));
    releasePriorImportRecovery();
    releaseWait();
    await vi.waitFor(() => expect(root.textContent).toContain("cancelled"));
    mounted.dispose();
  });

  it("does not let an obsolete export poll repaint a cancelled job", async () => {
    let releasePoll: (() => void) | null = null;
    const queuedExport: SystemArchiveJobView = {
      id: JOB_ID,
      kind: "export",
      status: "queued",
      report: null,
      createdAt: NOW,
      updatedAt: NOW
    };
    const api = fakeApi({
      createExport: vi.fn(async () => queuedExport),
      getJob: vi.fn(async () => new Promise<SystemArchiveJobView>((resolve) => {
        releasePoll = () => resolve(queuedExport);
      })),
      cancelJob: vi.fn(async () => ({ ...queuedExport, status: "cancelled" }))
    });
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, {
      api,
      storage: null,
      operationStorage: memoryStorage(),
      wait: async () => undefined
    });
    await vi.waitFor(() => expect(root.querySelector('[data-system-archive-state="available"]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-action="create-system-export"]')!.click();
    await vi.waitFor(() => expect(api.getJob).toHaveBeenCalledWith("export", JOB_ID, expect.any(AbortSignal)));

    root.querySelector<HTMLButtonElement>('[data-action="cancel-system-operation"]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("System Export: cancelled."));
    releasePoll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.textContent).toContain("System Export: cancelled.");
    expect(root.textContent).not.toContain("System Export: queued.");
    mounted.dispose();
  });

  it("does not let an obsolete recovered export poll repaint a cancelled job", async () => {
    const operationStorage = memoryStorage();
    operationStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${OWNER_B}:export`, JSON.stringify({
      kind: "export",
      idempotencyKey: "recovered-export-key",
      jobId: JOB_ID
    }));
    let releasePoll: (() => void) | null = null;
    const queuedExport: SystemArchiveJobView = {
      id: JOB_ID,
      kind: "export",
      status: "queued",
      report: null,
      createdAt: NOW,
      updatedAt: NOW
    };
    const api = fakeApi({
      getJob: vi.fn()
        .mockResolvedValueOnce(queuedExport)
        .mockImplementation(async () => new Promise<SystemArchiveJobView>((resolve) => {
          if (!releasePoll) {
            releasePoll = () => resolve(queuedExport);
          }
        })),
      cancelJob: vi.fn(async () => ({ ...queuedExport, status: "cancelled" }))
    });
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, {
      api,
      storage: null,
      operationStorage,
      wait: async () => undefined
    });
    await vi.waitFor(() => expect(api.getJob).toHaveBeenCalledTimes(2));

    root.querySelector<HTMLButtonElement>('[data-action="cancel-system-operation"]')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("System Export: cancelled."));
    releasePoll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.textContent).toContain("System Export: cancelled.");
    expect(root.textContent).not.toContain("System Export: queued.");
    mounted.dispose();
  });

  it("persists owner-scoped export identity and restores its published download after reload", async () => {
    const storage = memoryStorage();
    const publishedExport: SystemArchiveJobView = {
      id: JOB_ID,
      kind: "export",
      status: "published",
      report: null,
      createdAt: NOW,
      updatedAt: NOW
    };
    const firstApi = Object.assign(fakeApi({ createExport: vi.fn(async () => publishedExport) }), {
      sessionOwnerId: vi.fn(async () => OWNER_B)
    });
    const firstDom = parseHTML('<html><body><div id="app"></div></body></html>');
    const firstRoot = firstDom.document.querySelector<HTMLElement>("#app")!;
    const firstMount = mountDataTransferPage(firstRoot, {
      api: firstApi,
      storage,
      operationStorage: storage,
      wait: async () => undefined
    } as Parameters<typeof mountDataTransferPage>[1]);
    await vi.waitFor(() => expect(firstRoot.querySelector('[data-system-archive-state="available"]')).not.toBeNull());
    firstRoot.querySelector<HTMLButtonElement>('[data-action="create-system-export"]')!.click();
    await vi.waitFor(() => expect(firstRoot.querySelector<HTMLAnchorElement>("[data-system-download]")?.hidden).toBe(false));
    const stored = storage.entries();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.[0]).toContain(OWNER_B);
    expect(JSON.parse(stored[0]![1])).toMatchObject({
      kind: "export",
      jobId: JOB_ID,
      idempotencyKey: expect.stringMatching(/^browser-export-/)
    });
    firstMount.dispose();

    const restoredApi = Object.assign(fakeApi({
      createExport: vi.fn(async () => { throw new Error("A reload must not create another export."); }),
      getJob: vi.fn(async () => publishedExport)
    }), { sessionOwnerId: vi.fn(async () => OWNER_B) });
    const restoredDom = parseHTML('<html><body><div id="app"></div></body></html>');
    const restoredRoot = restoredDom.document.querySelector<HTMLElement>("#app")!;
    const restoredMount = mountDataTransferPage(restoredRoot, {
      api: restoredApi,
      storage,
      operationStorage: storage,
      wait: async () => undefined
    } as Parameters<typeof mountDataTransferPage>[1]);

    await vi.waitFor(() => expect(restoredRoot.querySelector<HTMLAnchorElement>("[data-system-download]")?.hidden).toBe(false));
    expect(restoredApi.getJob).toHaveBeenCalledWith("export", JOB_ID, expect.any(AbortSignal));
    expect(restoredRoot.querySelector<HTMLAnchorElement>("[data-system-download]")?.href).toContain(`/system-exports/${JOB_ID}/download`);
    restoredMount.dispose();
  });

  it("recovers an import report without waiting for an active export poll to finish", async () => {
    const storage = memoryStorage();
    storage.setItem(`infiniteQuest.systemArchiveOperation.v1:${OWNER_B}:export`, JSON.stringify({
      kind: "export",
      idempotencyKey: "persisted-export-key",
      jobId: EXPORT_JOB_ID
    }));
    storage.setItem(`infiniteQuest.systemArchiveOperation.v1:${OWNER_B}:import`, JSON.stringify({
      kind: "import",
      idempotencyKey: "persisted-import-key",
      jobId: JOB_ID,
      previewHandle: "opaque-preview-authority"
    }));
    let releaseExportPoll!: () => void;
    const api = fakeApi({
      getJob: vi.fn(async (kind) => kind === "export"
        ? {
            id: EXPORT_JOB_ID,
            kind: "export",
            status: "queued",
            report: null,
            createdAt: NOW,
            updatedAt: NOW
          }
        : importJob("completed"))
    });
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, {
      api,
      storage: null,
      operationStorage: storage,
      wait: async () => new Promise<void>((resolve) => { releaseExportPoll = resolve; })
    });

    await vi.waitFor(() => expect(root.querySelector('[data-system-import-state="completed"]')).not.toBeNull());
    expect(api.getJob).toHaveBeenCalledWith("export", EXPORT_JOB_ID, expect.any(AbortSignal));
    expect(api.getJob).toHaveBeenCalledWith("import", JOB_ID, expect.any(AbortSignal));
    mounted.dispose();
    releaseExportPoll();
  });

  it("recovers an ambiguously accepted import without reusing stale preview authority", async () => {
    const storage = memoryStorage();
    const firstApi = fakeApi({ commit: vi.fn(async () => { throw new Error("Commit response disconnected"); }) });
    const firstDom = parseHTML('<html><body><div id="app"></div></body></html>');
    const firstRoot = firstDom.document.querySelector<HTMLElement>("#app")!;
    const firstMount = mountDataTransferPage(firstRoot, {
      api: firstApi,
      storage: null,
      operationStorage: storage,
      wait: async () => undefined
    });
    await vi.waitFor(() => expect(firstRoot.querySelector<HTMLInputElement>("#system-archive-file")?.disabled).toBe(false));
    const fileInput = firstRoot.querySelector<HTMLInputElement>("#system-archive-file")!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["system"], "ambiguous.zip", { type: "application/zip" })]
    });
    fileInput.dispatchEvent(new firstDom.window.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(firstRoot.querySelector('[data-system-preview="ready"]')).not.toBeNull());
    for (const checkbox of firstRoot.querySelectorAll<HTMLInputElement>('[data-system-acknowledgements] input[type="checkbox"]')) checkbox.checked = true;
    firstRoot.querySelector<HTMLButtonElement>('[data-action="commit-system-import"]')!.click();
    await vi.waitFor(() => expect(firstRoot.querySelector('[role="alert"]')?.textContent).toContain("Commit response disconnected"));

    expect(firstRoot.querySelector<HTMLElement>('[data-system-preview]')?.hidden).toBe(true);
    expect(firstRoot.querySelector<HTMLButtonElement>('[data-action="commit-system-import"]')?.disabled).toBe(true);
    const stored = storage.entries();
    expect(stored).toHaveLength(1);
    const pending = JSON.parse(stored[0]![1]);
    expect(stored[0]?.[0]).toContain(`${OWNER_B}:import`);
    expect(pending).toMatchObject({
      kind: "import",
      jobId: null,
      previewHandle: "opaque-preview-authority",
      idempotencyKey: expect.stringMatching(/^browser-import-/)
    });
    firstMount.dispose();

    const restoredApi = fakeApi({ commit: vi.fn(async () => importJob("completed")) });
    const restoredDom = parseHTML('<html><body><div id="app"></div></body></html>');
    const restoredRoot = restoredDom.document.querySelector<HTMLElement>("#app")!;
    const restoredMount = mountDataTransferPage(restoredRoot, {
      api: restoredApi,
      storage: null,
      operationStorage: storage,
      wait: async () => undefined
    });

    await vi.waitFor(() => expect(restoredRoot.querySelector('[data-system-import-state="completed"]')).not.toBeNull());
    expect(restoredApi.commit).toHaveBeenCalledWith(
      "opaque-preview-authority",
      pending.idempotencyKey,
      expect.any(AbortSignal)
    );
    expect(JSON.parse(storage.entries()[0]![1])).toMatchObject({ kind: "import", jobId: JOB_ID });
    restoredMount.dispose();
  });

  it("invalidates preview authority when its staged upload is cancelled", async () => {
    const api = fakeApi();
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, { api, storage: null, operationStorage: memoryStorage() });
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#system-archive-file")?.disabled).toBe(false));
    const input = root.querySelector<HTMLInputElement>("#system-archive-file")!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["system"], "cancel-preview.zip", { type: "application/zip" })]
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('[data-system-preview="ready"]')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('[data-action="cancel-system-operation"]')!.click();
    await vi.waitFor(() => expect(api.cancelUpload).toHaveBeenCalledWith(UPLOAD_ID, expect.any(AbortSignal)));

    expect(root.querySelector<HTMLElement>("[data-system-preview]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLFieldSetElement>("[data-system-acknowledgements]")?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-action="commit-system-import"]')?.disabled).toBe(true);
    mounted.dispose();
  });

  it("recovers an ambiguous import identity before attempting cancellation", async () => {
    const storage = memoryStorage();
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error("Commit response disconnected"))
      .mockResolvedValueOnce(importJob("queued"));
    const api = fakeApi({
      commit,
      cancelJob: vi.fn(async () => importJob("cancelled"))
    });
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, { api, storage: null, operationStorage: storage, wait: async () => undefined });
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#system-archive-file")?.disabled).toBe(false));
    const input = root.querySelector<HTMLInputElement>("#system-archive-file")!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["system"], "ambiguous-cancel.zip", { type: "application/zip" })]
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('[data-system-preview="ready"]')).not.toBeNull());
    for (const checkbox of root.querySelectorAll<HTMLInputElement>('[data-system-acknowledgements] input[type="checkbox"]')) checkbox.checked = true;
    root.querySelector<HTMLButtonElement>('[data-action="commit-system-import"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain("Commit response disconnected"));
    const pending = JSON.parse(storage.entries()[0]![1]);

    root.querySelector<HTMLButtonElement>('[data-action="cancel-system-operation"]')!.click();
    await vi.waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith("import", JOB_ID, expect.any(AbortSignal)));

    expect(commit).toHaveBeenNthCalledWith(2, "opaque-preview-authority", pending.idempotencyKey, expect.any(AbortSignal));
    expect(api.cancelUpload).not.toHaveBeenCalled();
    expect(JSON.parse(storage.entries()[0]![1])).toMatchObject({ kind: "import", jobId: JOB_ID });
    expect(root.textContent).toContain("cancelled");
    mounted.dispose();
  });

  it("aborts local upload work and cancels the durable upload once its handle is known", async () => {
    type CancellableUploadOptions = CreateSystemUploadOptions & Readonly<{
      onUploadAvailable?(value: SystemUploadView): void;
    }>;
    const operationStorage = memoryStorage();
    operationStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${OWNER_B}:export`, JSON.stringify({
      kind: "export",
      idempotencyKey: "prior-export-key",
      jobId: EXPORT_JOB_ID
    }));
    let operationSignal: AbortSignal | undefined;
    let releasePriorExportRecovery!: () => void;
    const api = fakeApi({
      getJob: vi.fn(async (kind) => kind === "export"
        ? new Promise<SystemArchiveJobView>((resolve) => {
            releasePriorExportRecovery = () => resolve({
              id: EXPORT_JOB_ID,
              kind: "export",
              status: "published",
              report: null,
              createdAt: NOW,
              updatedAt: NOW
            });
          })
        : importJob()),
      createUpload: vi.fn((_file: File, options: CreateSystemUploadOptions = {}) => new Promise<SystemUploadView>((_resolve, reject) => {
        operationSignal = options.signal;
        (options as CancellableUploadOptions).onUploadAvailable?.(upload({ status: "uploading", receivedBytes: 4 }));
        operationSignal?.addEventListener("abort", () => reject(operationSignal?.reason), { once: true });
      })),
      cancelUpload: vi.fn(async () => upload({ status: "failed", receivedBytes: 4 }))
    });
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const root = window.document.querySelector<HTMLElement>("#app")!;
    const mounted = mountDataTransferPage(root, { api, storage: null, operationStorage });
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#system-archive-file")?.disabled).toBe(false));
    await vi.waitFor(() => expect(api.getJob).toHaveBeenCalledWith("export", EXPORT_JOB_ID, expect.any(AbortSignal)));
    const input = root.querySelector<HTMLInputElement>("#system-archive-file")!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["system"], "cancel-me.zip", { type: "application/zip" })]
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(api.createUpload).toHaveBeenCalledOnce());

    const cancel = root.querySelector<HTMLButtonElement>('[data-action="cancel-system-operation"]')!;
    expect(cancel.disabled).toBe(false);
    cancel.click();

    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(api.cancelUpload).toHaveBeenCalledWith(UPLOAD_ID, expect.any(AbortSignal)));
    releasePriorExportRecovery();
    expect(root.textContent).toContain("upload cancelled");
    mounted.dispose();
  });
});
