import { chromium, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { campaignId, fixture } from "./helpers/web-next-sheet-fixture.js";

test("Web-Next sheet edit and Undo at native Chromium 200 percent zoom", async ({}, info) => {
  await mkdir(info.outputDir, { recursive: true });
  const owned = await mkdtemp(resolve(info.outputDir, "native-zoom-"));
  const extension = resolve(owned, "extension"); await mkdir(extension);
  await writeFile(resolve(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Owned zoom probe", version: "1.0.0", permissions: ["tabs"], background: { service_worker: "worker.js" } }));
  await writeFile(resolve(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const options = { channel: "chromium", headless: true, viewport: null, args: ["--window-size=1280,900", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  Reflect.set(options, "deviceScaleFactor", undefined);
  const context = await chromium.launchPersistentContext(resolve(owned, "profile"), options);
  try {
    const page = context.pages()[0] ?? await context.newPage(); await fixture(page, false, true);
    const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}`;
    await page.goto(`${origin}/app/story/${campaignId}`); await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click();
    const dialog = page.locator("dialog.characters-workspace"); await dialog.getByRole("button", { name: "Mara", exact: true }).click();
    const baseline = await page.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const tabId = await worker.evaluate(async expected => { const chrome = (globalThis as any).chrome; const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); const matches = tabs.filter((tab: any) => tab.url && new URL(tab.url).origin === expected); if (matches.length !== 1) throw new Error("Owned tab not found"); await chrome.tabs.setZoomSettings(matches[0].id, { mode: "automatic", scope: "per-tab" }); await chrome.tabs.setZoom(matches[0].id, 2); return matches[0].id; }, origin);
    await expect.poll(() => worker.evaluate(id => (globalThis as any).chrome.tabs.getZoom(id), tabId)).toBe(2);
    await dialog.getByRole("button", { name: "Edit Name", exact: true }).focus(); await page.keyboard.press("Enter");
    const name = dialog.getByRole("textbox", { name: "Name", exact: true }); await expect(name).toBeFocused(); await name.fill("Marin");
    const save = dialog.getByRole("button", { name: "Save", exact: true }); await save.focus(); await page.keyboard.press("Enter");
    const undo = dialog.getByRole("button", { name: "Undo", exact: true }); await expect(undo).toBeVisible();
    const targets = await dialog.locator(".character-sheet-view button:visible").evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    expect(targets.every(target => target.width >= 44 && target.height >= 44)).toBe(true);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const metrics = await page.evaluate(() => ({ innerWidth, outerWidth, devicePixelRatio, scrollWidth: document.documentElement.scrollWidth, rootZoom: getComputedStyle(document.documentElement).zoom, scale: visualViewport?.scale }));
    expect(metrics.innerWidth / baseline.innerWidth).toBeCloseTo(0.5, 1); expect(metrics.devicePixelRatio / baseline.devicePixelRatio).toBeCloseTo(2, 1); expect(metrics.rootZoom).toBe("1"); expect(metrics.scale).toBe(1);
    const root = process.env.CAST_SCREENSHOT_ROOT ?? info.outputDir; await mkdir(root, { recursive: true });
    const cdp = await context.newCDPSession(page);
    try { const capture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(resolve(root, "web-next-sheet-native-zoom-200.png"), Buffer.from(capture.data, "base64")); } finally { await cdp.detach(); }
    await writeFile(resolve(root, "web-next-sheet-native-zoom-200-metrics.json"), JSON.stringify({ tabZoom: 2, baseline, metrics, targets }, null, 2));
    await undo.focus(); await page.keyboard.press("Enter"); await expect(dialog.getByText("Undone", { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
