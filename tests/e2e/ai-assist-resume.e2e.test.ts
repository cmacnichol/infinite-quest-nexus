import { expect, test, type Page, type BrowserContext, type TestInfo } from "@playwright/test";
import type { AuthoringJobView, AuthoringSubmit } from "../../packages/contracts/src/authoring.js";

const base = "http://127.0.0.1:43174";
const character = (id = "hero", name = "Ilyra") => ({ id, name, characterText: "A patient guide through reflected starlight.", rpgStats: [], defaultTriggers: [], source: {} });
const content = (title = "Glass Atlas") => ({ schemaVersion: 5, world: { title, genre: "Fantasy", tone: "Hopeful", premise: "Follow a migrating star.", backgroundStory: "An ancient observatory.", firstAction: "Open the observatory.", rules: "Reflections remember." }, playableCharacters: [character("companion", "Companion")], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}, preservedLore: "A promise" });
const worldJob = (): AuthoringJobView => ({ id: "world-job", revision: 1, kind: "world_concept", status: "recoverable", target: { kind: "new_world" }, request: { kind: "world_concept", idempotencyKey: "world-request", target: { kind: "new_world" }, prompt: "A city under glass" }, stages: [{ id: "outline-stage", key: "world", status: "validated", generation: 0, attemptCount: 1 }, { id: "failed-child", key: "character:hero", status: "recoverable", generation: 0, attemptCount: 1 }], expiresAt: "2026-09-13T00:00:00.000Z", incomplete: true, canApply: false, result: content() });
const characterJob = (): AuthoringJobView => ({ id: "character-job", revision: 1, kind: "character", status: "awaiting_review", target: { kind: "new_world" }, request: { kind: "character", idempotencyKey: "character-request", target: { kind: "new_world" }, prompt: "A patient guide", content: content() }, stages: [{ id: "character-stage", key: "character:hero", status: "validated", generation: 0, attemptCount: 1 }], expiresAt: "2026-09-13T00:00:00.000Z", incomplete: false, canApply: false, result: character() });

async function fixture(context: BrowserContext, jobs: AuthoringJobView[]) {
  const store = new Map(jobs.map(job => [job.id, structuredClone(job)]));
  const submissions: AuthoringSubmit[] = []; const commands: string[] = []; let saves = 0;
  await context.route("**/api/v1/authoring/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname.split("/");
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("capabilities")) return json({ enabled: true, supportedKinds: ["world_concept", "character"], limits: { activeJobsPerOwner: 5, maximumInputBytes: 2 * 1024 * 1024, listPageSize: 20 } });
    const id = path[5]; const command = path[6];
    if (!id && request.method() === "GET") return json({ jobs: [...store.values()].map(({ request: _request, result: _result, reviewedContent: _review, ...item }) => item) });
    if (!id && request.method() === "POST") {
      const input = request.postDataJSON() as AuthoringSubmit; submissions.push(input);
      const job = input.kind === "world_concept" ? worldJob() : characterJob();
      job.request = input as never; job.target = input.target;
      store.set(job.id, job); return json(job, 202);
    }
    const job = store.get(id!); if (!job) return json({ error: "not found" }, 404);
    if (request.method() === "GET") return json(job);
    const body = request.postDataJSON();
    if (body.expectedRevision !== job.revision) return json({ error: "conflict" }, 409);
    commands.push(command!); job.revision += 1;
    if (command === "review") { saves += 1; job.reviewedContent = body.content; }
    if (command === "cancel") job.status = "cancelled";
    if (command === "retry") { job.status = "running"; const stage = job.stages.find(stage => stage.id === body.stageId)!; stage.status = "queued"; stage.generation += 1; }
    return json(job);
  });
  return { store, submissions, commands, saves: () => saves };
}

function health(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type()) && !/Failed to load resource.*(409|503|502)/.test(message.text())) failures.push(message.text()); });
  return failures;
}
async function evidence(page: Page, testInfo: TestInfo, name: string, errors: string[]) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page).toHaveTitle(/Infinite Quest/);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect((await page.locator("main").innerText()).length).toBeGreaterThan(80);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`${name}-narrow.png`), fullPage: true });
}

