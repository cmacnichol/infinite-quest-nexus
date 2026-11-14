import { chromium, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

test("actual Nexus world editor supports native Chromium 200 percent tab zoom", async ({}, info) => {
  const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
  // mkdtemp gives this run sole ownership; profiles/extensions are retained as test artifacts.
  await mkdir(info.outputDir, { recursive: true });
  const owned = await mkdtemp(resolve(info.outputDir, "native-zoom-"));
  const extension = resolve(owned, "extension");
  await mkdir(extension);
  await writeFile(resolve(extension, "manifest.json"), JSON.stringify({ manifest_version: 3,
    name: "Nexus owned native zoom probe", version: "1.0.0", permissions: ["tabs"],
    background: { service_worker: "worker.js" } }));
  await writeFile(resolve(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const options = { channel: "chromium", headless: true, viewport: null,
    args: ["--window-size=1280,900", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  Reflect.set(options, "deviceScaleFactor", undefined);
  const context = await chromium.launchPersistentContext(resolve(owned, "profile"), options);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await installLegacyUiFixture(page, legacyUiFixture({ turnCount: 0, worldCount: 0, campaignCount: 0 }));
    await page.goto(`${origin}/nexus/index.html#world-library`);
    await page.locator("#newWorld").click();
    await page.locator("#worldTitle").fill("Native zoom destination");
    await page.locator('[data-world-author-step="character"]').click();
    await page.locator("#addPlayableCharacter").click();
    await page.locator("#characterName").fill("Zoom traveler");
    await page.locator("#characterRole").fill("Guide at native zoom");
    await page.getByRole("button", { name: "Continue in detailed editor" }).click();
    await expect(page.locator(".character-workspace")).toBeVisible();
    const baseline = await page.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const tabId = await worker.evaluate(async expectedOrigin => {
      const chrome = (globalThis as any).chrome;
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const matches = tabs.filter((tab: any) => tab.url && new URL(tab.url).origin === expectedOrigin);
      if (matches.length !== 1) throw new Error("Owned active Nexus tab not found");
      await chrome.tabs.setZoomSettings(matches[0].id, { mode: "automatic", scope: "per-tab" });
      await chrome.tabs.setZoom(matches[0].id, 2);
      return matches[0].id;
    }, origin);
    await expect.poll(() => worker.evaluate(id => (globalThis as any).chrome.tabs.getZoom(id), tabId)).toBe(2);

    await page.getByLabel("Section", { exact: true }).selectOption("identity");
    const aliases = page.locator('[data-character-profile-path="identity.aliases"]');
    await aliases.fill("Retained zoom alias");
    await expect(page.getByLabel("Section", { exact: true }).locator("option:checked")).toHaveText("Identity · 1 detail");
    await aliases.focus();
    await expect(aliases).toBeFocused();
    await expect(aliases).toBeInViewport();
    const metrics = await page.evaluate(() => {
      const focused = document.activeElement!.getBoundingClientRect();
      const footer = document.querySelector(".character-workspace-footer")!.getBoundingClientRect();
      const content = document.querySelector(".character-workspace-working");
      return { innerWidth, innerHeight, outerWidth, devicePixelRatio,
        rootZoom: getComputedStyle(document.documentElement).zoom, visualViewportScale: visualViewport?.scale,
        visualViewportHeight: visualViewport?.height,
        content: content ? { rect: content.getBoundingClientRect().toJSON(), clientHeight: content.clientHeight, scrollHeight: content.scrollHeight, overflow: getComputedStyle(content).overflow } : null,
        scrollWidth: document.documentElement.scrollWidth,
        focused: { top: focused.top, bottom: focused.bottom, height: focused.height }, footer: { top: footer.top, bottom: footer.bottom } };
    });
    expect(metrics.outerWidth).toBe(baseline.outerWidth);
    expect(metrics.innerWidth / baseline.innerWidth).toBeCloseTo(0.5, 1);
    expect(metrics.devicePixelRatio / baseline.devicePixelRatio).toBeCloseTo(2, 1);
    expect(metrics.rootZoom).toBe("1");
    expect(metrics.visualViewportScale).toBe(1);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
    await expect(page.locator("#saveCharacter")).toBeInViewport();
    await expect(page.locator("#cancelCharacter")).toBeInViewport();
    const targets = await page.locator(".character-workspace button:visible, .character-workspace select:visible").evaluateAll(nodes =>
      nodes.map(node => ({ name: node.getAttribute("aria-label") ?? node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    expect(targets.every(target => target.width >= 44 && target.height >= 44)).toBe(true);
    const previewButton = page.getByRole("button", { name: "Preview sheet", exact: true });
    for (let index = 0; index < 30 && !await previewButton.evaluate(node => node === document.activeElement); index += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(previewButton).toBeFocused();
    await aliases.focus();
    const screenshotRoot = process.env.CAST_SCREENSHOT_ROOT ?? info.outputDir;
    await mkdir(screenshotRoot, { recursive: true });
    const capture = async (name: string) => {
      const cdp = await context.newCDPSession(page);
      try {
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await writeFile(resolve(screenshotRoot, name), Buffer.from(screenshot.data, "base64"));
      } finally { await cdp.detach(); }
    };
    await capture("nexus-native-zoom-200-editor.png");
    await writeFile(resolve(screenshotRoot, "nexus-native-zoom-200-metrics.json"), JSON.stringify({ tabZoom: 2, baseline, metrics, targets }, null, 2));
    expect(metrics.focused.bottom).toBeLessThanOrEqual(metrics.footer.top);
    await page.getByRole("button", { name: "Preview sheet", exact: true }).click();
    await expect(page.locator(".character-workspace-preview")).toContainText("Retained zoom alias");
    await page.getByRole("button", { name: "Return to editing" }).click();
    await expect(aliases).toHaveValue("Retained zoom alias");
    await page.locator("#saveCharacter").click();
    await expect(page.locator("#characterDialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "Edit Zoom traveler", exact: true })).toBeVisible();
    await capture("nexus-native-zoom-200-applied.png");
  } finally {
    await context.close();
  }
});



