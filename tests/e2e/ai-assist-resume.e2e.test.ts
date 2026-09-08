import { expect, test, type Page, type BrowserContext, type TestInfo } from "@playwright/test";
import type { AuthoringJobView, AuthoringSubmit } from "../../packages/contracts/src/authoring.js";

const base = "http://127.0.0.1:43174";
const character = (id = "hero", name = "Ilyra") => ({ id, name, characterText: "A patient guide through reflected starlight.", rpgStats: [], defaultTriggers: [], source: {} });
const content = (title = "Glass Atlas") => ({ schemaVersion: 5, world: { title, genre: "Fantasy", tone: "Hopeful", premise: "Follow a migrating star.", backgroundStory: "An ancient observatory.", firstAction: "Open the observatory.", rules: "Reflections remember." }, playableCharacters: [character("companion", "Companion")], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}, preservedLore: "A promise" });
const worldJob = (): AuthoringJobView => ({ id: "world-job", revision: 1, kind: "world_concept", status: "recoverable", target: { kind: "new_world" }, request: { kind: "world_concept", idempotencyKey: "world-request", target: { kind: "new_world" }, prompt: "A city under glass" }, stages: [{ id: "outline-stage", key: "world", status: "validated", generation: 0, attemptCount: 1 }, { id: "failed-child", key: "character:hero", status: "recoverable", generation: 0, attemptCount: 1 }], expiresAt: "2026-09-13T00:00:00.000Z", incomplete: true, canApply: false, result: content() });
const characterJob = (): AuthoringJobView => ({ id: "character-job", revision: 1, kind: "character", status: "awaiting_review", target: { kind: "new_world" }, request: { kind: "character", idempotencyKey: "character-request", target: { kind: "new_world" }, prompt: "A patient guide", content: content() }, stages: [{ id: "character-stage", key: "character:hero", status: "validated", generation: 0, attemptCount: 1 }], expiresAt: "2026-09-13T00:00:00.000Z", incomplete: false, canApply: false, result: character() });

