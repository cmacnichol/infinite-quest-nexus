import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

// Real API/worker/PostgreSQL proof. The only browser interception delays or
// drops an actual server response; it never fabricates a proposal or receipt.
const base = process.env.P2_PROOF_BASE_URL ?? "http://127.0.0.1:45680";
const output = process.env.P2_PROOF_SCREENSHOTS;
assert.ok(output, "Set P2_PROOF_SCREENSHOTS to the approved artifact directory.");
await mkdir(output, { recursive: true });
const project = "infinitequest-ai-assist-p2-10-proof";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const json = async (path, body, method = body ? "POST" : "GET") => {
  const response = await fetch(`${base}${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const until = async (read, predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 300));
  }
  throw new Error(`Timed out: ${label}`);
};
const capture = async (page, name) => {
  assert.match(await page.title(), /Infinite Quest/);
  assert.ok((await page.locator("main").innerText()).length > 80);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  await page.screenshot({ path: resolve(output, `${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, `${name}-narrow.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; const consoleErrors = []; page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (["error", "warning"].includes(message.type()) && !message.text().includes("net::ERR_FAILED")) consoleErrors.push(message.text()); });
const createdJobs = [];
const record = value => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  assert.equal((await json("/api/v1/authoring/capabilities")).enabled, true);
  const inventory = await json("/api/v1/providers");
  if (!inventory.providers.some(provider => provider.isDefault && provider.providerRole === "text")) await json("/api/v1/providers", {
    name: "Final fix deterministic provider", providerType: "openai_compatible", providerRole: "text", baseUrl: "http://provider:9090/v1", defaultModel: "deterministic-authoring",
    contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, enabled: true, isDefault: true, configuration: {}
  });
  await page.goto(`${base}/app/worlds/new`);
  await page.locator('[name="creationMethod"][value="ai"]').check();
  await page.locator('[data-concept-prompt="compact"]').fill("A synthetic world for the final no-edit proof.");
  const submission = page.waitForResponse(response => response.url().endsWith("/authoring/jobs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate world draft", exact: true }).click();
  const submitted = await (await submission).json(); createdJobs.push(submitted.id);
  const path = `/api/v1/authoring/jobs/${submitted.id}`;
  const generated = await until(() => json(path), job => job.status === "awaiting_review", "world generation");
  assert.equal(generated.reviewedContent, undefined);
  await page.getByRole("button", { name: "Review available results", exact: true }).click();
  let reviewed = await until(() => json(path), job => job.canApply, "untouched first world review saves");
  assert.deepEqual(reviewed.reviewedContent, generated.result);
  const originalSelection = reviewed.reviewedStageIds;
  record({ boundary: "fresh-world-no-edit-review", jobId: reviewed.id, selection: originalSelection, revision: reviewed.revision });
  await capture(page, "world-no-edit-review");
  // A real API-supported outline regeneration stays pending while the sole
  // disposable worker is stopped. Review must preserve selection through reload.
  docker("stop", `${project}-worker-1`);
  try {
    await json(`${path}/retry`, { expectedRevision: reviewed.revision, stageId: reviewed.stages.find(stage => stage.key === "world").id });
    await page.reload();
    await page.getByRole("button", { name: "Review available results", exact: true }).click();
    reviewed = await json(path); assert.deepEqual(reviewed.reviewedStageIds, originalSelection);
    assert.deepEqual(reviewed.reviewedContent, generated.result);
    await page.reload(); assert.deepEqual((await json(path)).reviewedStageIds, originalSelection);
  } finally { docker("start", `${project}-worker-1`); }
  await until(() => json(path), job => job.status === "awaiting_review", "replacement validation");
  await page.reload(); await page.getByRole("button", { name: "Review available results", exact: true }).click();
  reviewed = await until(() => json(path), job => job.canApply, "explicit replacement review");
  assert.equal(reviewed.reviewedStageIds.length, originalSelection.length);
  assert.ok(reviewed.reviewedStageIds.every(id => !originalSelection.includes(id)));
  record({ boundary: "pending-replacement-reload-recovery", selection: reviewed.reviewedStageIds });
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  await page.getByRole("button", { name: "Create world", exact: true }).click();
  await page.waitForURL(/\/app\/worlds\/[0-9a-f-]{36}/);
  const firstWorld = await json(`/api/v1/worlds/${/\/app\/worlds\/([0-9a-f-]{36})/.exec(page.url())[1]}`);
  assert.deepEqual(firstWorld.draftContent, reviewed.reviewedContent);
  await capture(page, "world-no-edit-applied");

  for (const target of ["new", "existing"]) for (const resumed of [false, true]) for (const edit of [false, true]) {
    const label = `${target}-${resumed ? "resumed" : "normal"}-${edit ? "edit" : "create"}`;
    const parent = structuredClone(firstWorld.draftContent);
    const selected = edit ? parent.playableCharacters[0] : null;
    let world;
    if (target === "existing") {
      world = await json("/api/v1/worlds", { title: `${label} proof`, content: parent });
      await page.goto(`${base}/app/worlds/${world.id}`);
      await page.locator('[data-section-target="characters"]').click();
      await page.locator(edit ? '[data-action="edit-character"]' : '[data-action="add-item"]').first().click();
    } else {
      await page.goto(`${base}/app/worlds/new`);
      await page.evaluate(({ parent, selected, label }) => {
        sessionStorage.setItem(`iqn:character-workspace:session:${label}`, JSON.stringify({ version: 1, key: label, origin: "world-creation", mode: selected ? "edit" : "create", workflowId: label, parentRoute: "/app/worlds/new", expectedWorldRevision: null, parentDraft: parent, worldContext: parent, rosterSummaries: [], candidate: selected, expiresAt: Date.now() + 600_000 }));
      }, { parent, selected, label });
      await page.goto(`${base}/app/characters/${label}`);
    }
    await page.locator('[name="characterMethod"][value="ai"]').check();
    await page.locator('[data-character-prompt="compact"]').fill("A patient standalone guide.");
    const response = page.waitForResponse(response => response.url().endsWith("/authoring/jobs") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Generate character", exact: true }).click();
    const initial = await (await response).json(); createdJobs.push(initial.id);
    const jobPath = `/api/v1/authoring/jobs/${initial.id}`;
    const completed = await until(() => json(jobPath), job => job.status === "awaiting_review", `${label} generation`);
    assert.ok(completed.result); assert.equal(completed.reviewedContent, undefined);
    assert.equal(completed.result.id, edit ? selected.id : initial.stages[0].key.slice("character:".length));
    if (resumed) {
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(`${base}/app/characters/lost?authoringJob=${initial.id}`);
      await page.getByRole("button", { name: "Restore parent draft", exact: true }).click();
    }
    // Delay each real review response. Acceptance must not leave before its
    // current save resolves, including the ordinary no-edit session.
    let release; let held = false;
    const pending = new Promise(done => { release = done; });
    await page.route(`**${jobPath}/review`, async route => { const response = await route.fetch(); held = true; await pending; await route.fulfill({ response }); });
    await page.getByRole("button", { name: "Review available results", exact: true }).click();
    for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: edit ? "Update world draft" : "Add to world draft", exact: true }).click();
    await until(async () => held, value => value, "held review response");
    assert.ok(page.url().includes("/characters/")); release();
    await page.waitForURL(/authoringCharacter=/);
    await page.unroute(`**${jobPath}/review`);
    const savedReview = await json(jobPath);
    assert.deepEqual(savedReview.reviewedContent, completed.result);
    assert.deepEqual(savedReview.reviewedStageIds, [completed.stages[0].id]);
    if (target === "new") {
      await page.getByRole("button", { name: "Restore reviewed parent draft", exact: true }).click();
      assert.equal(await page.locator("[data-character-roster-item]").count(), parent.playableCharacters.length + (edit ? 0 : 1));
      assert.equal((await json(jobPath)).canApply, false);
      await capture(page, label);
      await json(jobPath, { expectedRevision: savedReview.revision }, "DELETE");
    } else {
      const requests = []; let dropped = false; let finishReplay;
      const replayFinished = new Promise(done => { finishReplay = done; });
      await page.route(`**${jobPath}/apply`, async route => {
        requests.push(route.request().postDataJSON()); const response = await route.fetch();
        if (!dropped) { dropped = true; await route.abort("failed"); }
        else { await route.fulfill({ response }); finishReplay(); }
      });
      const apply = page.getByRole("button", { name: "Apply reviewed character", exact: true });
      await apply.click();
      await page.getByText("Nexus did not confirm whether the reviewed character was applied. Retry uses the same request key and frozen proposal.", { exact: true }).waitFor();
      await apply.click(); await until(async () => requests.length, count => count === 2, "frozen apply replay");
      assert.deepEqual(requests[0], requests[1]);
      await replayFinished;
      await page.unroute(`**${jobPath}/apply`);
      const updated = await json(`/api/v1/worlds/${world.id}`);
      assert.equal(updated.draftRevision, 2);
      assert.equal(updated.draftContent.playableCharacters.length, parent.playableCharacters.length + (edit ? 0 : 1));
      assert.deepEqual(updated.draftContent.playableCharacters.find(character => character.id === completed.result.id), savedReview.reviewedContent);
      for (const character of parent.playableCharacters.filter(character => character.id !== selected?.id)) assert.deepEqual(updated.draftContent.playableCharacters.find(item => item.id === character.id), character);
      const receipt = JSON.parse(docker("exec", `${project}-postgres-1`, "psql", "-U", "p2proof", "-d", "p2proof", "-At", "-c", `select apply_receipt from authoring_jobs where id = '${initial.id}'`));
      assert.equal(receipt.worldId, world.id); assert.equal(receipt.characterId, completed.result.id); assert.equal(receipt.draftRevision, 2);
      await page.reload(); await page.locator('[data-section-target="characters"]').click(); await capture(page, label);
      record({ boundary: "real-character-apply-replay", label, receipt });
    }
    record({ boundary: "fresh-character-review-accept", label, jobId: initial.id, candidateId: completed.result.id, selectedStageIds: savedReview.reviewedStageIds, exactReview: true });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  record({ result: "passed", pageErrors: errors, consoleErrors, createdJobs });
} finally {
  await browser.close();
}
