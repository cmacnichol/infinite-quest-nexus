import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = "2026-08-25T12:00:00.000Z";
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";
const PRIOR_IMPORT_JOB_ID = "66666666-6666-4666-8666-666666666666";
const AMBIGUOUS_IMPORT_JOB_ID = "77777777-7777-4777-8777-777777777777";
const NEWER_EXPORT_JOB_ID = "88888888-8888-4888-8888-888888888888";
const NEWER_IMPORT_JOB_ID = "99999999-9999-4999-8999-999999999999";
const recordsByDomain = {
  providers: 2, prompts: 4, worlds: 1, "world-versions": 1, "world-drafts": 1,
  campaigns: 2, turns: 8, "turn-corrections": 0, "campaign-state": 2,
  "campaign-history": 2, "canonical-facts": 3, chronicle: 8, illustrations: 4,
  imports: 1, "cost-events": 2, "activity-events": 3
};
const operationalOmissions = {
  generation: 1, illustration: 2, chronicle: 3, imports: 0, "system-archive": 0
};
const versions = {
  archiveFormat: 1,
  sourceApplication: "0.1.0",
  sourceMigration: "0079_resumable_system_archive_uploads",
  destinationApplication: "0.1.0",
  destinationMigration: "0079_resumable_system_archive_uploads"
};

const preview = {
  valid: true,
  previewHandle: "opaque-preview-authority",
  versions,
  sourceOwnerCount: 1,
  archiveFingerprint: "a".repeat(64),
  recordsByDomain,
  assets: { originalCount: 4, totalBytes: 2048 },
  destinationEmpty: true,
  ownerMapping: { sourceOwnerId: OWNER_A, destinationOwnerId: OWNER_B },
  disabledProviders: 2,
  omittedOperationalRows: 6,
  operationalOmissions,
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
  expiresAt: "2026-08-26T12:00:00.000Z"
};

const report = {
  completedAt: NOW,
  archiveFingerprint: "a".repeat(64),
  recordsByDomain,
  assetCount: 4,
  assetBytes: 2048,
  omittedOperationalRows: 6,
  operationalOmissions,
  warnings: [],
  errors: [],
  versions,
  sourceOwnerCount: 1,
  ownerMapping: { sourceOwnerId: OWNER_A, destinationOwnerId: OWNER_B },
  disabledProviders: 2,
  normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
  invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
  integrityReconciliation: { archiveFingerprintVerified: true, recordsMatched: true, assetsMatched: true },
  rebuildState: {
    chronicleIndex: { category: "chronicle-index", status: "queued", itemCount: 2 },
    assetThumbnails: { category: "asset-thumbnails", status: "queued", itemCount: 4 }
  }
};

