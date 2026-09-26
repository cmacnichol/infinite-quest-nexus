import { test, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

for (const surface of ["legacy", "web-next"] as const) {
  test(`${surface} refreshes invalid illustration data into a visible stored image without generation`, async ({ page }) => {
    const fixture = quietLeafApiPayloads({ illustration: "enabled" });
    const writes: string[] = [];
    const errors: string[] = [];
    let invalid = true;
    page.on("pageerror", error => errors.push(error.message));
    const png = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#8ab4cc" } }).png().toBuffer();
    await page.route("**/ui-test/quiet-leaf-door.png", route => route.fulfill({ contentType: "image/png", body: png }));
    await page.route("**/api/v1/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const respond = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (request.method() !== "GET") { writes.push(path); return respond({}); }
      if (path.endsWith("/illustration-config")) return respond(fixture.illustrationConfig);
      if (path.endsWith("/illustration-segments")) {
        const response = structuredClone(fixture.illustrationSegments);
        if (invalid) response.segments[0]!.variants[0]!.createdAt = "invalid-timestamp";
        return respond(response);
      }
      if (path.endsWith("/image-jobs")) return respond({ jobs: [] });
      if (path.endsWith("/sync-status")) return respond(fixture.syncStatus);
      if (path.endsWith("/turns")) return respond(fixture.turns);
      if (path.endsWith("/state")) return respond(fixture.runtimeState);
      if (path.endsWith("/session")) return respond(fixture.session);
      if (path.endsWith("/campaigns")) return respond(fixture.campaigns);
      if (path.endsWith("/worlds")) return respond(fixture.worlds);
      if (path.endsWith("/providers")) return respond({ providers: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Fixture text", providerType: "openai_compatible", providerRole: "text",
        baseUrl: "http://provider.invalid", defaultModel: "fixture", contextWindowTokens: 32768, maxOutputTokens: 4096,
        temperature: 0, requestTimeoutMs: 30000, configuration: {}, enabled: true, isDefault: true,
        healthStatus: "healthy", consecutiveFailures: 0, lastHealthCheckAt: null, lastHealthError: null, hasApiKey: false,
        createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z"
      }] });
      return respond({});
    });
    const origin = surface === "legacy" ? "http://127.0.0.1:43173" : "http://127.0.0.1:43174";
    if (surface === "legacy") {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`${origin}/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/${surface === "legacy" ? "story" : "app/story"}/${fixture.campaignId}`);
    await expect(page.getByText(/server returned invalid illustration data/).first()).toBeVisible();
    invalid = false;
    await page.getByRole("button", { name: "Refresh illustrations", exact: true }).click();
    const image = page.locator('img[src="/ui-test/quiet-leaf-door.png"]:visible').first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320);
    await expect(page.getByText(/server returned invalid illustration data/)).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir("docs/review/assets/illustration-repair", { recursive: true });
    await page.screenshot({ path: `docs/review/assets/illustration-repair/${surface}-recovered.png`, fullPage: true });
  });
}
