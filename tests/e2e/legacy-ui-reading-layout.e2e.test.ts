import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { illustrationSegmentSchema } from "../../packages/contracts/src/index.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const paragraphs = [
  "The station clock marked the hour as rain moved across the platform. Mara paused beside the ticket window, studying the faded timetable. Beyond the glass, a lamp cast a warm circle across a ledger that someone had left open.",
  "She followed the chalk marks toward the covered bridge. Each mark was clear enough to read without stopping, but the last ended beside an unfamiliar door. From the other side came the quiet sound of someone turning a page.",
  "Mara knocked once and waited. The rain softened, the lamp held steady, and a voice invited her inside. She folded the timetable into her coat pocket before reaching for the handle."
];

async function loadReader(page: Page, illustrated = false) {
  const fixture = legacyUiFixture({ turnCount: 2, worldCount: 1, campaignCount: 1 });
  fixture.turns[1]!.narration = paragraphs.join("\n\n");
  const initialUser = fixture.session.user as Record<string, unknown>;
  let settings: Record<string, unknown> = { ...(initialUser.settings as Record<string, unknown>), continuousReading: false, autoSubmitTurnChoices: false, defaultTurnControlStyle: "action_only" };
  fixture.session.user = { ...initialUser, settings };
  const instrumentation = await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/users/me/profile", async route => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { settings: Record<string, unknown> };
      settings = { ...settings, ...body.settings };
      fixture.session.user = { ...initialUser, settings };
    }
    await route.fulfill({ json: { user: { ...initialUser, settings } } });
  });
  if (illustrated) {
    const narration = String(fixture.turns[1]!.narration);
    const segment = illustrationSegmentSchema.parse({
      setId: "66666666-6666-4666-8666-666666666661", turnId: fixture.turns[1]!.id,
      setStatus: "completed", segmentWordCount: 120, imagesPerSegment: 1, promptMode: "direct",
      id: "66666666-6666-4666-8666-666666666662", ordinal: 0,
      startOffset: 0, endOffset: narration.length, startWord: 0, endWord: narration.split(/\s+/u).length,
      text: narration, status: "completed", promptSource: "direct", directPrompt: "A station.", resolvedPrompt: "A station.",
      variants: [{ assetId: "77777777-7777-4777-8777-777777777771", url: `${origin}/reader-fixture-image.svg`, variantIndex: 0,
        prompt: "A station.", providerType: "synthetic", model: "fixture", createdAt: "2026-10-03T12:00:00Z",
        selectionReason: null, matchScore: null, matchThreshold: null, matchingAlgorithm: null }],
      imageJobId: null, imageJobStatus: null, providerStatus: null, providerProgress: null, errorMessage: null, promptJobStatus: "completed"
    });
    await page.route("**/reader-fixture-image.svg", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#354554"/><rect x="80" y="160" width="480" height="320" fill="#718391"/><text x="320" y="325" text-anchor="middle" font-size="28" fill="white">Illustration layout fixture</text></svg>' }));
    await page.route(`**/api/v1/campaigns/${fixture.campaignId}/illustration-config`, route => route.fulfill({ json: {
      enabled: true, sourcePolicy: "generate_only", matchingScope: "campaign", confidenceProfile: "balanced", repetitionWindow: 0,
      providerProfileId: null, model: "fixture", size: "1024x1024", aspectRatio: "1:1", quality: "standard", outputFormat: "png", maxAttempts: 3,
      segmentWordCount: 120, imagesPerSegment: 1, segmentPromptMode: "direct", refinementPrompt: "A station.", defaultRefinementPrompt: "A station.", updatedAt: "2026-10-03T12:00:00Z"
    } }));
    await page.route(`**/api/v1/campaigns/${fixture.campaignId}/illustration-segments`, route => route.fulfill({ json: { segments: [segment] } }));
  }
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator(".narration p").first()).toHaveText(paragraphs[0]!);
  if (illustrated) {
    await expect(page.locator("#storyIllustrationContent img")).toBeVisible();
    await page.locator("#btnPrev").click();
    await page.locator("#btnNext").click();
    await expect(page.locator(".narration-segment-copy")).toBeVisible();
  }
  return { instrumentation, settings: () => settings };
}

