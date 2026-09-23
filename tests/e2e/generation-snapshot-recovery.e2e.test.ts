import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generationJobSnapshotSchema, generationResultSchema } from "../../packages/contracts/src/index.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

for (const surface of ["legacy", "web-next"] as const) {
  test(`${surface} loads the saved turn after rejected stream and polling snapshots without refresh or regeneration`, async ({ page }, testInfo) => {
    const payloads = quietLeafApiPayloads({ pendingGeneration: true });
    const jobId = payloads.syncStatus.pendingGeneration!.id;
    const turn = { ...payloads.turns.turns[0]!, id: "77777777-7777-4777-8777-777777777777", turnNumber: 2,
      narration: "The recovered turn appears without refreshing the page." };
    const completed = generationJobSnapshotSchema.parse({
      ...payloads.syncStatus.pendingGeneration, campaignId: payloads.campaignId,
      status: "completed", attempts: 1, resultTurnId: turn.id,
      requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit",
      errorCode: null, errorMessage: null, partialNarration: null
    });
    const result = generationResultSchema.parse({
      ...turn, ...completed, turnNumber: 2, narration: turn.narration,
      modelMetadata: null, mechanics: null, stateSnapshot: {}, reportedCost: null
    });
    const reads: string[] = [];
    const writes: string[] = [];
    const errors: string[] = [];
    let resultLoaded = false;
    let pollingReads = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const respond = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (request.method() !== "GET") {
        writes.push(`${request.method()} ${path}`);
        return route.abort();
      }
      reads.push(path);
      if (path === "/api/v1/session") return respond(payloads.session);
      if (path === "/api/v1/campaigns") return respond(payloads.campaigns);
      if (path === "/api/v1/worlds") return respond(payloads.worlds);
      if (path.endsWith("/sync-status")) return respond(resultLoaded ? {
        ...payloads.syncStatus, pendingGeneration: null,
        campaign: { ...payloads.syncStatus.campaign, activeTurnNumber: 2 },
        turns: { ...payloads.turns, turns: [...payloads.turns.turns, turn] }
      } : payloads.syncStatus);
      if (path.endsWith("/turns")) return respond({ ...payloads.turns, turns: resultLoaded ? [...payloads.turns.turns, turn] : payloads.turns.turns });
      if (path.endsWith("/state") || path.endsWith("/state/inspection")) return respond(payloads.runtimeState);
      if (path.endsWith("/illustration-config")) return respond(payloads.illustrationConfig);
      if (path.endsWith("/illustration-segments")) return respond(payloads.illustrationSegments);
      if (path === `/api/v1/generation-jobs/${jobId}/stream`) return route.fulfill({
        contentType: "text/event-stream", body: 'data: {"invalid":true}\n\n'
      });
      if (path === `/api/v1/generation-jobs/${jobId}`) {
        pollingReads += 1;
        return respond(pollingReads === 1 ? { invalid: true } : completed);
      }
      if (path === `/api/v1/generation-jobs/${jobId}/result`) {
        resultLoaded = true;
        return respond(result);
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Unavailable in fixture"}' });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const url = surface === "legacy"
      ? `${process.env.SNAPSHOT_RECOVERY_LEGACY_ORIGIN ?? "http://127.0.0.1:43173"}/story/${payloads.campaignId}`
      : `${process.env.SNAPSHOT_RECOVERY_NEXT_ORIGIN ?? "http://127.0.0.1:43174"}/app/story/${payloads.campaignId}`;
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8"))
        .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`**/story/${payloads.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.goto(url);
    await expect(page.getByText(turn.narration, { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Generation failed");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect(reads.filter(path => path === `/api/v1/generation-jobs/${jobId}/stream`)).toHaveLength(1);
    expect(reads).toContain(`/api/v1/generation-jobs/${jobId}`);
    expect(reads).toContain(`/api/v1/generation-jobs/${jobId}/result`);
    expect(pollingReads).toBeGreaterThanOrEqual(2);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: process.env.SNAPSHOT_RECOVERY_SCREENSHOTS
      ? join(process.env.SNAPSHOT_RECOVERY_SCREENSHOTS, `${surface}.png`)
      : testInfo.outputPath(`${surface}.png`), fullPage: true });
  });
}
