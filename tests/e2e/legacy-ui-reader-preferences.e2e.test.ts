import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T12");
const savedPreferences: ReaderPreferences = { widthCh: 72, fontSizePx: 18, lineHeight: 1.7, theme: "dark" };
type ThemeMetricValue = number | string | boolean | Record<string, string | number | boolean | Record<string, string>>;

type ReaderPreferences = {
  widthCh: 60 | 72 | 84;
  fontSizePx: 16 | 18 | 20 | 22;
  lineHeight: 1.5 | 1.7 | 1.9;
  theme: "dark" | "light" | "sepia";
};

async function prepareStoryPage(page: Page, campaignId: string): Promise<void> {
  const html = (await readFile("apps/web/public/story.html", "utf8"))
    .replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
}

async function openReadingAppearance(page: Page): Promise<void> {
  await page.locator("#btnOpenUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toBeVisible();
  const appearance = page.locator("[data-reading-appearance]");
  if (!(await appearance.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await appearance.locator("summary").click();
  }
  await expect(page.locator("[data-reading-appearance] [data-reader-width]")).toBeVisible();
}

async function setPreferences(page: Page, preferences: ReaderPreferences): Promise<void> {
  await page.locator("[data-reader-width]").selectOption(String(preferences.widthCh));
  await page.locator("[data-reader-font-size]").selectOption(String(preferences.fontSizePx));
  await page.locator("[data-reader-line-height]").selectOption(String(preferences.lineHeight));
  await page.locator("select[data-reader-theme]").selectOption(preferences.theme);
}

async function readActualThemeInteractionMetrics(page: Page): Promise<Record<string, ThemeMetricValue>> {
  await page.waitForTimeout(200);
  await page.locator("#btnPrev").focus();
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const style = getComputedStyle(active);
    const background = getComputedStyle(active.parentElement ?? document.body).backgroundColor;
    const channels = (value: string) => {
      const hex = value.trim().match(/^#([a-f\d]{3}|[a-f\d]{6})$/iu)?.[1];
      return hex
        ? (hex.length === 3 ? [...hex].map((channel) => Number.parseInt(channel + channel, 16)) : hex.match(/../gu)!.map((channel) => Number.parseInt(channel, 16)))
        : value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [];
    };
    const luminance = (value: string) => channels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (foreground: string, surface: string) => {
      const a = luminance(foreground);
      const b = luminance(surface);
      return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
    };
    return {
      keyboardFocusVisible: active.matches(":focus-visible"),
      keyboardFocusWithinReaderToolbar: Boolean(active.closest(".story-reader-toolbar")),
      focusOutlineStyle: style.outlineStyle,
      focusOutlineWidth: Number.parseFloat(style.outlineWidth),
      focusBorderContrast: ratio(style.outlineColor, background)
    };
  });
  await page.locator("#btnTakeAction").hover();
  await page.waitForTimeout(200);
  const appearance = await page.evaluate(() => {
    const story = document.querySelector<HTMLElement>("#storyContainer")!;
    const area = story.querySelector<HTMLElement>("#storyArea")!;
    const prose = area.querySelector<HTMLElement>(".narration")!;
    let link = prose.querySelector<HTMLAnchorElement>("a[data-theme-probe]");
    if (!link) {
      link = document.createElement("a");
      link.dataset.themeProbe = "true";
      link.href = "#reader-appearance-check";
      link.textContent = "Synthetic reader link";
      prose.append(link);
    }
    const actionButton = story.querySelector<HTMLButtonElement>("#btnTakeAction")!;
    const input = story.querySelector<HTMLTextAreaElement>("#freeAction")!;
    const choiceHint = story.querySelector<HTMLElement>(".choice-mode-hint");
    const style = (element: Element) => getComputedStyle(element);
    const parseColor = (value: string): [number, number, number, number] => {
      const source = value.trim();
      const hex = source.match(/^#([a-f\d]{3}|[a-f\d]{6})$/iu)?.[1];
      if (hex) {
        const rgb = hex.length === 3
          ? [...hex].map((channel) => Number.parseInt(channel + channel, 16))
          : hex.match(/../gu)!.map((channel) => Number.parseInt(channel, 16));
        return [rgb[0]!, rgb[1]!, rgb[2]!, 1];
      }
      const srgb = source.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/iu);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, Number(srgb[4] ?? 1)];
      const rgb = source.match(/^rgba?\((.*)\)$/iu);
      if (rgb) {
        const [channelsText, alphaText] = rgb[1]!.split("/");
        const channels = channelsText!.split(/[\s,]+/u).filter(Boolean).map(Number);
        const alpha = alphaText === undefined ? channels[3] ?? 1 : Number(alphaText.trim());
        if (channels.length >= 3 && [...channels.slice(0, 3), alpha].every(Number.isFinite)) {
          return [channels[0]!, channels[1]!, channels[2]!, alpha];
        }
      }
      if (source === "transparent") return [0, 0, 0, 0];
      throw new Error(`Unsupported computed color format for reader contrast proof: ${source}`);
    };
    const channels = (value: string) => parseColor(value).slice(0, 3);
    const luminance = (value: string) => channels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (foreground: string, surface: string) => {
      const a = luminance(foreground);
      const b = luminance(surface);
      return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
    };
    const areaSurface = style(area).backgroundColor;
    const composite = (foreground: [number, number, number, number], background: [number, number, number, number]) => {
      const alpha = foreground[3];
      return [0, 1, 2].map((index) => foreground[index]! * alpha + background[index]! * (1 - alpha)) as [number, number, number];
    };
    const effectiveBackground = (element: Element) => {
      const ancestors: Element[] = [];
      let current: Element | null = element;
      while (current && current !== story) {
        ancestors.push(current);
        current = current.parentElement;
      }
      let background = parseColor(style(story).getPropertyValue("--reader-surface").trim());
      const backgroundLayers: string[] = [];
      for (const ancestor of ancestors.reverse()) {
        const rawBackground = style(ancestor).backgroundColor;
        backgroundLayers.push(`${ancestor.tagName.toLowerCase()}${(ancestor as HTMLElement).className ? `.${String((ancestor as HTMLElement).className).trim().replace(/\s+/gu, ".")}` : ""}: ${rawBackground}`);
        background = [...composite(parseColor(rawBackground), background), 1];
      }
      return { color: `rgb(${background[0]}, ${background[1]}, ${background[2]})`, layers: backgroundLayers };
    };
    const readerTextSelectors: Record<string, string> = {
      storyTitle: "#storyTitle",
      activeTurnMetadata: "#turnPill",
      viewedTurnMetadata: "#viewPill",
      readerTurnCount: "#readerTurnCount",
      previousActionSummary: ".previous-action-disclosure > summary",
      turnTypeLegend: "#turnInputModeField > legend",
      turnTypeLockMessage: "#turnInputModeLock",
      actionInputHelp: "#turnInputHelp",
      actionInputCount: "#turnInputCount",
      turnLengthLabel: ".turn-length-override"
    };
    const readerTextContrast: Record<string, number> = {};
    const readerTextColors: Record<string, { foreground: string; background: string; backgroundLayers: string }> = {};
    for (const [name, selector] of Object.entries(readerTextSelectors)) {
      const element = story.querySelector(selector);
      if (element) {
        const background = effectiveBackground(element);
        readerTextContrast[name] = ratio(style(element).color, background.color);
        readerTextColors[name] = { foreground: style(element).color, background: background.color, backgroundLayers: background.layers.join(" | ") };
      }
    }
    const syntheticMiniDim = document.createElement("p");
    syntheticMiniDim.className = "mini dim";
    syntheticMiniDim.textContent = "Synthetic Story supporting text";
    const syntheticReplacementBanner = document.createElement("div");
    syntheticReplacementBanner.className = "replacement-pending-banner";
    syntheticReplacementBanner.innerHTML = "<strong>Replacement in progress</strong><span>Synthetic Story warning detail</span>";
    area.append(syntheticMiniDim, syntheticReplacementBanner);
    const sceneTextSelectors: Record<string, Element> = {
      sceneTurnMetadata: area.querySelector(".scene .turn-meta > .pill")!,
      syntheticStoryMiniDim: syntheticMiniDim,
      syntheticReplacementWarningDetail: syntheticReplacementBanner.querySelector("span")!
    };
    const sceneTextContrast: Record<string, number> = {};
    const sceneTextColors: Record<string, { foreground: string; background: string; backgroundLayers: string }> = {};
    for (const [name, element] of Object.entries(sceneTextSelectors)) {
      const background = effectiveBackground(element);
      sceneTextContrast[name] = ratio(style(element).color, background.color);
      sceneTextColors[name] = { foreground: style(element).color, background: background.color, backgroundLayers: background.layers.join(" | ") };
    }
    syntheticMiniDim.remove();
    syntheticReplacementBanner.remove();
    const controlContrast = ratio(style(actionButton).color, style(actionButton).backgroundColor);
    const wasDisabled = actionButton.disabled;
    actionButton.disabled = true;
    const disabledContrast = ratio(style(actionButton).color, style(actionButton).backgroundColor);
    actionButton.disabled = wasDisabled;
    const hovered = actionButton.matches(":hover");
    return {
      theme: story.dataset.readerTheme ?? "missing",
      proseWidth: style(prose).width,
      proseFontSize: style(prose).fontSize,
      proseLineHeight: style(prose).lineHeight,
      proseContrast: ratio(style(prose).color, areaSurface),
      linkContrast: ratio(style(link).color, areaSurface),
      controlContrast,
      disabledContrast,
      inputContrast: ratio(style(input).color, style(input).backgroundColor),
      hoverTextContrast: ratio(style(actionButton).color, style(actionButton).backgroundColor),
      hoverBorderContrast: ratio(style(actionButton).borderTopColor, areaSurface),
      choiceHintContrast: choiceHint ? ratio(style(choiceHint).color, style(choiceHint.parentElement ?? area).backgroundColor) : Number.NaN,
      readerTextContrast,
      readerTextColors,
      sceneTextContrast,
      sceneTextColors,
      hovered,
      globalTextToken: style(document.documentElement).getPropertyValue("--text").trim()
    };
  });
  return { ...appearance, ...focus };
}