test("world resume survives refresh and lost storage, reviews partial results and retries one failed child", async ({ page, context }, testInfo) => {
  const server = await fixture(context, [worldJob()]); const errors = health(page);
  await page.goto(`${base}/app/worlds/new`);
  await page.getByRole("button", { name: "Show saved proposals", exact: true }).click();
  await page.getByRole("button", { name: /world-job · recoverable/ }).click();
  await expect(page).toHaveURL(/authoringJob=world-job/);
  await page.reload();
  await page.getByRole("button", { name: "Review available results" }).click();
  await expect(page.locator('[name="world.title"]')).toHaveValue("Glass Atlas");
  await page.getByRole("button", { name: "Retry character:hero" }).click();
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("running");
  expect(server.commands.filter(command => command === "retry")).toHaveLength(1);
  expect(server.store.get("world-job")!.stages[0]!.generation).toBe(0);
  await evidence(page, testInfo, "world-partial-resume", errors);
  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
  await page.goto(`${base}/app/worlds/new`);
  await page.getByRole("button", { name: "Show saved proposals", exact: true }).click();
  await expect(page.getByRole("button", { name: /world-job · running/ })).toBeVisible();
  await page.getByRole("button", { name: /world-job · running/ }).click();
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("running");
  server.store.delete("world-job");
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("unavailable or expired");
  await expect(page.getByRole("button", { name: "Review available results" })).toBeHidden();
});

test("late world results preserve human edits and stage, compare real candidates, cancel stops results", async ({ page, context }, testInfo) => {
  const initial = worldJob(); delete initial.result; initial.status = "running";
  const server = await fixture(context, [initial]); const errors = health(page);
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("running");
  await page.locator('[name="creationMethod"][value="manual"]').check();
  await page.getByRole("button", { name: "Continue manually" }).click();
  await page.locator('[name="world.title"]').fill("Human draft");
  const changed = server.store.get("world-job")!; changed.revision += 1; changed.result = content("Late generated draft");
  await expect(page.getByRole("button", { name: "Compare local and generated result" })).toBeVisible();
  await expect(page.locator('[name="world.title"]')).toHaveValue("Human draft");
  await page.getByRole("button", { name: "Compare local and generated result" }).click();
  await expect(page.locator("[data-authoring-compare-local]")).toContainText("Human draft");
  await expect(page.locator("[data-authoring-compare-remote]")).toContainText("Late generated draft");
  await evidence(page, testInfo, "world-compare", errors);
  await page.getByRole("button", { name: "Cancel proposal" }).click();
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("cancelled");
  await expect(page.getByRole("button", { name: "Review available results" })).toBeHidden();
  await expect(page.locator('[name="world.title"]')).toHaveValue("Human draft");
});

test("two world tabs keep a conflicting local review until explicit compare and reload", async ({ page, context }, testInfo) => {
  const server = await fixture(context, [worldJob()]); const second = await context.newPage(); const errors = health(second);
  const firstSnapshot = structuredClone(server.store.get("world-job")!); let stale = true;
  await second.route("**/api/v1/authoring/jobs/world-job", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale ? firstSnapshot : server.store.get("world-job")) }));
  for (const tab of [page, second]) { await tab.goto(`${base}/app/worlds/new?authoringJob=world-job`); await tab.getByRole("button", { name: "Review available results" }).click(); }
  await page.locator('[name="world.title"]').fill("First tab saved");
  await expect.poll(() => server.saves()).toBe(1);
  await second.locator('[name="world.title"]').fill("Second tab local");
  await expect(second.locator("[data-authoring-resume-status]")).toContainText("another tab");
  stale = false;
  await second.getByRole("button", { name: "Compare local and generated result" }).click();
  await expect(second.locator("[data-authoring-compare-local]")).toContainText("Second tab local");
  await expect(second.locator("[data-authoring-compare-remote]")).toContainText("First tab saved");
  await evidence(second, testInfo, "world-two-tab-conflict", errors);
  await second.getByRole("button", { name: "Reload server review" }).click();
  await expect(second.locator('[name="world.title"]')).toHaveValue("First tab saved");
  expect(server.saves()).toBe(1);
});