function json(route: Route, value: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function installDataTransferApi(
  page: Page,
  enabled = true,
  options: Readonly<{
    initialExportStatus?: "queued" | "published";
    holdFirstExportCreate?: boolean;
    holdExportCancel?: boolean;
    disconnectFirstImportCommit?: boolean;
    acceptedImportJobId?: string;
    holdUploadCreate?: boolean;
    holdFirstUploadChunk?: boolean;
  }> = {}
): Promise<{
  exportPosts: number;
  exportGets: number;
  exportCreates: Array<Record<string, unknown>>;
  exportCancelRequests: number;
  cancelledExportJobIds: string[];
  importCommits: Array<Record<string, unknown>>;
  cancelledImportJobIds: string[];
  cancelledUploadIds: string[];
  releaseFirstExportCreate(): void;
  releaseExportCancel(): void;
  releaseUploadCreate(): void;
  releaseFirstUploadChunk(): void;
}> {
  let releaseFirstExportCreate: () => void = () => undefined;
  let releaseExportCancel: () => void = () => undefined;
  let releaseUploadCreate: () => void = () => undefined;
  let releaseFirstUploadChunk: () => void = () => undefined;
  const firstExportCreateGate = new Promise<void>((resolve) => { releaseFirstExportCreate = resolve; });
  const exportCancelGate = new Promise<void>((resolve) => { releaseExportCancel = resolve; });
  const uploadCreateGate = new Promise<void>((resolve) => { releaseUploadCreate = resolve; });
  const firstUploadChunkGate = new Promise<void>((resolve) => { releaseFirstUploadChunk = resolve; });
  const evidence = {
    exportPosts: 0,
    exportGets: 0,
    exportCreates: [] as Array<Record<string, unknown>>,
    exportCancelRequests: 0,
    cancelledExportJobIds: [] as string[],
    importCommits: [] as Array<Record<string, unknown>>,
    cancelledImportJobIds: [] as string[],
    cancelledUploadIds: [] as string[],
    releaseFirstExportCreate: () => releaseFirstExportCreate(),
    releaseExportCancel: () => releaseExportCancel(),
    releaseUploadCreate: () => releaseUploadCreate(),
    releaseFirstUploadChunk: () => releaseFirstUploadChunk()
  };
  let uploadReceived = 0;
  let firstUploadChunk = true;
  let exportStatus: "queued" | "published" | "cancelled" = options.initialExportStatus ?? "queued";
  const acceptedImportJobId = options.acceptedImportJobId ?? JOB_ID;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/meta") return json(route, {
      application: { name: "Infinite Quest Nexus", version: "0.1.0", commit: null, builtAt: null },
      capabilities: { systemArchive: enabled }
    });
    if (path === "/api/v1/system-exports" && request.method() === "POST") {
      evidence.exportPosts += 1;
      evidence.exportCreates.push(request.postDataJSON() as Record<string, unknown>);
      if (options.holdFirstExportCreate && evidence.exportPosts === 1) {
        await firstExportCreateGate;
        return route.abort("internetdisconnected");
      }
      return json(route, { id: JOB_ID, kind: "export", status: exportStatus, report: null, createdAt: NOW, updatedAt: NOW }, 202);
    }
    if (path === `/api/v1/system-exports/${JOB_ID}` && request.method() === "GET") {
      evidence.exportGets += 1;
      return json(route, { id: JOB_ID, kind: "export", status: exportStatus, report: null, createdAt: NOW, updatedAt: NOW });
    }
    if (path === `/api/v1/system-exports/${JOB_ID}` && request.method() === "DELETE") {
      evidence.exportCancelRequests += 1;
      if (options.holdExportCancel) await exportCancelGate;
      exportStatus = "cancelled";
      evidence.cancelledExportJobIds.push(JOB_ID);
      return json(route, { id: JOB_ID, kind: "export", status: exportStatus, report: null, createdAt: NOW, updatedAt: NOW });
    }
    if (path === "/api/v1/system-imports/uploads" && request.method() === "POST") {
      if (options.holdUploadCreate) await uploadCreateGate;
      return json(route, { id: UPLOAD_ID, status: "created", byteLength: 6, receivedBytes: 0, expiresAt: preview.expiresAt }, 201);
    }
    if (path.includes(`/system-imports/uploads/${UPLOAD_ID}/chunks/`)) {
      if (options.holdFirstUploadChunk && firstUploadChunk) await firstUploadChunkGate;
      firstUploadChunk = false;
      uploadReceived += request.postDataBuffer()?.byteLength ?? 0;
      return json(route, { id: UPLOAD_ID, status: "uploading", byteLength: 6, receivedBytes: uploadReceived, expiresAt: preview.expiresAt });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}/complete`) {
      return json(route, { id: UPLOAD_ID, status: "completed", byteLength: 6, receivedBytes: 6, expiresAt: preview.expiresAt });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}` && request.method() === "DELETE") {
      evidence.cancelledUploadIds.push(UPLOAD_ID);
      return json(route, { id: UPLOAD_ID, status: "failed", byteLength: 6, receivedBytes: 6, expiresAt: preview.expiresAt });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}` && request.method() === "GET") {
      return json(route, { id: UPLOAD_ID, status: "uploading", byteLength: 6, receivedBytes: uploadReceived, expiresAt: preview.expiresAt });
    }
    if (path === "/api/v1/system-imports/preview") return json(route, preview);
    if (path === "/api/v1/system-imports" && request.method() === "POST") {
      evidence.importCommits.push(request.postDataJSON() as Record<string, unknown>);
      if (options.disconnectFirstImportCommit && evidence.importCommits.length === 1) return route.abort("internetdisconnected");
      return json(route, { id: acceptedImportJobId, kind: "import", status: "queued", report: null, createdAt: NOW, updatedAt: NOW }, 202);
    }
    if (path === `/api/v1/system-imports/${acceptedImportJobId}` && request.method() === "GET") {
      return json(route, { id: acceptedImportJobId, kind: "import", status: "completed", report, createdAt: NOW, updatedAt: NOW });
    }
    if (path === `/api/v1/system-imports/${PRIOR_IMPORT_JOB_ID}` && request.method() === "GET") {
      return json(route, { id: PRIOR_IMPORT_JOB_ID, kind: "import", status: "completed", report, createdAt: NOW, updatedAt: NOW });
    }
    if (path === `/api/v1/system-imports/${acceptedImportJobId}` && request.method() === "DELETE") {
      evidence.cancelledImportJobIds.push(acceptedImportJobId);
      return json(route, { id: acceptedImportJobId, kind: "import", status: "cancelled", report: null, createdAt: NOW, updatedAt: NOW });
    }
    if (path === "/api/v1/session") return json(route, {
      user: { id: OWNER_B, systemKey: "initial-owner", displayName: "Initial Owner", settings: {} },
      authentication: "deferred"
    });
    if (path === "/api/v1/providers") return json(route, { providers: [] });
    if (path === "/api/v1/worlds") return json(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return json(route, { campaigns: [] });
    if (path === "/api/v1/dashboard/stats") return json(route, {});
    return json(route, {});
  });
  return evidence;
}

async function installDisconnectingUploadApi(page: Page): Promise<{ uploadsCreated: number; resumes: number }> {
  const evidence = { uploadsCreated: 0, resumes: 0 };
  let disconnectNextChunk = true;
  let uploadReceived = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/meta") return json(route, {
      application: { name: "Infinite Quest Nexus", version: "0.1.0", commit: null, builtAt: null },
      capabilities: { systemArchive: true }
    });
    if (path === "/api/v1/system-imports/uploads" && request.method() === "POST") {
      evidence.uploadsCreated += 1;
      return json(route, { id: UPLOAD_ID, status: "created", byteLength: 6, receivedBytes: 0, expiresAt: preview.expiresAt }, 201);
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}` && request.method() === "GET") {
      evidence.resumes += 1;
      return json(route, { id: UPLOAD_ID, status: "uploading", byteLength: 6, receivedBytes: uploadReceived, expiresAt: preview.expiresAt });
    }
    if (path.includes(`/system-imports/uploads/${UPLOAD_ID}/chunks/`)) {
      if (disconnectNextChunk) {
        disconnectNextChunk = false;
        return route.abort("internetdisconnected");
      }
      uploadReceived += request.postDataBuffer()?.byteLength ?? 0;
      return json(route, { id: UPLOAD_ID, status: "uploading", byteLength: 6, receivedBytes: uploadReceived, expiresAt: preview.expiresAt });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}/complete`) {
      return json(route, { id: UPLOAD_ID, status: "completed", byteLength: 6, receivedBytes: 6, expiresAt: preview.expiresAt });
    }
    if (path === "/api/v1/system-imports/preview") return json(route, preview);
    if (path === "/api/v1/session") return json(route, {
      user: { id: OWNER_B, systemKey: "initial-owner", displayName: "Initial Owner", settings: {} },
      authentication: "deferred"
    });
    if (path === "/api/v1/providers") return json(route, { providers: [] });
    if (path === "/api/v1/worlds") return json(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return json(route, { campaigns: [] });
    if (path === "/api/v1/dashboard/stats") return json(route, {});
    return json(route, {});
  });
  return evidence;
}

async function installRecoveryFenceApi(
  page: Page,
  kind: "export" | "import",
): Promise<Readonly<{
  evidence: { oldRecoveryGets: number; newerCreates: number };
  releaseOldRecovery(): void;
}>> {
  let releaseOldRecovery = (): void => undefined;
  const oldRecoveryGate = new Promise<void>((resolve) => { releaseOldRecovery = resolve; });
  const evidence = { oldRecoveryGets: 0, newerCreates: 0 };
  let uploadReceived = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/meta") return json(route, {
      application: { name: "Infinite Quest Nexus", version: "0.1.0", commit: null, builtAt: null },
      capabilities: { systemArchive: true },
    });
    if (path === "/api/v1/session") return json(route, {
      user: { id: OWNER_B, systemKey: "initial-owner", displayName: "Initial Owner", settings: {} },
      authentication: "deferred",
    });
    if (path === `/api/v1/system-exports/${JOB_ID}` && request.method() === "GET") {
      evidence.oldRecoveryGets += 1;
      await oldRecoveryGate;
      return json(route, {
        id: JOB_ID, kind: "export", status: "published", report: null,
        createdAt: NOW, updatedAt: NOW,
      }).catch(() => undefined);
    }
    if (kind === "export" && path === "/api/v1/system-exports" && request.method() === "POST") {
      evidence.newerCreates += 1;
      return json(route, {
        id: NEWER_EXPORT_JOB_ID, kind: "export", status: "published", report: null,
        createdAt: NOW, updatedAt: NOW,
      }, 202);
    }
    if (path === `/api/v1/system-exports/${NEWER_EXPORT_JOB_ID}` && request.method() === "GET") {
      return json(route, {
        id: NEWER_EXPORT_JOB_ID, kind: "export", status: "published", report: null,
        createdAt: NOW, updatedAt: NOW,
      });
    }
    if (kind === "import" && path === `/api/v1/system-imports/${PRIOR_IMPORT_JOB_ID}` && request.method() === "GET") {
      evidence.oldRecoveryGets += 1;
      await oldRecoveryGate;
      return json(route, {
        id: PRIOR_IMPORT_JOB_ID, kind: "import", status: "completed", report,
        createdAt: NOW, updatedAt: NOW,
      }).catch(() => undefined);
    }
    if (path === "/api/v1/system-imports/uploads" && request.method() === "POST") {
      return json(route, {
        id: UPLOAD_ID, status: "created", byteLength: 6, receivedBytes: 0,
        expiresAt: preview.expiresAt,
      }, 201);
    }
    if (path.includes(`/system-imports/uploads/${UPLOAD_ID}/chunks/`)) {
      uploadReceived += request.postDataBuffer()?.byteLength ?? 0;
      return json(route, {
        id: UPLOAD_ID, status: "uploading", byteLength: 6,
        receivedBytes: uploadReceived, expiresAt: preview.expiresAt,
      });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}/complete`) {
      return json(route, {
        id: UPLOAD_ID, status: "completed", byteLength: 6,
        receivedBytes: 6, expiresAt: preview.expiresAt,
      });
    }
    if (path === "/api/v1/system-imports/preview") return json(route, preview);
    if (kind === "import" && path === "/api/v1/system-imports" && request.method() === "POST") {
      evidence.newerCreates += 1;
      return json(route, {
        id: NEWER_IMPORT_JOB_ID, kind: "import", status: "completed", report,
        createdAt: NOW, updatedAt: NOW,
      }, 202);
    }
    if (path === `/api/v1/system-imports/${NEWER_IMPORT_JOB_ID}` && request.method() === "GET") {
      return json(route, {
        id: NEWER_IMPORT_JOB_ID, kind: "import", status: "completed", report,
        createdAt: NOW, updatedAt: NOW,
      });
    }
    if (path === "/api/v1/providers") return json(route, { providers: [] });
    if (path === "/api/v1/worlds") return json(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return json(route, { campaigns: [] });
    if (path === "/api/v1/dashboard/stats") return json(route, {});
    return json(route, {});
  });
  return Object.freeze({ evidence, releaseOldRecovery });
}