test("reader appearance previews locally, cancels without writes, and saves all preferences with retry", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 3, worldCount: 1, campaignCount: 1 });
  const initialUser = fixture.session.user as Record<string, unknown>;
  const initialSettings = {
    ...(initialUser.settings as Record<string, unknown>),
    autoSubmitTurnChoices: false,
    continuousReading: false,
    defaultTurnControlStyle: "flexible_scene",
    readerPreferences: savedPreferences,
    extensionSetting: { retained: true }
  };
  (fixture.session as Record<string, unknown>).user = { ...initialUser, settings: initialSettings };
  const instrumentation = await installLegacyUiFixture(page, fixture);
  let persistedSettings = structuredClone(initialSettings);
  let failFirstSave = true;
  let successfulPayload: Record<string, unknown> | null = null;
  let releaseSuccessfulSave: () => void = () => {};
  let holdSuccessfulSave = Promise.resolve();
  await page.route("**/api/v1/users/me/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { settings?: Record<string, unknown> };
    if (failFirstSave) {
      failFirstSave = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture save failure", message: "Profile save is temporarily unavailable." })
      });
      return;
    }
    successfulPayload = body;
    await holdSuccessfulSave;
    persistedSettings = { ...persistedSettings, ...(body.settings ?? {}) };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ user: { ...initialUser, settings: persistedSettings } })
    });
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 3 of 3");
  await expect(page.locator("[data-reading-appearance] [data-reader-width]")).toBeHidden();
  await page.locator("#btnPrev").focus();
  await page.keyboard.press("Tab");
  const keyboardFocusVisible = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.matches(":focus-visible") && getComputedStyle(active).outlineStyle !== "none";
  });
  expect(keyboardFocusVisible, "keyboard navigation exposes a visible focus indicator").toBe(true);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator("#storyContainer").screenshot({ path: resolve(evidenceDirectory, "reader-dark-desktop.png") });

  await openReadingAppearance(page);
  await expect(page.locator("[data-reader-width]")).toHaveValue("72");
  await expect(page.locator("[data-reader-font-size]")).toHaveValue("18");
  await expect(page.locator("[data-reader-line-height]")).toHaveValue("1.7");
  await expect(page.locator("select[data-reader-theme]")).toHaveValue("dark");

  const originalGlobalText = await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--text").trim());
  const originalNavigationText = await page.locator("#btnOpenUserProfile").evaluate((element) => getComputedStyle(element).color);
  const cancelPreview = { widthCh: 60, fontSizePx: 16, lineHeight: 1.5, theme: "light" } as const;
  await setPreferences(page, cancelPreview);
  await page.locator("[data-reader-preview]").click();
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "light");
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--text").trim())).toBe(originalGlobalText);
  expect(await page.locator("#btnOpenUserProfile").evaluate((element) => getComputedStyle(element).color)).toBe(originalNavigationText);
  await page.locator("#storyArea").screenshot({ path: resolve(evidenceDirectory, "reader-light-desktop.png") });
  await page.locator("#btnCancelUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toBeHidden();
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "dark");
  expect(instrumentation.writes.filter((write) => write.path === "/api/v1/users/me/profile")).toHaveLength(0);

  await openReadingAppearance(page);
  await setPreferences(page, { ...savedPreferences, theme: "light" });
  await page.locator("[data-reader-preview]").click();
  await page.locator("#btnCloseUserProfile").click();
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "dark");
  await openReadingAppearance(page);
  await setPreferences(page, { ...savedPreferences, theme: "sepia" });
  await page.locator("[data-reader-preview]").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#userProfileDialog")).toBeHidden();
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "dark");
  expect(instrumentation.writes.filter((write) => write.path === "/api/v1/users/me/profile")).toHaveLength(0);

  await openReadingAppearance(page);
  const savePreferences = { widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" } as const;
  await setPreferences(page, savePreferences);
  await page.locator("[data-reader-preview]").click();
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "sepia");
  await page.locator("#btnSaveUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toBeVisible();
  await expect(page.locator("[data-profile-status]")).toContainText("could not be saved");
  await expect(page.locator("select[data-reader-theme]")).toHaveValue("sepia");
  holdSuccessfulSave = new Promise<void>((resolveSave) => { releaseSuccessfulSave = resolveSave; });
  page.route("**/api/v1/users/me/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { settings?: Record<string, unknown> };
    successfulPayload = body;
    await holdSuccessfulSave;
    persistedSettings = { ...persistedSettings, ...(body.settings ?? {}) };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { ...initialUser, settings: persistedSettings } }) });
  });
  await page.locator("#btnSaveUserProfile").click();
  await expect(page.locator("#btnSaveUserProfile")).toBeDisabled();
  await expect(page.locator("select[data-reader-theme]")).toBeDisabled();
  expect(await page.locator("select[data-reader-theme]").inputValue()).toBe("sepia");
  releaseSuccessfulSave();
  await expect(page.locator("#userProfileDialog")).toBeHidden();
  expect(successfulPayload).toMatchObject({
    displayName: "Fixture Reader",
    settings: {
      autoSubmitTurnChoices: false,
      continuousReading: false,
      defaultTurnControlStyle: "flexible_scene",
      readerPreferences: savePreferences
    }
  });
  expect(persistedSettings.extensionSetting).toEqual({ retained: true });
  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "sepia");

  await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", "sepia");
  await page.locator("#storyContainer").screenshot({ path: resolve(evidenceDirectory, "reader-sepia-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowMetrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    storyWidth: document.querySelector<HTMLElement>("#storyContainer")?.scrollWidth ?? 0,
    storyClientWidth: document.querySelector<HTMLElement>("#storyContainer")?.clientWidth ?? 0
  }));
  expect(narrowMetrics.documentWidth).toBeLessThanOrEqual(narrowMetrics.viewportWidth);
  expect(narrowMetrics.storyWidth).toBeLessThanOrEqual(narrowMetrics.storyClientWidth);
  await page.locator("#storyContainer").screenshot({ path: resolve(evidenceDirectory, "reader-sepia-narrow.png") });
  await page.setViewportSize({ width: 640, height: 400 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidenceDirectory, "reader-sepia-effective-200-percent.png"), fullPage: false });
});