test("P2-M1 superseded failures have no Retry command in either workspace", async ({ page, context }) => {
  const world = worldJob();
  world.stages.push({ id: "replacement", key: "character:hero", status: "validated", generation: 1, attemptCount: 1 });
  const char = characterJob();
  char.stages.unshift({ id: "historical", key: "character:hero", status: "recoverable", generation: -1, attemptCount: 1 });
  // Production generations start at one; preserve a real historical/current pair.
  char.stages[0]!.generation = 1; char.stages[1]!.generation = 2;
  await fixture(context, [world, char]);
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
  await expect(page.getByRole("button", { name: "Review available results" })).toBeVisible();
  await expect.soft(page.getByRole("button", { name: "Retry character:hero", exact: true })).toHaveCount(0);
  await page.goto(`${base}/app/characters/lost?authoringJob=character-job`);
  await page.getByRole("button", { name: "Restore parent draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review available results" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry character:hero", exact: true })).toHaveCount(0);
});

async function fixture(context: BrowserContext, jobs: AuthoringJobView[]) {
  const store = new Map(jobs.map(job => [job.id, structuredClone(job)]));
  const submissions: AuthoringSubmit[] = []; const commands: string[] = []; const applies: unknown[] = []; let saves = 0;
  await context.route("**/api/v1/authoring/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname.split("/");
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("capabilities")) return json({ enabled: true, supportedKinds: ["world_concept", "character"], limits: { activeJobsPerOwner: 5, maximumInputBytes: 2 * 1024 * 1024, listPageSize: 20 } });
    const id = path[5]; const command = path[6];
    if (!id && request.method() === "GET") return json({ jobs: [...store.values()].map(({ request: _request, result: _result, reviewedContent: _review, reviewedStageIds: _selection, ...item }) => item) });
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
    if (command === "apply") {
      applies.push(body);
      job.status = "applied";
      job.canApply = false;
      delete job.request; delete job.result; delete job.reviewedContent; delete job.reviewedStageIds;
      return json({ jobId: job.id, worldId: "44444444-4444-4444-8444-444444444444", draftRevision: 1 });
    }
    if (command === "review") {
      saves += 1; job.reviewedContent = body.content; job.reviewedStageIds = body.selectedStageIds;
      job.canApply = body.selectedStageIds.length > 0 && (job.kind === "world_concept" || job.target.kind === "world_draft") && ["awaiting_review", "recoverable"].includes(job.status);
    }
    if (command === "cancel") job.status = "cancelled";
    if (command === "retry") { job.status = "running"; const stage = job.stages.find(stage => stage.id === body.stageId)!; stage.status = "queued"; stage.generation += 1; }
    return json(job);
  });
  return { store, submissions, commands, applies, saves: () => saves };
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
  const reviewed = worldJob(); reviewed.reviewedContent = content(); reviewed.reviewedStageIds = ["outline-stage"];
  const server = await fixture(context, [reviewed]); const second = await context.newPage(); const errors = health(second);
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

test("P28 applies a reviewed world through the durable receipt path in the rendered creation flow", async ({ page, context }, testInfo) => {
  const ready = worldJob();
  ready.status = "awaiting_review";
  ready.incomplete = false;
  ready.stages = [{ id: "validated-world", key: "world", status: "validated", generation: 1, attemptCount: 1 }];
  ready.result = content();
  ready.reviewedContent = content();
  ready.reviewedStageIds = ["validated-world"];
  ready.canApply = true;
  const server = await fixture(context, [ready]);
  const errors = health(page);
  let legacyCreates = 0;
  await page.route("**/api/v1/worlds", route => {
    if (route.request().method() === "POST") { legacyCreates += 1; return route.abort(); }
    return route.fallback();
  });
  await page.route("**/api/v1/worlds/44444444-4444-4444-8444-444444444444", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: "44444444-4444-4444-8444-444444444444", title: "Glass Atlas", status: "draft", imageUrl: "",
      forkedFromWorldId: null, forkedFromWorldVersionId: null,
      createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
      draftRevision: 1, draftContent: content(), draftBasedOnWorldVersionId: null,
      draftUpdatedAt: "2026-09-07T00:00:00.000Z", versions: [], campaigns: []
    })
  }));
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
  await page.getByRole("button", { name: "Review available results" }).click();
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  await expect(page.getByRole("button", { name: "Create world", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create world", exact: true }).click();
  await expect.poll(() => server.applies.length).toBe(1);
  expect(server.applies[0]).toMatchObject({ expectedRevision: 1, selectedStageIds: ["validated-world"], content: content() });
  expect(legacyCreates).toBe(0);
  await evidence(page, testInfo, "p28-durable-apply", errors);
});

for (const scenario of ["applied poll", "invalid local review"] as const) {
test(`P28 replays a lost world apply after ${scenario} without legacy creation`, async ({ page, context }, testInfo) => {
  const ready = worldJob(); ready.status = "awaiting_review"; ready.incomplete = false;
  ready.stages = [{ id: "validated-world", key: "world", status: "validated", generation: 2, attemptCount: 1 }];
  ready.result = content(); ready.reviewedContent = content(); ready.reviewedStageIds = ["validated-world"]; ready.canApply = true;
  const server = await fixture(context, [ready]); const errors = health(page); const bodies: unknown[] = []; let first = true; let legacyCreates = 0;
  await page.route("**/api/v1/worlds", route => route.request().method() === "POST" ? (legacyCreates += 1, route.abort()) : route.fallback());
  await page.route("**/api/v1/authoring/jobs/world-job/apply", route => {
    bodies.push(route.request().postDataJSON());
    if (first) {
      first = false;
      if (scenario === "applied poll") {
        const applied = server.store.get("world-job")!; applied.status = "applied"; applied.canApply = false; applied.revision += 1;
        delete applied.request; delete applied.result; delete applied.reviewedContent; delete applied.reviewedStageIds;
      }
      return route.fulfill({ status: 502, body: "lost" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "world-job", worldId: "44444444-4444-4444-8444-444444444444", draftRevision: 1 }) });
  });
  await page.route("**/api/v1/worlds/44444444-4444-4444-8444-444444444444", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", title: "Glass Atlas", status: "draft", imageUrl: "", forkedFromWorldId: null, forkedFromWorldVersionId: null, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", draftRevision: 1, draftContent: content(), draftBasedOnWorldVersionId: null, draftUpdatedAt: "2026-09-07T00:00:00.000Z", versions: [], campaigns: [] }) }));
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`); await page.getByRole("button", { name: "Review available results" }).click();
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  await page.getByRole("button", { name: "Create world", exact: true }).click(); await expect(page.locator("[data-creation-error]")).toContainText("did not confirm");
  if (scenario === "applied poll") {
    await expect(page.locator("[data-authoring-resume-status]")).toContainText("applied");
  } else {
    await page.locator('[data-stage="foundation"]').click();
    await page.locator('[name="world.title"]').fill("");
    await expect(page.locator('[name="world.title"]')).toHaveValue("");
    await page.locator('[data-stage="review"]').click();
    await expect(page.locator('[name="world.title"]')).toBeVisible();
  }
  const savesBeforeReplay = server.saves();
  await evidence(page, testInfo, `p28-world-${scenario.replaceAll(" ", "-")}-before-retry`, errors);
  await page.getByRole("button", { name: "Retry world apply", exact: true }).click(); await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]); expect(legacyCreates).toBe(0); expect(server.saves()).toBe(savesBeforeReplay);
  await expect(page).toHaveURL(/worlds\/44444444-4444-4444-8444-444444444444/);
  await evidence(page, testInfo, `p28-world-${scenario.replaceAll(" ", "-")}-retried`, errors);
});
}

const existingWorldId = "44444444-4444-4444-8444-444444444444";
function existingWorld(draft = content(), revision = 8) {
  return { id: existingWorldId, title: draft.world.title, status: "draft", imageUrl: "", forkedFromWorldId: null, forkedFromWorldVersionId: null,
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", draftRevision: revision, draftContent: draft,
    draftBasedOnWorldVersionId: null, draftUpdatedAt: "2026-09-07T00:00:00.000Z", versions: [], campaigns: [] };
}

for (const changedParent of [false, true]) {
test(`P2-F4 normal editor launch preserves parent edits and allows durable apply (edited ${changedParent})`, async ({ page, context }, testInfo) => {
  const server = await fixture(context, []); const errors = health(page);
  let world = existingWorld();
  await page.route(`**/api/v1/worlds/${existingWorldId}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(world) }));
  await page.route("**/api/v1/authoring/jobs/character-job/apply", async route => {
    const body = route.request().postDataJSON(); server.applies.push(body);
    world = existingWorld({ ...content(), playableCharacters: [...content().playableCharacters, body.content] }, 9);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "character-job", worldId: existingWorldId, draftRevision: 9, characterId: body.content.id }) });
  });
  await page.goto(`${base}/app/worlds/${existingWorldId}`);
  if (changedParent) await page.locator('[name="world.title"]').fill("Local parent edit");
  await page.locator('[data-section-target="characters"]').click();
  await page.locator('[data-action="add-item"]').click();
  await page.locator('[name="characterMethod"][value="ai"]').check();
  await page.locator('[data-character-prompt="compact"]').fill("A patient guide");
  await page.getByRole("button", { name: "Generate character", exact: true }).click();
  await page.getByRole("button", { name: "Review available results", exact: true }).click();
  for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Add to world draft", exact: true }).click();
  await expect(page).toHaveURL(/authoringCharacter=character-job/);
  const apply = page.getByRole("button", { name: "Apply reviewed character", exact: true }); await expect(apply).toBeVisible();
  expect(server.applies).toHaveLength(0);
  await expect(page.locator('[name="world.title"]')).toHaveValue(changedParent ? "Local parent edit" : "Glass Atlas");
  await apply.click();
  if (changedParent) {
    await expect(page.getByText("Save or reload your local draft before applying this reviewed character. Your local edits were not changed.", { exact: true })).toBeVisible();
    expect(server.applies).toHaveLength(0);
  } else {
    await expect.poll(() => server.applies.length).toBe(1);
    await expect(page.locator('[data-action="save-draft"]')).toBeDisabled();
  }
  await evidence(page, testInfo, `fresh-editor-${changedParent}`, errors);
});
}
function existingCharacterJob(): AuthoringJobView {
  const job = characterJob();
  job.target = { kind: "world_draft", worldId: existingWorldId, expectedRevision: 8 };
  if (job.kind !== "character" || !job.request) throw new Error("Expected character job");
  job.request.target = job.target;
  job.reviewedContent = character("hero", "Reviewed Ilyra"); job.reviewedStageIds = ["character-current"]; job.canApply = true;
  job.stages = [
    { id: "character-old", key: "character:hero", generation: 1, status: "validated", attemptCount: 1 },
    { id: "character-current", key: "character:hero", generation: 2, status: "validated", attemptCount: 1 },
    { id: "unselected-sibling", key: "character:other", generation: 1, status: "validated", attemptCount: 1 }
  ];
  return job;
}

