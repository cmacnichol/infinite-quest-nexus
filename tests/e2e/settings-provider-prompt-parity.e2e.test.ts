import { expect, test, type Page } from "@playwright/test";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";

const base = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const legacy = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const mode = process.env.VITE_UI_COMPONENTS === "web-awesome" ? "web-awesome" : "native";
const folder = "docs/review/assets/settings-panel";
const fixture = quietLeafApiPayloads();
const template = { ...PROMPT_TEMPLATE_CATALOG.story_system, effectiveSource: "shipped", effectiveContent: "Fixture instructions." };
async function api(page: Page) {
  const requests: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const rows: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(request.method() + " " + url.pathname + url.search);
    if (url.pathname === "/api/v1/session") return route.fulfill({json:fixture.session});
    if (url.pathname === "/api/v1/meta") return route.fulfill({json:{capabilities:{nativeTextExecutionPlans:true}}});
    if (url.pathname === "/api/v1/campaigns") return route.fulfill({json:fixture.campaigns});
    if (url.pathname === "/api/v1/providers" && request.method() === "POST") {
      const data = request.postDataJSON();
      writes.push(data);
      const {apiKey, ...safe} = data;
      rows.push({...safe,id:`11111111-1111-4111-8111-${String(rows.length+1).padStart(12,"0")}`,hasApiKey:!!apiKey,consecutiveFailures:0,healthStatus:"unknown",lastHealthCheckAt:null,lastHealthError:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      return route.fulfill({json:rows.at(-1)});
    }
    const resource = url.pathname.match(/^\/api\/v1\/providers\/([a-f0-9-]+)(\/default)?$/u);
    if (resource && request.method() === "PUT" && resource[2]) {
      const selected = rows.find(row => row.id === resource[1])!;
      for (const row of rows.filter(row => row.providerRole === selected.providerRole)) row.isDefault = row === selected;
      return route.fulfill({status:204});
    }
    if (resource && request.method() === "DELETE") {
      rows.splice(rows.findIndex(row => row.id === resource[1]),1);
      return route.fulfill({status:204});
    }
    if (url.pathname === "/api/v1/providers") return route.fulfill({json:{providers:rows}});
    if (url.pathname === "/api/v1/prompt-library") return route.fulfill({json:{templates:[template]}});
    if (url.pathname === "/api/v1/prompt-library/preview") return route.fulfill({json:{sections:[{label:"System",role:"system",content:"<unsafe-preview>"}],estimatedTokens:5,unresolvedVariables:[]}});
    if (url.pathname === "/api/v1/prompt-library/overrides") { writes.push(request.postDataJSON()); return route.fulfill({json:{library:{templates:[template]}}}); }
    return route.fulfill({json:{}});
  });
  return {requests,writes};
}
for (const [width,label] of [[1440,"desktop"],[390,"mobile"]] as const) {
  test(`${mode} ${label} user icon and independent provider roles`, async ({page}) => {
    const {requests,writes} = await api(page);
    await page.setViewportSize({width,height:900});
    if (label === "desktop") await page.emulateMedia({colorScheme:"dark"});
    await page.goto(base + "/app/settings?section=providers");
    await expect(page.getByRole("button",{name:"New provider profile"})).toBeVisible();
    expect(requests.some(path=>/models|presets|preview|settings\/instance/.test(path))).toBe(false);
    await expect(page.locator(".settings-content").getByText("On this device")).toHaveCount(0);
    await page.screenshot({path:`${folder}/${mode}-providers-${label}.png`,fullPage:true});
    if (mode === "web-awesome") {
      await page.getByRole("button",{name:"Profile",exact:true}).click();
      await page.getByRole("menuitem",{name:"User Profile"}).click();
    } else await page.getByRole("button",{name:"User profile and settings"}).click();
    const dialog = page.getByRole("dialog",{name:/User Profile/i});
    await expect(dialog.getByText("On this device",{exact:true})).toBeVisible();
    await page.screenshot({path:`${folder}/${mode}-user-profile-${label}.png`});
    await dialog.getByText("Reading appearance",{exact:true}).click();
    await expect(dialog.getByLabel("Reader theme",{exact:true})).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button",{name:"New provider profile"}).click();
    await page.locator("#providerType").selectOption("sogni_sdk");
    await expect(page.locator("#providerRole")).toHaveValue("image");
    await page.screenshot({path:`${folder}/${mode}-provider-dialog-${label}.png`});
    await page.locator("#providerAdvancedSettings > summary").click();
    for (const id of ["Network","TokenType","ContentFilter","SizePreset","Steps","Guidance","Seed","Sampler","Scheduler","PreviewCount","ImageCount","Width","Height","AspectRatio","OutputFormat","Quality","PollIntervalSeconds","MaximumPollIntervalSeconds","GenerationTimeoutSeconds","MaximumAttempts","ModelDiscoveryEnabled"]) {
      await expect(page.locator("#providerSogni"+id)).toBeVisible();
    }
    await page.locator("#providerApiKey").fill("local-fixture-key");
    await page.locator("#providerSogniSteps").fill("14");
    await page.locator("#providerIsDefault").check();
    await page.locator("#saveProvider").click();
    await expect.poll(()=>writes.length).toBe(1);
    expect(writes[0]).toMatchObject({providerType:"sogni_sdk",providerRole:"image",isDefault:true,configuration:{defaultSteps:14}});
    await expect(page.locator("#providerDialog")).toBeHidden();
    await page.locator("#providerProfileList").getByRole("button",{name:"Edit",exact:true}).click();
    await expect(page.locator("#providerApiKey")).toHaveValue("");
    await expect(page.locator("#providerRole")).toBeDisabled();
    expect(requests.some(path=>path.includes("/settings/instance"))).toBe(false);
  });
}
test(`${mode} authorizes campaign prompt selection, validates and previews on demand`, async ({page}) => {
  const {requests,writes} = await api(page);
  const foreign = "99999999-9999-4999-8999-999999999999";
  await page.goto(base + "/app/settings?section=prompts&campaignId="+foreign);
  await expect(page.locator("#promptLibraryStatus")).toContainText("Select a campaign");
  expect(requests.some(path=>path.includes(foreign))).toBe(false);
  await page.locator("#promptLibraryCampaign").selectOption(fixture.campaignId);
  await expect(page.locator("#promptLibraryContent")).toHaveValue(template.effectiveContent);
  expect(requests.some(path=>path.includes("/preview"))).toBe(false);
  await page.locator("#promptLibraryPreview").click();
  await expect(page.locator("#promptLibraryPreviewContent")).toContainText("<unsafe-preview>");
  await expect(page.locator("unsafe-preview")).toHaveCount(0);
  await page.locator("#promptLibraryContent").fill("{{unknown_variable}}");
  await page.getByRole("button",{name:"Save prompt"}).click();
  await expect(page.locator("#promptLibraryStatus")).toContainText("Unknown prompt variables");
  expect(writes).toHaveLength(0);
  await page.locator("#promptLibraryContent").fill("Campaign-scoped instructions.");
  await page.getByRole("button",{name:"Save prompt"}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0]).toMatchObject({scope:"campaign",campaignId:fixture.campaignId});
  await page.screenshot({path:`${folder}/${mode}-prompts-campaign.png`,fullPage:true});
  await page.evaluate(() => window.dispatchEvent(new Event("app-identity-changed")));
  await expect(page.locator("#promptLibraryContent")).toHaveCount(0);
});
test(`${mode} legacy bookmarks retain the section and campaign`, async ({page}) => {
  await api(page);
  await page.goto(legacy+"/nexus/index.html#providers");
  await expect(page.getByRole("button",{name:"New provider profile"})).toBeVisible();
  await page.goto(legacy+"/nexus/index.html#prompt-library?campaignId="+fixture.campaignId);
  await expect(page.locator("#promptLibraryCampaign")).toHaveValue(fixture.campaignId);
  await expect(page.locator("#promptLibraryContent")).toHaveValue(template.effectiveContent);
});