test("appearance-only save preserves an untouched action-only story setting", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const initialUser = fixture.session.user as Record<string, unknown>;
  const initialSettings = {
    ...(initialUser.settings as Record<string, unknown>),
    defaultTurnControlStyle: "action_only",
    readerPreferences: savedPreferences
  };
  (fixture.session as Record<string, unknown>).user = { ...initialUser, settings: initialSettings };
  await installLegacyUiFixture(page, fixture);
  const submitted: { body?: { settings?: Record<string, unknown> } } = {};
  await page.route("**/api/v1/users/me/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    submitted.body = route.request().postDataJSON() as { settings?: Record<string, unknown> };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ user: { ...initialUser, settings: { ...initialSettings, ...(submitted.body.settings ?? {}) } } })
    });
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await openReadingAppearance(page);
  await setPreferences(page, { ...savedPreferences, widthCh: 60 });
  await page.locator("[data-reader-preview]").click();
  await page.locator("#btnSaveUserProfile").click();
  await expect(page.locator("#userProfileDialog")).toBeHidden();
  expect(submitted.body?.settings).toMatchObject({
    defaultTurnControlStyle: "action_only",
    readerPreferences: { ...savedPreferences, widthCh: 60 }
  });
});

test("saved reader themes keep real focus, hover, contrast, and viewport behavior", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 3, worldCount: 1, campaignCount: 1 });
  const initialUser = fixture.session.user as Record<string, unknown>;
  let persistedSettings: Record<string, unknown> = {
    ...(initialUser.settings as Record<string, unknown>),
    defaultTurnControlStyle: "flexible_scene",
    readerPreferences: savedPreferences
  };
  (fixture.session as Record<string, unknown>).user = { ...initialUser, settings: persistedSettings };
  await installLegacyUiFixture(page, fixture);
  await page.route("**/api/v1/users/me/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { settings?: Record<string, unknown> };
    persistedSettings = { ...persistedSettings, ...(body.settings ?? {}) };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ user: { ...initialUser, settings: persistedSettings } })
    });
  });
  await prepareStoryPage(page, fixture.campaignId);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  const globalTextToken = await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--text").trim());
  const themeMetrics: Record<string, Record<string, ThemeMetricValue>> = {};
  const viewports = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "narrow", width: 390, height: 844 },
    { name: "effective-200-percent", width: 640, height: 400 }
  ] as const;

  for (const theme of ["dark", "light", "sepia"] as const) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openReadingAppearance(page);
    await setPreferences(page, { ...savedPreferences, theme });
    await page.locator("[data-reader-preview]").click();
    await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", theme);
    await page.locator("#btnSaveUserProfile").click();
    await expect(page.locator("#userProfileDialog")).toBeHidden();
    await expect(page.locator("#storyContainer")).toHaveAttribute("data-reader-theme", theme);

    const metrics = await readActualThemeInteractionMetrics(page);
    themeMetrics[theme] = metrics;
    expect(metrics.theme).toBe(theme);
    expect(metrics.proseContrast, `${theme} actual prose contrast`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.linkContrast, `${theme} actual link contrast`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.controlContrast, `${theme} actual control text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.disabledContrast, `${theme} actual disabled control text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.inputContrast, `${theme} actual input text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.hovered, `${theme} action control is actually hovered`).toBe(true);
    expect(metrics.hoverTextContrast, `${theme} actual hover text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.hoverBorderContrast, `${theme} actual hover border contrast`).toBeGreaterThanOrEqual(3);
    expect(metrics.choiceHintContrast, `${theme} choice hint contrast`).toBeGreaterThanOrEqual(4.5);
    const readerTextContrast = metrics.readerTextContrast as Record<string, number>;
    expect(Object.keys(readerTextContrast)).toEqual([
      "storyTitle",
      "activeTurnMetadata",
      "viewedTurnMetadata",
      "readerTurnCount",
      "previousActionSummary",
      "turnTypeLegend",
      "turnTypeLockMessage",
      "actionInputHelp",
      "actionInputCount",
      "turnLengthLabel"
    ]);
    for (const [label, contrast] of Object.entries(readerTextContrast)) {
      expect(contrast, `${theme} ${label} actual text contrast`).toBeGreaterThanOrEqual(4.5);
    }
    expect(metrics.keyboardFocusVisible, `${theme} keyboard focus is actually visible`).toBe(true);
    expect(metrics.keyboardFocusWithinReaderToolbar).toBe(true);
    expect(metrics.focusOutlineStyle).not.toBe("none");
    expect(metrics.focusOutlineWidth).toBeGreaterThanOrEqual(2);
    expect(metrics.focusBorderContrast, `${theme} actual focus border contrast`).toBeGreaterThanOrEqual(3);
    expect(metrics.globalTextToken).toBe(globalTextToken);

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(() => {
        const story = document.querySelector<HTMLElement>("#storyContainer")!;
        return {
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          storyClientWidth: story.clientWidth,
          storyScrollWidth: story.scrollWidth
        };
      });
      expect(overflow.documentWidth, `${theme} ${viewport.name} document width`).toBeLessThanOrEqual(overflow.viewportWidth);
      expect(overflow.storyScrollWidth, `${theme} ${viewport.name} story width`).toBeLessThanOrEqual(overflow.storyClientWidth);
      await page.screenshot({
        path: resolve(evidenceDirectory, `reader-proof-${theme}-${viewport.name}.png`),
        fullPage: false
      });
    }
  }

  await writeFile(resolve(evidenceDirectory, "reader-actual-theme-metrics.json"), `${JSON.stringify(themeMetrics, null, 2)}\n`);
  for (const [theme, metrics] of Object.entries(themeMetrics)) {
    const sceneTextContrast = metrics.sceneTextContrast as Record<string, number>;
    for (const [label, contrast] of Object.entries(sceneTextContrast)) {
      expect(contrast, `${theme} ${label} actual or representative Story contrast`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