test("character lost-session recovery explicitly restores parent and returns the reviewed identity to its roster", async ({ page, context }, testInfo) => {
  const job = characterJob(); if (job.kind === "character" && job.request) job.request.content.preservedLore = "x".repeat(600_000);
  const server = await fixture(context, [job]); const errors = health(page);
  await page.goto(`${base}/app/characters/lost?authoringJob=character-job`);
  await expect(page.getByRole("button", { name: "Restore parent draft", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to world draft" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore parent draft", exact: true }).click();
  await page.getByRole("button", { name: "Review available results" }).click();
  await expect(page.locator('[name="candidate.id"]')).toHaveValue("hero");
  await page.locator('[name="candidate.name"]').fill("Reviewed Ilyra");
  await expect.poll(() => server.saves()).toBe(1);
  await evidence(page, testInfo, "character-restored", errors);
  await page.reload();
  await page.getByRole("button", { name: "Restore parent draft", exact: true }).click();
  await page.getByRole("button", { name: "Review available results" }).click();
  await expect(page.locator('[name="candidate.name"]')).toHaveValue("Reviewed Ilyra");
  for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Add to world draft" }).click();
  await expect(page).toHaveURL(/\/app\/worlds\/new\?authoringCharacter=character-job/);
  await page.getByRole("button", { name: "Restore reviewed parent draft" }).click();
  await expect(page.locator("[data-character-roster-item]")).toHaveCount(2);
  await expect(page.locator("[data-character-roster]")).toContainText("Reviewed Ilyra");
  await expect(page.locator("[data-character-roster]")).toContainText("Companion");
  expect(server.submissions).toHaveLength(0);
  await evidence(page, testInfo, "character-parent-review", errors);
});

test("character owner list recovers another browser entry, and cancel leaves recovered workspace", async ({ page, context }) => {
  await fixture(context, [characterJob()]);
  await page.goto(`${base}/app/characters/resume`);
  await page.getByRole("button", { name: /character-job · awaiting review/ }).click();
  await page.getByRole("button", { name: "Restore parent draft", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(`${base}/app/worlds/new`);
});

test("character actual Generate submits a durable proposal with stable retry identity after an uncertain response", async ({ page, context }) => {
  const server = await fixture(context, []); let uncertain = true; const attempts: string[] = [];
  await page.addInitScript(draft => { sessionStorage.setItem("iqn:character-workspace:session:local", JSON.stringify({ version: 1, key: "local", origin: "world-creation", mode: "create", workflowId: "local-flow", parentRoute: "/app/worlds/new", expectedWorldRevision: null, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate: null, expiresAt: Date.now() + 60_000 })); }, content());
  await page.route("**/api/v1/authoring/jobs", route => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts.push(route.request().postDataJSON().idempotencyKey);
    if (uncertain) { uncertain = false; return route.fulfill({ status: 502, body: "uncertain" }); }
    return route.fallback();
  });
  let legacyCalls = 0; await page.route("**/api/v1/worlds/playable-characters/generate-preview", route => { legacyCalls += 1; return route.abort(); });
  await page.goto(`${base}/app/characters/local`);
  await page.locator('[name="characterMethod"][value="ai"]').check();
  await page.locator('[data-character-prompt="compact"]').fill("A patient guide");
  await page.getByRole("button", { name: "Generate character", exact: true }).click();
  await expect(page.locator("[data-character-generation-status]")).toContainText("failed");
  await page.getByRole("button", { name: "Generate character", exact: true }).click();
  await expect(page).toHaveURL(/authoringJob=character-job/);
  await page.getByRole("button", { name: "Review available results" }).click();
  await expect(page.locator('[name="candidate.name"]')).toHaveValue("Ilyra");
  expect(attempts).toHaveLength(2); expect(attempts[0]).toBe(attempts[1]); expect(legacyCalls).toBe(0); expect(server.submissions).toHaveLength(1);
});

test("capability lookup failure never falls back to synchronous world generation", async ({ page, context }) => {
  const server = await fixture(context, []); let legacyCalls = 0;
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.route("**/api/v1/worlds/generate-preview", route => { legacyCalls += 1; return route.abort(); });
  await page.goto(`${base}/app/worlds/new`);
  await page.locator('[name="creationMethod"][value="ai"]').check();
  await page.locator('[data-concept-prompt="compact"]').fill("Keep my concept");
  await page.getByRole("button", { name: "Generate world draft" }).click();
  await expect(page.locator("[data-generation-status]")).toContainText("availability could not be checked");
  expect(legacyCalls).toBe(0);
  await expect(page.locator('[data-concept-prompt="compact"]')).toHaveValue("Keep my concept");
  await page.unroute("**/api/v1/authoring/capabilities");
  await page.getByRole("button", { name: "Generate world draft" }).click();
  await expect(page).toHaveURL(/authoringJob=world-job/);
  expect(server.submissions).toHaveLength(1);
  expect(server.submissions[0]!.prompt).toBe("Keep my concept");
  expect(legacyCalls).toBe(0);
});

test("P27-F1 repeated world polls keep the new generation available for explicit review", async ({ page, context }, testInfo) => {
  const job = worldJob(); job.reviewedContent = content("Earlier review");
  const server = await fixture(context, [job]); const errors = health(page); let newerPolls = 0;
  page.on("response", response => { if (response.url().endsWith("/authoring/jobs/world-job") && server.store.get("world-job")!.revision === 2) newerPolls += 1; });
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
  await page.getByRole("button", { name: "Review available results" }).click();
  const newer = server.store.get("world-job")!; newer.revision = 2; newer.result = content("New generated review");
  await expect.poll(() => newerPolls).toBeGreaterThanOrEqual(3);
  await expect(page.locator('[name="world.title"]')).toHaveValue("Earlier review");
  await page.getByRole("button", { name: "Compare local and generated result" }).click();
  await expect(page.locator("[data-authoring-compare-remote]")).toContainText("New generated review");
  await page.getByRole("button", { name: "Review available results" }).click();
  await expect(page.locator('[name="world.title"]')).toHaveValue("New generated review");
  await expect.poll(() => server.saves()).toBe(1);
  await evidence(page, testInfo, "pending-generation-adopted", errors);
});

test("P27-F2 applied JSON and collection remove and undo are restored from the saved review", async ({ page, context }, testInfo) => {
  const job = worldJob(); job.result = { ...content(), entities: [{ id: "observatory", name: "Observatory" }] };
  const server = await fixture(context, [job]); const errors = health(page);
  const resume = async () => { await page.getByRole("button", { name: "Review available results" }).click(); await page.locator('[data-action="continue-stage"]').click(); };
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`); await resume();
  await page.locator('[data-action="remove-item"]').click();
  await expect.poll(() => server.saves()).toBe(1);
  await page.locator('[data-action="undo-removal"]').click();
  await expect.poll(() => server.saves()).toBe(2);
  await page.reload(); await resume();
  await expect(page.locator("[data-collection-row]")).toContainText("Observatory");
  await page.locator('[data-action="continue-stage"]').click();
  await page.locator("details").filter({ has: page.locator("[data-defaults-json]") }).locator("summary").click();
  await page.locator("[data-defaults-json]").fill('{"difficulty":"heroic"}');
  await page.locator('[data-action="apply-defaults-json"]').click();
  await expect.poll(() => server.saves()).toBe(3);
  await page.reload(); await resume(); await page.locator('[data-action="continue-stage"]').click();
  await page.locator("details").filter({ has: page.locator("[data-defaults-json]") }).locator("summary").click();
  await expect(page.locator("[data-defaults-json]")).toHaveValue(/heroic/);
  await evidence(page, testInfo, "authored-json-restored", errors);
  await page.locator('[data-stage="canon"]').click();
  await page.locator('[data-action="remove-item"]').click();
  await expect.poll(() => server.saves()).toBe(4);
  await page.reload(); await resume();
  await expect(page.locator("[data-collection-row]")).toHaveCount(0);
  expect((server.store.get("world-job")!.reviewedContent as ReturnType<typeof content>).defaults).toEqual({ difficulty: "heroic" });
});

test("P27-F3 a delayed save response keeps a later observed conflict and explicit reload visible", async ({ page, context }, testInfo) => {
  const job = worldJob(); job.reviewedContent = content();
  const server = await fixture(context, [job]); const errors = health(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let requested = false;
  await page.route("**/api/v1/authoring/jobs/world-job/review", async route => {
    const oldResponse = { ...structuredClone(job), revision: 2, reviewedContent: route.request().postDataJSON().content };
    requested = true; await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oldResponse) });
  });
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
  await page.getByRole("button", { name: "Review available results" }).click();
  await page.locator('[name="world.title"]').fill("Local delayed review");
  await expect.poll(() => requested).toBe(true);
  if (job.kind !== "world_concept") throw new Error("Expected a world fixture");
  server.store.set(job.id, { ...job, revision: 3, reviewedContent: content("Later other review") });
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("another tab");
  release();
  await page.getByRole("button", { name: "Compare local and generated result" }).click();
  await expect(page.locator("[data-authoring-compare-local]")).toContainText("Local delayed review");
  await expect(page.locator("[data-authoring-compare-remote]")).toContainText("Later other review");
  await expect(page.getByRole("button", { name: "Reload server review" })).toBeVisible();
  await expect(page.locator("[data-authoring-resume-status]")).toContainText("another tab");
  await evidence(page, testInfo, "delayed-save-conflict", errors);
  await page.getByRole("button", { name: "Reload server review" }).click();
  await expect(page.locator('[name="world.title"]')).toHaveValue("Later other review");
});

for (const entry of ["world", "character", "missing-character"] as const) {
  test(`P27-F4 ${entry} owner list reaches a matching proposal after an unrelated retained first page`, async ({ page, context }, testInfo) => {
    const matching = entry === "world" ? worldJob() : characterJob();
    const other = entry === "world" ? characterJob() : worldJob(); other.status = "applied";
    await fixture(context, [matching, other]); const errors = health(page); const cursors: (string | null)[] = [];
    await page.route(/\/api\/v1\/authoring\/jobs(?:\?.*)?$/, route => {
      if (route.request().method() !== "GET") return route.fallback();
      const cursor = new URL(route.request().url()).searchParams.get("cursor"); cursors.push(cursor);
      const { request: _request, result: _result, reviewedContent: _review, ...listed } = cursor ? matching : other;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [listed], ...(!cursor ? { nextCursor: "page-two" } : {}) }) });
    });
    if (entry === "character") await page.addInitScript(draft => { sessionStorage.setItem("iqn:character-workspace:session:local", JSON.stringify({ version: 1, key: "local", origin: "world-creation", mode: "create", workflowId: "local-flow", parentRoute: "/app/worlds/new", expectedWorldRevision: null, parentDraft: draft, worldContext: draft, rosterSummaries: [], candidate: null, expiresAt: Date.now() + 60_000 })); }, content());
    await page.goto(`${base}${entry === "world" ? "/app/worlds/new" : entry === "character" ? "/app/characters/local" : "/app/characters/resume"}`);
    if (entry !== "missing-character") await page.getByRole("button", { name: entry === "world" ? "Show saved proposals" : "Show saved character proposals", exact: true }).click();
    const more = page.getByRole("button", { name: entry === "world" ? "Load more world proposals" : "Load more character proposals", exact: true });
    await more.click();
    const choice = page.getByRole(entry === "character" ? "link" : "button", { name: new RegExp(`${matching.id} ·`) });
    await expect(choice).toBeVisible(); await expect(more).toBeHidden(); expect(cursors).toEqual([null, "page-two"]);
    await evidence(page, testInfo, `${entry}-second-page`, errors);
    await choice.click();
    if (entry === "world") await expect(page).toHaveURL(/authoringJob=world-job/);
    else await expect(page.getByRole("button", { name: "Restore parent draft", exact: true })).toBeVisible();
  });
}