for (const scenario of ["explicit apply", "lost response with local edits", "unsaved before apply", "edited during apply"] as const) {
test(`P28 existing-world character ${scenario} preserves reviewed identity and local edits`, async ({ page, context }, testInfo) => {
  const job = existingCharacterJob(); const server = await fixture(context, [job]); const errors = health(page);
  let world = existingWorld(); const bodies: unknown[] = []; let saves = 0;
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/worlds/${existingWorldId}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(world) }));
  await page.route(`**/api/v1/worlds/${existingWorldId}/draft`, route => { saves += 1; return route.abort(); });
  await page.route("**/api/v1/authoring/jobs/character-job/apply", async route => {
    bodies.push(route.request().postDataJSON());
    world = existingWorld({ ...content(), playableCharacters: [...content().playableCharacters, character("hero", "Reviewed Ilyra")] }, 9);
    const applied = server.store.get(job.id)!; applied.status = "applied"; applied.canApply = false; applied.revision += 1;
    delete applied.request; delete applied.result; delete applied.reviewedContent; delete applied.reviewedStageIds;
    if (scenario === "lost response with local edits" && bodies.length === 1) return route.fulfill({ status: 502, body: "lost" });
    if (scenario === "edited during apply") await pending;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: job.id, worldId: existingWorldId, draftRevision: 9, characterId: "hero" }) });
  });
  await page.goto(`${base}/app/worlds/${existingWorldId}?authoringCharacter=character-job`);
  const apply = page.getByRole("button", { name: "Apply reviewed character", exact: true });
  await expect(apply).toBeVisible(); expect(bodies).toHaveLength(0);
  await expect(page.locator('[name="world.title"]')).toHaveValue("Glass Atlas");
  if (scenario === "unsaved before apply") await page.locator('[name="world.title"]').fill("Unsaved before apply");
  await apply.click();
  if (scenario === "unsaved before apply") {
    await expect(page.locator("main")).toContainText("Save or reload your local draft before applying");
    expect(bodies).toHaveLength(0); await expect(page.locator('[name="world.title"]')).toHaveValue("Unsaved before apply");
  } else {
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ expectedRevision: 1, selectedStageIds: ["character-current"], content: character("hero", "Reviewed Ilyra") });
    if (scenario === "lost response with local edits") {
      await expect(page.locator("main")).toContainText("did not confirm whether");
      await page.locator('[name="world.title"]').fill("Unsaved after response loss");
      await apply.click(); await expect.poll(() => bodies.length).toBe(2);
      expect(bodies[1]).toEqual(bodies[0]);
      await expect(page.locator("main")).toContainText("Your local edits are still on this page");
      await expect(page.locator('[name="world.title"]')).toHaveValue("Unsaved after response loss");
    } else if (scenario === "edited during apply") {
      await page.locator('[name="world.title"]').fill("Typed while apply pending"); release();
      await expect(page.locator("main")).toContainText("Your local edits are still on this page");
      await expect(page.locator('[name="world.title"]')).toHaveValue("Typed while apply pending");
    } else {
      await expect(page.locator("main")).toContainText("Revision 9");
      await page.locator('[data-section-target="characters"]').click();
      await expect(page.locator("[data-collection-list]")).toContainText("Reviewed Ilyra");
      await expect(page.locator("[data-collection-list]")).toContainText("Companion");
      expect(world.draftContent.playableCharacters.map(item => item.id)).toEqual(["companion", "hero"]);
    }
  }
  expect(saves).toBe(0);
  await evidence(page, testInfo, `p28-character-${scenario.replaceAll(" ", "-")}`, errors);
});
}