test(`${mode} keeps User Profile usable with blocked device storage and cancels the active owner's save`, async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", {get() { throw new DOMException("blocked", "SecurityError"); }}));
  await api(page);
  let started = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/v1/users/me/profile", async route => {
    started++;
    await held;
    await route.fulfill({json:{user:{...fixture.session.user, displayName:"Stale owner"}}}).catch(() => undefined);
  });
  await page.goto(base + "/app/settings?section=providers");
  if (mode === "web-awesome") {
    await page.getByRole("button",{name:"Profile",exact:true}).click();
    await page.getByRole("menuitem",{name:"User Profile"}).click();
  } else await page.getByRole("button",{name:"User profile and settings"}).click();
  const dialog = page.getByRole("dialog",{name:/User Profile/i});
  const name = dialog.getByRole("textbox",{name:"Display name",exact:true});
  await expect(name).toHaveValue("Fixture Reader");
  await name.fill("First reader edit");
  await expect.poll(() => started).toBe(1);
  await name.fill("Queued edit");
  await page.evaluate(() => window.dispatchEvent(new Event("app-identity-changed")));
  await expect(dialog).toHaveCount(0);
  release();
  await expect(page.getByText("Stale owner")).toHaveCount(0);
  expect(started).toBe(1);
});

test(`${mode} changes the embedding default and deletes only the selected profile`, async ({page}) => {
  const {requests,writes} = await api(page);
  await page.goto(base + "/app/settings?section=providers");
  for (const name of ["First embeddings","Second embeddings"]) {
    await page.getByRole("button",{name:"New provider profile"}).click();
    await page.locator("#providerType").selectOption("openai_compatible");
    await page.locator("#providerRole").selectOption("embedding");
    await page.locator("#providerName").fill(name);
    await page.locator("#providerBaseUrl").fill("https://synthetic.invalid/v1");
    await page.locator("#providerEnabled").check();
    await page.locator("#saveProvider").click();
    await expect(page.locator("#providerDialog")).toBeHidden();
  }
  expect(writes.map(body => body.providerRole)).toEqual(["embedding","embedding"]);
  const second = page.locator(".provider-profile").filter({hasText:"Second embeddings"});
  await second.getByRole("button",{name:"Make default"}).click();
  await expect(second).toContainText("My default");
  const first = page.locator(".provider-profile").filter({hasText:"First embeddings"});
  page.once("dialog", dialog => dialog.accept());
  await first.getByRole("button",{name:"Delete"}).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  expect(requests.some(path => path.startsWith("DELETE /api/v1/providers/"))).toBe(true);
  expect(requests.some(path => /discover|models|settings\/instance/.test(path))).toBe(false);
});

