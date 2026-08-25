import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = "2026-08-25T12:00:00.000Z";
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";
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

async function installDataTransferApi(page: Page, enabled = true): Promise<void> {
  let uploadReceived = 0;
  let exportStatus = "queued";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/meta") return json(route, {
      application: { name: "Infinite Quest Nexus", version: "0.1.0", commit: null, builtAt: null },
      capabilities: { systemArchive: enabled }
    });
    if (path === "/api/v1/system-exports" && request.method() === "POST") {
      return json(route, { id: JOB_ID, kind: "export", status: exportStatus, report: null, createdAt: NOW, updatedAt: NOW }, 202);
    }
    if (path === `/api/v1/system-exports/${JOB_ID}` && request.method() === "GET") {
      return json(route, { id: JOB_ID, kind: "export", status: exportStatus, report: null, createdAt: NOW, updatedAt: NOW });
    }
    if (path === `/api/v1/system-exports/${JOB_ID}` && request.method() === "DELETE") {
      exportStatus = "cancelled";
      return json(route, { id: JOB_ID, kind: "export", status: exportStatus, report: null, createdAt: NOW, updatedAt: NOW });
    }
    if (path === "/api/v1/system-imports/uploads" && request.method() === "POST") {
      return json(route, { id: UPLOAD_ID, status: "created", byteLength: 6, receivedBytes: 0, expiresAt: preview.expiresAt }, 201);
    }
    if (path.includes(`/system-imports/uploads/${UPLOAD_ID}/chunks/`)) {
      uploadReceived += request.postDataBuffer()?.byteLength ?? 0;
      return json(route, { id: UPLOAD_ID, status: "uploading", byteLength: 6, receivedBytes: uploadReceived, expiresAt: preview.expiresAt });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}/complete`) {
      return json(route, { id: UPLOAD_ID, status: "completed", byteLength: 6, receivedBytes: 6, expiresAt: preview.expiresAt });
    }
    if (path === `/api/v1/system-imports/uploads/${UPLOAD_ID}` && request.method() === "GET") {
      return json(route, { id: UPLOAD_ID, status: "uploading", byteLength: 6, receivedBytes: uploadReceived, expiresAt: preview.expiresAt });
    }
    if (path === "/api/v1/system-imports/preview") return json(route, preview);
    if (path === "/api/v1/system-imports" && request.method() === "POST") {
      return json(route, { id: JOB_ID, kind: "import", status: "queued", report: null, createdAt: NOW, updatedAt: NOW }, 202);
    }
    if (path === `/api/v1/system-imports/${JOB_ID}` && request.method() === "GET") {
      return json(route, { id: JOB_ID, kind: "import", status: "completed", report, createdAt: NOW, updatedAt: NOW });
    }
    if (path === "/api/v1/session") return json(route, { user: { displayName: "Initial Owner", settings: {} }, authentication: "deferred" });
    if (path === "/api/v1/providers") return json(route, { providers: [] });
    if (path === "/api/v1/worlds") return json(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return json(route, { campaigns: [] });
    if (path === "/api/v1/dashboard/stats") return json(route, {});
    return json(route, {});
  });
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
    if (path === "/api/v1/session") return json(route, { user: { displayName: "Initial Owner", settings: {} }, authentication: "deferred" });
    if (path === "/api/v1/providers") return json(route, { providers: [] });
    if (path === "/api/v1/worlds") return json(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return json(route, { campaigns: [] });
    if (path === "/api/v1/dashboard/stats") return json(route, {});
    return json(route, {});
  });
  return evidence;
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
    error: "#systemArchiveError"
  }
] as const;

for (const surface of surfaces) {
  test(`${surface.name} keeps System Archive preview and confirmation server-owned`, async ({ page }, testInfo) => {
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

    await page.locator(surface.commit).click();
    await expect(page.getByRole("alert")).toContainText("Review every acknowledgement");
    await expect(page.locator(surface.acknowledgements).first()).toBeFocused();
    for (const checkbox of await page.locator(surface.acknowledgements).all()) await checkbox.check();
    await page.locator(surface.commit).click();
    await expect(page.locator(surface.report)).toBeVisible();
    await expect(page.getByText("Integrity verified", { exact: true })).toBeVisible();
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

  test(`${surface.name} can cancel a durable System Archive export`, async ({ page }) => {
    await installDataTransferApi(page);
    await page.goto(surface.url);
    await page.locator(surface.createExport).click();
    await expect(page.locator(surface.cancel)).toBeEnabled();
    await page.locator(surface.cancel).click();
    await expect(page.getByText("System Export: cancelled.", { exact: true })).toBeVisible();
  });

  test(`${surface.name} resumes its durable upload after a disconnect and reload`, async ({ page }) => {
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