for (const scenario of ["live identical", "resumed identical", "resumed changed"] as const) {
test(`P28-F3 fix2 ${scenario} generation saves the current subset only after explicit review and applies it`, async ({ page, context }, testInfo) => {
  const initial = worldJob(); initial.status = "awaiting_review"; initial.incomplete = false; initial.canApply = true;
  if (initial.kind !== "world_concept") throw new Error("Expected world fixture");
  initial.result = content("Generated original"); initial.reviewedContent = content("Human saved review"); initial.reviewedStageIds = ["old-world"];
  initial.stages = [{ id: "old-world", key: "world", generation: 1, status: "validated", attemptCount: 1 }];
  const replacement: AuthoringJobView = { ...initial, revision: 2, canApply: false,
    result: content(scenario === "resumed changed" ? "Generated replacement" : "Generated original"), stages: [
      ...initial.stages,
      { id: "current-world", key: "world", generation: 2, status: "validated", attemptCount: 1 },
      { id: "unselected-sibling", key: "character:other", generation: 1, status: "validated", attemptCount: 1 }
    ] };
  const server = await fixture(context, [scenario === "live identical" ? initial : replacement]); const errors = health(page);
  const reviews: { content: ReturnType<typeof content>; selectedStageIds: string[] }[] = [];
  let polls = 0; let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  page.on("response", response => { if (response.url().endsWith("/authoring/jobs/world-job")) polls += 1; });
  await page.route("**/api/v1/authoring/jobs/world-job/review", async route => {
    const body = route.request().postDataJSON(); reviews.push(body);
    if (reviews.length === 1) await pending;
    if (JSON.stringify(body.selectedStageIds) !== JSON.stringify(["current-world"])) return route.fulfill({ status: 409, body: "historical or unselected stage" });
    return route.fallback();
  });
  await page.route(`**/api/v1/worlds/${existingWorldId}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(existingWorld(content("Human after review"), 1)) }));
  let legacyCreates = 0;
  await page.route("**/api/v1/worlds", route => route.request().method() === "POST" ? (legacyCreates += 1, route.abort()) : route.fallback());
  await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
  if (scenario === "live identical") {
    await page.getByRole("button", { name: "Review available results" }).click();
    await expect(page.locator('[name="world.title"]')).toHaveValue("Human saved review");
    server.store.set("world-job", structuredClone(replacement));
  }
  const pollsBeforeReview = polls;
  await expect.poll(() => polls).toBeGreaterThanOrEqual(pollsBeforeReview + 2);
  expect(reviews).toHaveLength(0); expect(server.store.get("world-job")!.reviewedStageIds).toEqual(["old-world"]);
  await page.getByRole("button", { name: "Review available results" }).click();
  await expect.poll(() => reviews.length).toBe(1);
  expect(reviews[0]).toMatchObject({ selectedStageIds: ["current-world"], content: content("Human saved review") });
  const pollsDuringSave = polls;
  await expect.poll(() => polls).toBeGreaterThanOrEqual(pollsDuringSave + 2);
  await expect(page.locator('[name="world.title"]')).toHaveValue("Human saved review");
  release(); await expect.poll(() => server.saves()).toBe(1);
  await page.locator('[name="world.title"]').fill("Human after review");
  await expect.poll(() => server.saves()).toBe(2);
  expect(reviews[1]).toMatchObject({ selectedStageIds: ["current-world"], content: content("Human after review") });
  expect(server.store.get("world-job")!.reviewedStageIds).toEqual(["current-world"]);
  await evidence(page, testInfo, `p28-fix2-${scenario.replaceAll(" ", "-")}-reviewed`, errors);
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  await page.getByRole("button", { name: "Create world", exact: true }).click();
  await expect.poll(() => server.applies.length).toBe(1);
  expect(server.applies[0]).toMatchObject({ selectedStageIds: ["current-world"], content: content("Human after review") });
  expect(legacyCreates).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/app/worlds/${existingWorldId}`));
  await expect(page.locator('[name="world.title"]')).toHaveValue("Human after review");
  await evidence(page, testInfo, `p28-fix2-${scenario.replaceAll(" ", "-")}-applied`, errors);
});
}