async function capture(page: Page, name: string) {
  if (!process.env.READER_EVIDENCE_DIR) return;
  await mkdir(process.env.READER_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.READER_EVIDENCE_DIR, `${name}.png`), fullPage: !name.includes("profile-appearance") });
}

async function openAppearance(page: Page) {
  await page.locator("#btnOpenUserProfile").click();
  const dialog = page.locator("#userProfileDialog");
  await expect(dialog).toBeVisible();
  const appearance = dialog.locator("[data-reading-appearance]");
  if (!(await appearance.evaluate(element => (element as HTMLDetailsElement).open))) await appearance.locator("summary").click();
  await expect(dialog.locator("[data-reader-area-width]")).toBeVisible();
  return dialog;
}

for (const illustrated of [false, true]) {
  const layout = illustrated ? "illustrated" : "text-only";
  test(`${layout} reader preserves readable prose across desktop and mobile without toolbar appearance controls`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await loadReader(page, illustrated);
    await expect(page.locator("#btnReaderAppearance, #readerAppearancePanel")).toHaveCount(0);
    const prose = page.locator(illustrated ? ".narration-segment-copy" : ".narration").first();
    for (const width of [1440, 1130, 1100, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const measure = await prose.evaluate(element => {
        const box = element.getBoundingClientRect();
        const p = element.querySelector("p")!;
        const next = p.nextElementSibling!;
        return { width: box.width, paragraphGap: next.getBoundingClientRect().top - p.getBoundingClientRect().bottom,
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(measure.width, `usable prose at ${width}px viewport`).toBeGreaterThan(width === 390 ? 280 : 500);
      expect(measure.paragraphGap).toBeGreaterThanOrEqual(17);
      expect(measure.overflow).toBe(false);
      if (width === 1440 || width === 390) await capture(page, `${layout}-standard-${width}`);
    }
    expect(errors).toEqual([]);
  });

  test(`${layout} profile previews and persists font, spacing and full text width`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const fixture = await loadReader(page, illustrated);
    const prose = page.locator(illustrated ? ".narration-segment-copy" : ".narration").first();
    const originalWidth = (await prose.boundingBox())!.width;
    const dialog = await openAppearance(page);
    await dialog.locator("[data-reader-width]").selectOption("full");
    await dialog.locator("[data-reader-font-family]").selectOption("serif");
    await dialog.locator("[data-reader-paragraph-spacing]").selectOption("1.5");
    await dialog.locator("[data-reader-preview]").click();
    await expect(prose).toHaveCSS("font-family", /Georgia/);
    await expect(prose.locator("p").first()).toHaveCSS("margin-bottom", "27px");
    expect((await prose.boundingBox())!.width).toBeGreaterThan(originalWidth + 100);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(prose.locator("p").first()).toHaveCSS("margin-bottom", "18px");
    expect((await prose.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
    await openAppearance(page);
    await dialog.locator("[data-reader-width]").selectOption("full");
    await dialog.locator("[data-reader-font-family]").selectOption("serif");
    await dialog.locator("[data-reader-paragraph-spacing]").selectOption("1.5");
    await page.locator("#btnSaveUserProfile").click();
    await expect(dialog).toBeHidden();
    expect(fixture.settings().readerPreferences).toMatchObject({ widthCh: "full", fontFamily: "serif", paragraphSpacingEm: 1.5, areaWidth: "standard" });
    expect(fixture.settings()).toMatchObject({ autoSubmitTurnChoices: false, continuousReading: false, defaultTurnControlStyle: "action_only" });
    await page.reload();
    if (illustrated) {
      await expect(page.locator("#storyIllustrationContent img")).toBeVisible();
      await page.locator("#btnPrev").click();
      await page.locator("#btnNext").click();
    }
    await expect(prose).toHaveCSS("font-family", /Georgia/);
    await expect(prose.locator("p").first()).toHaveCSS("margin-bottom", "27px");
    await capture(page, `${layout}-full-text-serif`);
  });

  test(`${layout} reading area grows independently of text width and stays responsive`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const fixture = await loadReader(page, illustrated);
    const app = page.locator(".app");
    const prose = page.locator(illustrated ? ".narration-segment-copy" : ".narration").first();
    const standardWidth = (await app.boundingBox())!.width;
    const standardReadingWidth = (await page.locator(".layout").boundingBox())!.width;
    const proseWidth = (await prose.boundingBox())!.width;
    let writes = 0;
    page.on("request", request => { if (request.method() === "PATCH") writes += 1; });
    const dialog = await openAppearance(page);
    await expect(dialog.locator("[data-reader-area-width]")).toHaveValue("standard");
    await dialog.locator("[data-reader-area-width]").selectOption("wide");
    await dialog.locator("[data-reader-preview]").click();
    const wideWidth = (await app.boundingBox())!.width;
    expect(wideWidth).toBeGreaterThan(standardWidth + 200);
    expect((await page.locator(".layout").boundingBox())!.width).toBeGreaterThan(standardReadingWidth + 200);
    expect((await prose.boundingBox())!.width).toBeCloseTo(proseWidth, 0);
    await dialog.locator("[data-reader-area-width]").selectOption("full");
    await dialog.locator("[data-reader-preview]").click();
    const fullWidth = (await app.boundingBox())!.width;
    expect(fullWidth).toBeGreaterThan(wideWidth + 100);
    expect(fullWidth).toBeGreaterThan(1880);
    expect((await page.locator(".layout").boundingBox())!.width).toBeCloseTo(fullWidth, 0);
    expect((await prose.boundingBox())!.width).toBeCloseTo(proseWidth, 0);
    await page.locator("#btnCancelUserProfile").click();
    await expect(dialog).toBeHidden();
    await expect(app).toHaveAttribute("data-reader-area-width", "standard");
    expect((await app.boundingBox())!.width).toBeCloseTo(standardWidth, 0);
    expect(writes).toBe(0);
    await openAppearance(page);
    await dialog.locator("[data-reader-area-width]").selectOption("full");
    await dialog.locator("[data-reader-preview]").click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app).toHaveAttribute("data-reader-area-width", "standard");
    expect((await app.boundingBox())!.width).toBeCloseTo(standardWidth, 0);
    expect(writes).toBe(0);
    await openAppearance(page);
    await dialog.locator("[data-reader-area-width]").selectOption("full");
    await capture(page, `${layout}-profile-appearance`);
    await page.locator("#btnSaveUserProfile").click();
    await expect(dialog).toBeHidden();
    expect(fixture.settings().readerPreferences).toMatchObject({ areaWidth: "full", widthCh: 72 });
    await page.reload();
    if (illustrated) {
      await expect(page.locator("#storyIllustrationContent img")).toBeVisible();
      await page.locator("#btnPrev").click();
      await page.locator("#btnNext").click();
    }
    await expect(app).toHaveAttribute("data-reader-area-width", "full");
    expect((await app.boundingBox())!.width).toBeCloseTo(fullWidth, 0);
    for (const width of [1920, 980, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await app.boundingBox())!.width).toBeGreaterThan(width - 40);
      if (illustrated) {
        const columns = await page.locator(".narration-segment").first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
        expect(columns, `illustrated columns at ${width}px`).toBe(width === 1920 ? 2 : 1);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(page, `${layout}-full-area-${width}`);
    }
  });
}

test("profile appearance controls remain usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadReader(page);
  const dialog = await openAppearance(page);
  await dialog.locator("[data-reader-area-width]").selectOption("full");
  await dialog.locator("[data-reader-font-family]").selectOption("serif");
  await dialog.locator("[data-reader-paragraph-spacing]").selectOption("1.5");
  await dialog.locator("[data-reader-preview]").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.locator("[data-reader-area-width]").scrollIntoViewIfNeeded();
  await capture(page, "profile-appearance-mobile");
  await page.locator("#btnSaveUserProfile").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".narration").first()).toHaveCSS("font-family", /Georgia/);
});