test(`${mode} hydrates only the active account and filters cross-tab theme changes`, async ({page}) => {
  const secondOwner = "22222222-2222-4222-8222-222222222222";
  const firstOwner = fixture.session.user.id;
  let second = false;
  await api(page);
  await page.emulateMedia({colorScheme:"light"});
  await page.addInitScript(() => localStorage.setItem("infinite-quest.theme","dark"));
  await page.route("**/api/v1/session", route => route.fulfill({json:{...fixture.session,user:{
    ...fixture.session.user, id:second ? secondOwner : firstOwner, systemKey:second ? null : "initial-owner"
  }}}));
  await page.goto(base + "/app/settings?section=providers");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme","dark");
  second = true;
  await page.evaluate(() => window.dispatchEvent(new Event("app-identity-changed")));
  await expect(html).toHaveAttribute("data-theme","light");
  await page.reload();
  await expect(page.getByRole("button",{name:"New provider profile"})).toBeVisible();
  await page.evaluate(({firstOwner, secondOwner}) => {
    localStorage.setItem(`infinite-quest.user.${secondOwner}.infinite-quest.theme`,"dark");
    window.dispatchEvent(new StorageEvent("storage",{key:`infinite-quest.user.${firstOwner}.infinite-quest.theme`}));
  }, {firstOwner,secondOwner});
  await expect(html).toHaveAttribute("data-theme","light");
  await page.evaluate(id => window.dispatchEvent(new StorageEvent("storage",{key:`infinite-quest.user.${id}.infinite-quest.theme`})),secondOwner);
  await expect(html).toHaveAttribute("data-theme","dark");
});