test("P28-F3 fix3 explicit review survives a historical autosave started before replacement adoption", async ({ page, context }, testInfo) => {
  const initial = worldJob(); initial.status = "awaiting_review"; initial.incomplete = false; initial.canApply = true;
  if (initial.kind !== "world_concept") throw new Error("Expected world fixture");
  initial.result = content(); initial.reviewedContent = content(); initial.reviewedStageIds = ["old-world"];
  initial.stages = [{ id: "old-world", key: "world", generation: 1, status: "validated", attemptCount: 1 }];
  const server = await fixture(context, [initial]); const errors = health(page);
  const reviews: { expectedRevision: number; content: ReturnType<typeof content>; selectedStageIds: string[] }[] = [];
  let polls = 0; let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  page.on("response", response => { if (response.url().endsWith("/authoring/jobs/world-job")) polls += 1; });
  await page.route("**/api/v1/authoring/jobs/world-job/review", async route => {
    const body = route.request().postDataJSON(); reviews.push(body);
    if (reviews.length === 1) {
      // Commit the old-generation review before replacement exists, but delay
      // its HTTP response until after the author explicitly reviews generation 2.
      expect(body).toMatchObject({ expectedRevision: 1, selectedStageIds: ["old-world"] });
      const saved: AuthoringJobView = { ...initial, revision: 2, reviewedContent: body.content, reviewedStageIds: body.selectedStageIds };
      server.store.set(initial.id, saved);
      const response = JSON.stringify(saved);
      await pending;
      return route.fulfill({ status: 200, contentType: "application/json", body: response });
    }
    expect(body).toMatchObject({ expectedRevision: 3, selectedStageIds: ["current-world"] });
    return route.fallback();
  });
  await page.route(`**/api/v1/worlds/${existingWorldId}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(existingWorld(content("Human before replacement"), 1)) }));
  let legacyCreates = 0;
  await page.route("**/api/v1/worlds", route => route.request().method() === "POST" ? (legacyCreates += 1, route.abort()) : route.fallback());
  try {
    await page.goto(`${base}/app/worlds/new?authoringJob=world-job`);
    await page.getByRole("button", { name: "Review available results" }).click();
    await page.locator('[name="world.title"]').fill("Human before replacement");
    await expect.poll(() => reviews.length).toBe(1);
    const saved = server.store.get(initial.id)!;
    if (saved.kind !== "world_concept") throw new Error("Expected world fixture");
    server.store.set(initial.id, { ...saved, revision: 3, result: content("Human before replacement"), canApply: false, stages: [
      ...saved.stages,
      { id: "current-world", key: "world", generation: 2, status: "validated", attemptCount: 1 },
      { id: "unselected-sibling", key: "character:other", generation: 1, status: "validated", attemptCount: 1 }
    ] });
    const beforeAdoption = polls; await expect.poll(() => polls).toBeGreaterThanOrEqual(beforeAdoption + 2);
    await page.getByRole("button", { name: "Review available results" }).click();
    const duringSave = polls; await expect.poll(() => polls).toBeGreaterThanOrEqual(duringSave + 2);
    expect(reviews).toHaveLength(1);
    await expect(page.locator('[name="world.title"]')).toHaveValue("Human before replacement");
    release(); await expect.poll(() => reviews.length).toBe(2);
    await expect.poll(() => server.saves()).toBe(1);
    expect(reviews[1]).toMatchObject({ expectedRevision: 3, selectedStageIds: ["current-world"], content: content("Human before replacement") });
    expect(server.store.get(initial.id)!.reviewedStageIds).toEqual(["current-world"]);
    await evidence(page, testInfo, "p28-fix3-pending-historical-save-reviewed", errors);
    for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
    await page.getByRole("button", { name: "Create world", exact: true }).click();
    await expect.poll(() => server.applies.length).toBe(1);
    expect(server.applies[0]).toMatchObject({ expectedRevision: 4, selectedStageIds: ["current-world"], content: content("Human before replacement") });
    expect(legacyCreates).toBe(0);
    await expect(page).toHaveURL(new RegExp(`/app/worlds/${existingWorldId}`));
    await expect(page.locator('[name="world.title"]')).toHaveValue("Human before replacement");
    await evidence(page, testInfo, "p28-fix3-pending-historical-save-applied", errors);
  } finally { release(); }
});

test("P27-F1 repeated world polls keep the new generation available for explicit review", async ({ page, context }, testInfo) => {
  const job = worldJob(); job.reviewedContent = content("Earlier review"); job.reviewedStageIds = ["outline-stage"];
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