const surfaces = [
  {
    name: "replacement",
    url: "http://127.0.0.1:43174/app/data-transfer",
    file: "#system-archive-file",
    preview: '[data-system-preview="ready"]',
    commit: '[data-action="commit-system-import"]',
    report: '[data-system-import-state="completed"]',
    acknowledgements: '[data-system-acknowledgements] input[type="checkbox"]',
    createExport: '[data-action="create-system-export"]',
    cancel: '[data-action="cancel-system-operation"]',
    download: "[data-system-download]",
    progress: "[data-system-progress]",
    error: "[data-system-error]"
  },
  {
    name: "legacy Nexus",
    url: "http://127.0.0.1:43173/nexus/index.html#data-transfer",
    file: "#systemArchiveFile",
    preview: '#systemImportPreview[data-system-preview="ready"]',
    commit: "#commitSystemImport",
    report: '#systemImportReport[data-system-import-state="completed"]',
    acknowledgements: '#systemImportAcknowledgements input[type="checkbox"]',
    createExport: "#createSystemArchive",
    cancel: "#cancelSystemArchive",
    download: "#systemArchiveDownload",
    progress: "#systemArchiveProgress",
    error: "#systemArchiveError"
  }
] as const;

for (const surface of surfaces) {
  test(`${surface.name} renders the mocked Task 6 preview and report evidence without client ZIP inspection`, async ({ page }, testInfo) => {
    await installDataTransferApi(page);
    await page.goto(surface.url);
    await expect(page.getByRole("heading", { name: "Data Transfer", exact: true, level: 1 })).toBeVisible();
    await page.locator(surface.file).setInputFiles({
      name: "owner-system.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system")
    });
    await expect(page.locator(surface.preview)).toBeVisible();
    await expect(page.locator(surface.preview).getByText("Destination must be empty", { exact: false })).toBeVisible();
    const previewEvidence = await page.locator(surface.preview).textContent();
    for (const expected of [
      `Source owner ${OWNER_A}`,
      `Destination owner ${OWNER_B}`,
      `Archive fingerprint ${"a".repeat(64)}`,
      "Archive format 1",
      "Source application 0.1.0",
      "Source migration 0079_resumable_system_archive_uploads",
      "Destination application 0.1.0",
      "Destination migration 0079_resumable_system_archive_uploads",
      "map-source-owner-to-initial-owner",
      "disable-provider-profiles",
      "Staging capacity",
      "Asset-root capacity",
      "generation 1",
      "illustration 2",
      "chronicle 3",
      "imports 0",
      "system-archive 0"
    ]) expect(previewEvidence).toContain(expected);

    await page.locator(surface.commit).click();
    await expect(page.getByRole("alert")).toContainText("Review every acknowledgement");
    await expect(page.locator(surface.acknowledgements).first()).toBeFocused();
    for (const checkbox of await page.locator(surface.acknowledgements).all()) await checkbox.check();
    await page.locator(surface.commit).click();
    await expect(page.locator(surface.report)).toBeVisible();
    await expect(page.getByText("Integrity verified", { exact: true })).toBeVisible();
    const reportEvidence = await page.locator(surface.report).textContent();
    for (const expected of [
      `Source owner ${OWNER_A}`,
      `Destination owner ${OWNER_B}`,
      `Archive fingerprint ${"a".repeat(64)}`,
      "Archive format 1",
      "map-source-owner-to-initial-owner",
      "disable-provider-profiles",
      "Fingerprint verified",
      "Records matched",
      "Original assets matched",
      "generation 1",
      "illustration 2",
      "chronicle 3",
      "imports 0",
      "system-archive 0",
      "No terminal warnings or errors",
      "Chronicle index: queued",
      "Asset thumbnails: queued"
    ]) expect(reportEvidence).toContain(expected);
    const focusedActionColors = await page.locator(surface.commit).evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(focusedActionColors.foreground).not.toBe(focusedActionColors.background);
    await page.screenshot({
      path: testInfo.outputPath(`${surface.name.toLowerCase().replaceAll(" ", "-")}-data-transfer.png`),
      fullPage: true
    });

    await page.setViewportSize({ width: 375, height: 760 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test(`${surface.name} cancels an export through the mocked Task 6 job contract`, async ({ page }) => {
    await installDataTransferApi(page);
    await page.goto(surface.url);
    await page.locator(surface.createExport).click();
    await expect(page.locator(surface.cancel)).toBeEnabled();
    await page.locator(surface.cancel).click();
    await expect(page.getByText("System Export: cancelled.", { exact: true })).toBeVisible();
  });

  test(`${surface.name} resolves and cancels an ambiguously accepted export before its durable handle returns`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, { holdFirstExportCreate: true });
    await page.goto(surface.url);
    await page.locator(surface.createExport).click();
    await expect(page.locator(surface.cancel)).toBeEnabled();

    try {
      await page.locator(surface.cancel).click();
      await expect(page.getByText("System Export: cancelled.", { exact: true })).toBeVisible();
      expect(evidence.exportCreates).toHaveLength(2);
      expect(evidence.exportCreates[1]?.idempotencyKey).toBe(evidence.exportCreates[0]?.idempotencyKey);
      expect(evidence.cancelledExportJobIds).toEqual([JOB_ID]);
      await expect(page.getByText("Local System Archive work cancelled.", { exact: true })).toHaveCount(0);
    } finally {
      evidence.releaseFirstExportCreate();
    }
  });

  test(`${surface.name} keeps durable cancellation single-flight while the server response is delayed`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, { holdExportCancel: true });
    await page.goto(surface.url);
    await page.locator(surface.createExport).click();
    await expect(page.locator(surface.cancel)).toBeEnabled();

    try {
      await page.locator(surface.cancel).evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error("Expected the Data Transfer cancel control to be an HTML element.");
        }
        element.click();
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(page.locator(surface.cancel)).toBeDisabled();
      await expect.poll(() => evidence.exportCancelRequests).toBe(1);
    } finally {
      evidence.releaseExportCancel();
    }
    await expect(page.getByText("System Export: cancelled.", { exact: true })).toBeVisible();
    expect(evidence.cancelledExportJobIds).toEqual([JOB_ID]);
  });

  test(`${surface.name} restores a mocked published export after reload without duplicate creation`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, { initialExportStatus: "published" });
    await page.goto(surface.url);
    await page.locator(surface.createExport).click();
    await expect(page.locator(surface.download)).toBeVisible();
    const operationKeys = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("systemArchiveOperation")));
    expect(operationKeys).toHaveLength(1);
    expect(operationKeys[0]).toContain(OWNER_B);

    await page.reload();
    await expect(page.locator(surface.download)).toBeVisible();
    expect(evidence.exportPosts).toBe(1);
    expect(evidence.exportGets).toBe(1);
  });

  test(`${surface.name} recovers mocked export and import operations independently`, async ({ page }) => {
    await installDataTransferApi(page, true, { initialExportStatus: "queued" });
    await page.addInitScript(({ ownerId, jobId }) => {
      sessionStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:export`, JSON.stringify({
        kind: "export",
        idempotencyKey: "persisted-export-key",
        jobId
      }));
      sessionStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:import`, JSON.stringify({
        kind: "import",
        idempotencyKey: "persisted-import-key",
        jobId,
        previewHandle: "opaque-preview-authority"
      }));
    }, { ownerId: OWNER_B, jobId: JOB_ID });

    await page.goto(surface.url);
    await expect(page.locator(surface.report)).toBeVisible();
    await expect(page.locator(surface.cancel)).toBeEnabled();
    await page.locator(surface.cancel).click();
    await expect(page.getByText("System Export: cancelled.", { exact: true })).toBeVisible();
  });

  test(`${surface.name} fences a delayed recovered export behind a newer export identity`, async ({ page }) => {
    const recovery = await installRecoveryFenceApi(page, "export");
    await page.addInitScript(({ ownerId, jobId }) => {
      sessionStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:export`, JSON.stringify({
        kind: "export", idempotencyKey: "delayed-export-a", jobId,
      }));
    }, { ownerId: OWNER_B, jobId: JOB_ID });
    await page.goto(surface.url);
    await expect.poll(() => recovery.evidence.oldRecoveryGets).toBe(1);

    await page.locator(surface.createExport).click();
    await expect(page.locator(surface.download)).toHaveAttribute("href", new RegExp(NEWER_EXPORT_JOB_ID));
    const newerStored = await page.evaluate((ownerId) => JSON.parse(
      sessionStorage.getItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:export`) ?? "null",
    ), OWNER_B);
    expect(newerStored).toMatchObject({ kind: "export", jobId: NEWER_EXPORT_JOB_ID });
    expect(recovery.evidence.newerCreates).toBe(1);

    recovery.releaseOldRecovery();
    await page.waitForTimeout(20);
    const afterRecoveredA = await page.evaluate((ownerId) => JSON.parse(
      sessionStorage.getItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:export`) ?? "null",
    ), OWNER_B);
    expect(afterRecoveredA).toEqual(newerStored);
    await expect(page.locator(surface.download)).toHaveAttribute("href", new RegExp(NEWER_EXPORT_JOB_ID));
    await expect(page.locator(surface.error)).toBeHidden();
  });

  test(`${surface.name} fences a delayed recovered import behind a newer import identity`, async ({ page }) => {
    const recovery = await installRecoveryFenceApi(page, "import");
    await page.addInitScript(({ ownerId, jobId }) => {
      sessionStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:import`, JSON.stringify({
        kind: "import", idempotencyKey: "delayed-import-a", jobId,
        previewHandle: "delayed-preview-a",
      }));
    }, { ownerId: OWNER_B, jobId: PRIOR_IMPORT_JOB_ID });
    await page.goto(surface.url);
    await expect.poll(() => recovery.evidence.oldRecoveryGets).toBe(1);

    await page.locator(surface.file).setInputFiles({
      name: "newer-owner-system.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system"),
    });
    await expect(page.locator(surface.preview)).toBeVisible();
    for (const checkbox of await page.locator(surface.acknowledgements).all()) await checkbox.check();
    await page.locator(surface.commit).click();
    await expect(page.locator(surface.report)).toBeVisible();
    const newerStored = await page.evaluate((ownerId) => JSON.parse(
      sessionStorage.getItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:import`) ?? "null",
    ), OWNER_B);
    expect(newerStored).toMatchObject({ kind: "import", jobId: NEWER_IMPORT_JOB_ID });
    expect(recovery.evidence.newerCreates).toBe(1);

    recovery.releaseOldRecovery();
    await page.waitForTimeout(20);
    const afterRecoveredA = await page.evaluate((ownerId) => JSON.parse(
      sessionStorage.getItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:import`) ?? "null",
    ), OWNER_B);
    expect(afterRecoveredA).toEqual(newerStored);
    await expect(page.locator(surface.report)).toBeVisible();
    await expect(page.locator(surface.error)).toBeHidden();
  });

  test(`${surface.name} recovers a mocked ambiguous import commit after reload`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, { disconnectFirstImportCommit: true });
    await page.goto(surface.url);
    await page.locator(surface.file).setInputFiles({
      name: "ambiguous-owner-system.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system")
    });
    await expect(page.locator(surface.preview)).toBeVisible();
    for (const checkbox of await page.locator(surface.acknowledgements).all()) await checkbox.check();
    await page.locator(surface.commit).click();
    await expect(page.locator(surface.error)).toBeVisible();
    await expect(page.locator(surface.preview)).toBeHidden();
    const operationKeys = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("systemArchiveOperation") && key.endsWith(":import")));
    expect(operationKeys).toHaveLength(1);

    await page.reload();
    await expect(page.locator(surface.report)).toBeVisible();
    expect(evidence.importCommits).toHaveLength(2);
    expect(evidence.importCommits[1]?.idempotencyKey).toBe(evidence.importCommits[0]?.idempotencyKey);
  });

  test(`${surface.name} cancels a newer ambiguously accepted import after a prior import completed`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, {
      disconnectFirstImportCommit: true,
      acceptedImportJobId: AMBIGUOUS_IMPORT_JOB_ID
    });
    await page.addInitScript(({ ownerId, priorJobId }) => {
      sessionStorage.setItem(`infiniteQuest.systemArchiveOperation.v1:${ownerId}:import`, JSON.stringify({
        kind: "import",
        idempotencyKey: "prior-completed-import-key",
        jobId: priorJobId,
        previewHandle: "prior-preview-authority"
      }));
    }, { ownerId: OWNER_B, priorJobId: PRIOR_IMPORT_JOB_ID });
    await page.goto(surface.url);
    await expect(page.locator(surface.report)).toBeVisible();

    await page.locator(surface.file).setInputFiles({
      name: "newer-ambiguous-owner-system.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system")
    });
    await expect(page.locator(surface.preview)).toBeVisible();
    for (const checkbox of await page.locator(surface.acknowledgements).all()) await checkbox.check();
    await page.locator(surface.commit).click();
    await expect(page.locator(surface.error)).toBeVisible();
    await expect(page.locator(surface.preview)).toBeHidden();

    await page.locator(surface.cancel).click();
    await expect(page.getByText("System Import: cancelled.", { exact: true })).toBeVisible();
    expect(evidence.importCommits).toHaveLength(2);
    expect(evidence.importCommits[1]?.idempotencyKey).toBe(evidence.importCommits[0]?.idempotencyKey);
    expect(evidence.cancelledImportJobIds).toEqual([AMBIGUOUS_IMPORT_JOB_ID]);
    expect(evidence.cancelledUploadIds).toEqual([]);
  });

  test(`${surface.name} exposes mocked upload phases through a labelled progress live region`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, {
      holdUploadCreate: true,
      holdFirstUploadChunk: true
    });
    await page.goto(surface.url);
    await page.locator(surface.file).setInputFiles({
      name: "accessible-progress.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system")
    });
    const progressRegion = page.locator(surface.progress);
    await expect(progressRegion).toHaveAttribute("role", "status");
    await expect(progressRegion).toHaveAttribute("aria-live", "polite");
    await expect(progressRegion.getByRole("progressbar", { name: /Checking archive integrity/i })).toBeVisible();

    evidence.releaseUploadCreate();
    await expect(progressRegion.getByRole("progressbar", { name: /Uploading resumable chunks/i })).toBeVisible();
    evidence.releaseFirstUploadChunk();
    await expect(page.locator(surface.preview)).toBeVisible();
  });

  test(`${surface.name} clears a cancelled durable upload so it cannot be cancelled twice`, async ({ page }) => {
    const evidence = await installDataTransferApi(page, true, { holdFirstUploadChunk: true });
    await page.goto(surface.url);
    await page.locator(surface.file).setInputFiles({
      name: "cancel-durable-upload.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system")
    });
    await expect(page.locator(surface.progress).getByRole("progressbar", { name: /Uploading resumable chunks/i })).toBeVisible();
    await expect(page.locator(surface.cancel)).toBeEnabled();

    try {
      await page.locator(surface.cancel).click();
      await expect(page.getByText("System Archive upload cancelled.", { exact: true })).toBeVisible();
      await expect(page.locator(surface.cancel)).toBeDisabled();
      await page.locator(surface.cancel).dispatchEvent("click");
      expect(evidence.cancelledUploadIds).toEqual([UPLOAD_ID]);
    } finally {
      evidence.releaseFirstUploadChunk();
    }
  });

  test(`${surface.name} resumes a mocked durable upload after a disconnect and reload`, async ({ page }) => {
    const evidence = await installDisconnectingUploadApi(page);
    const selectedArchive = {
      name: "resume-owner-system.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("system")
    };
    await page.goto(surface.url);
    await page.locator(surface.file).setInputFiles(selectedArchive);
    await expect(page.locator(surface.error)).toBeVisible();

    await page.reload();
    await page.locator(surface.file).setInputFiles(selectedArchive);
    await expect(page.locator(surface.preview)).toBeVisible();
    expect(evidence.uploadsCreated).toBe(1);
    expect(evidence.resumes).toBe(1);
  });
}

test("legacy #imports deep link opens the unified Data Transfer view", async ({ page }) => {
  await installDataTransferApi(page, false);
  await page.goto("http://127.0.0.1:43173/nexus/index.html#imports");
  await expect(page.locator("body")).toHaveAttribute("data-management-view", "data-transfer");
  await expect(page.locator("#imports")).toBeVisible();
  await expect(page.locator("#navDataTransfer")).toHaveClass(/active/);
  await expect(page.getByText("System Archive is not enabled on this instance", { exact: false })).toBeVisible();
});