test(`${mode} changing provider destinations clears credentials and previously discovered models`, async ({page}) => {
  await api(page);
  const discoveries: Record<string, unknown>[] = [];
  await page.route("**/api/v1/providers/discover-models", async route => {
    discoveries.push(route.request().postDataJSON());
    const model = "Fixture model " + discoveries.length;
    await route.fulfill({json:{models:[{id:model,displayName:model,loaded:true,contextLength:32000}]}});
  });
  await page.goto(base + "/app/settings?section=providers");
  await page.locator("#newProviderButton").click();
  await page.locator("#providerType").selectOption("openrouter");
  await page.locator("#providerApiKey").fill("first-synthetic-key");
  await page.locator("#providerDefaultModel").click();
  await page.getByRole("button",{name:/Fixture model 1/}).click();
  await page.locator("#providerBaseUrl").fill("https://new-fixture.invalid/v1");
  await expect(page.locator("#providerApiKey")).toHaveValue("");
  await page.locator("#providerDefaultModel").click();
  await expect(page.getByRole("button",{name:/Fixture model 2/})).toBeVisible();
  await expect(page.getByRole("button",{name:/Fixture model 1/})).toHaveCount(0);
  expect(discoveries[1]).not.toHaveProperty("apiKey");
  await page.getByRole("button",{name:/Fixture model 2/}).click();
  await page.locator("#providerApiKey").fill("another-synthetic-key");
  await page.locator("#providerType").selectOption("sogni");
  await expect(page.locator("#providerApiKey")).toHaveValue("");
  await page.locator("#providerDefaultModel").click();
  await expect(page.getByRole("button",{name:/Fixture model 3/})).toBeVisible();
  expect(discoveries[2]).toMatchObject({providerRole:"image", providerType:"sogni"});
  expect(discoveries[2]).not.toHaveProperty("apiKey");
  await page.getByRole("button",{name:/Fixture model 3/}).click();
  await page.locator("#providerType").selectOption("openai_compatible");
  await page.locator("#providerRole").selectOption("text");
  await page.locator("#providerApiKey").fill("fixture-only-text-key");
  await page.locator("#providerRole").selectOption("embedding");
  await expect(page.locator("#providerApiKey")).toHaveValue("");
  await page.locator("#providerDefaultModel").click();
  await expect(page.getByRole("button",{name:/Fixture model 4/})).toBeVisible();
  expect(discoveries[3]?.providerRole).toBe("embedding");
  expect(discoveries[3]).not.toHaveProperty("apiKey");
});
test(`${mode} prompt search and a delayed save keep the newer draft`, async ({page}) => {
  await api(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  let started = false;
  await page.route("**/api/v1/prompt-library/overrides", async route => {
    started = true;
    await held;
    await route.fulfill({json:{library:{templates:[{...template,effectiveContent:"Saved version"}]}}});
  });
  await page.goto(base + "/app/settings?section=prompts");
  const content = page.locator("#promptLibraryContent");
  await expect(content).toHaveValue(template.effectiveContent);
  await content.fill("Saved version");
  await page.locator("#promptLibraryFilter").fill("Story");
  await expect(content).toHaveValue("Saved version");
  await page.getByRole("button",{name:"Save prompt"}).click();
  await expect.poll(()=>started).toBe(true);
  await content.fill("Newer draft");
  release();
  await expect(page.locator("#promptLibraryStatus")).toContainText("saved");
  await expect(content).toHaveValue("Newer draft");
  await expect(page.locator("#promptLibraryDiscard")).toBeVisible();
  await page.locator("#promptLibraryDiscard").click();
  await expect(content).toHaveValue("Saved version");
});
test(`${mode} invalid or empty campaign links require an owned campaign`, async ({page}) => {
  const {requests,writes} = await api(page);
  for (const invalid of ["","bad-id"]) {
    await page.goto(base + "/app/settings?section=prompts&campaignId="+invalid);
    await expect(page.locator("#promptLibraryScope")).toHaveValue("campaign");
    await expect(page.locator("#promptLibraryStatus")).toContainText("Select a campaign");
    await expect(page.getByRole("button",{name:"Save prompt"})).toBeHidden();
  }
  expect(requests).not.toContain("GET /api/v1/prompt-library");
  expect(writes).toHaveLength(0);
});
test(`${mode} stalled optional identity at the app entry still opens World Library`, async ({page}) => {
  await api(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => {release=resolve;});
  await page.route("**/api/v1/session", async route => {await held; await route.fulfill({json:fixture.session}).catch(()=>undefined);});
  try {
    await page.goto(base + "/app/");
    await expect(page.getByRole("heading",{name:"World Library",exact:true})).toBeVisible({timeout:5000});
  } finally { release(); }
  await expect(page).toHaveURL(/\/app\/?$/);
});
for (const switchPrompt of [false, true]) {
  test(`${mode} delayed reset retains edits to ${switchPrompt ? "another" : "the same"} prompt`, async ({page}) => {
    await api(page);
    const override = {...template, effectiveSource: "application", effectiveContent: "Saved override."};
    const other = {...PROMPT_TEMPLATE_CATALOG.story_recovery_schema, effectiveSource: "shipped", effectiveContent: "Other prompt."};
    await page.route("**/api/v1/prompt-library", route => route.fulfill({json:{templates:[override, other]}}));
    let release!: () => void;
    const held = new Promise<void>(resolve => {release = resolve;});
    let started = false;
    await page.route("**/api/v1/prompt-library/overrides", async route => {
      started = true;
      await held;
      await route.fulfill({json:{library:{templates:[template, other]}}});
    });
    await page.goto(base + "/app/settings?section=prompts");
    const content = page.locator("#promptLibraryContent");
    await expect(content).toHaveValue(override.effectiveContent);
    await page.locator("#promptLibraryReset").click();
    try {
      await expect.poll(() => started).toBe(true);
      if (switchPrompt) await page.locator(`[data-prompt-key="${other.key}"]`).click();
      await content.fill("Keep this newer draft.");
      await expect(page.getByRole("button", {name:"Save prompt"})).toBeDisabled();
      await expect(page.locator("#promptLibraryResetCampaigns")).toBeDisabled();
    } finally { release(); }
    await expect(page.getByRole("button", {name:"Save prompt"})).toBeEnabled();
    await expect(content).toHaveValue("Keep this newer draft.");
    if (switchPrompt) await page.screenshot({path:`${folder}/${mode}-retained-prompt-draft.png`});
    await page.locator("#promptLibraryDiscard").click();
    await expect(content).toHaveValue(switchPrompt ? other.effectiveContent : template.effectiveContent);
    if (switchPrompt) await page.locator(`[data-prompt-key="${template.key}"]`).click();
    await expect(content).toHaveValue(template.effectiveContent);
    await expect(page.locator("#promptLibraryReset")).toBeDisabled();
  });
}
