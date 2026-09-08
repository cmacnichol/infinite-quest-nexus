import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

// Deliberately uses real HTTP, PostgreSQL-backed API, and the rendered runtime UI.
// Run only against the disposable compose-p2-10.yaml project.
const base = process.env.P2_PROOF_BASE_URL ?? "http://127.0.0.1:45680";
const output = process.env.P2_PROOF_SCREENSHOTS;
assert.ok(output, "Set P2_PROOF_SCREENSHOTS to the approved screenshot directory.");
await mkdir(output, { recursive: true });
const project = "infinitequest-ai-assist-p2-10-proof";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const json = async (path, body) => {
  const response = await fetch(`${base}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
};
const until = async (read, predicate, label) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (predicate(value)) return value; } catch { /* API restart can close a connection. */ }
    await new Promise(done => setTimeout(done, 300));
  }
  throw new Error(`Timed out: ${label}`);
};
const screenshot = (page, name) => page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  assert.equal((await json("/api/v1/authoring/capabilities")).enabled, true);
  // Bootstrap only this isolated project's deterministic provider on a fresh DB.
  const inventory = await json("/api/v1/providers");
  if (!inventory.providers.some(provider => provider.isDefault && provider.providerRole === "text")) {
    await json("/api/v1/providers", {
      name: "P2.10 deterministic Compose provider", providerType: "openai_compatible", providerRole: "text",
      baseUrl: "http://provider:9090/v1", defaultModel: "deterministic-authoring", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0, enabled: true, isDefault: true, configuration: {}
    });
  }
  docker("exec", `${project}-provider-1`, "node", "-e", "fetch('http://127.0.0.1:9090/fail-next-character',{method:'POST'}).then(r=>{if(r.status!==204)process.exit(1)})");
  await page.goto(`${base}/app/worlds/new`);
  await page.locator('[name="creationMethod"][value="ai"]').check();
  await page.locator('[data-concept-prompt="compact"]').fill("Create a synthetic world for the disposable browser proof.");
  const submitted = page.waitForResponse(response => response.url().endsWith("/api/v1/authoring/jobs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate world draft", exact: true }).click();
  const initial = await (await submitted).json();
  assert.ok(initial.id);
  process.stdout.write(JSON.stringify({ boundary: "ui-submit", jobId: initial.id }) + "\n");
  const path = `/api/v1/authoring/jobs/${initial.id}`;
  docker("restart", `${project}-worker-1`);
  let job = await until(() => json(path), value => ["awaiting_review", "recoverable"].includes(value.status), "worker completes proposal");
  for (const stage of job.stages.filter(stage => stage.status === "recoverable")) {
    await page.getByRole("button", { name: `Retry ${stage.key}`, exact: true }).click();
    job = await until(() => json(path), value => value.stages.some(item => item.key === stage.key && item.generation > stage.generation && item.status === "validated"), "UI retries failed stage");
    process.stdout.write(JSON.stringify({ boundary: "ui-stage-retry", stage: stage.key }) + "\n");
  }
  job = await until(() => json(path), value => value.status === "awaiting_review", "all stages validated");
  assert.equal(job.stages.filter(stage => stage.status === "validated").length, 4);
  await page.getByRole("button", { name: "Review available results", exact: true }).click();
  const title = `Human reviewed Compose ${initial.id.slice(0, 8)}`;
  await page.locator('[name="world.title"]').fill(title);
  job = await until(() => json(path), value => value.reviewedContent?.world.title === title && value.canApply, "human edit saved on server");
  assert.notEqual(job.status, "applied");
  process.stdout.write(JSON.stringify({ boundary: "saved-human-review-before-refresh", jobId: job.id, revision: job.revision, title }) + "\n");
  await screenshot(page, "compose-human-review-saved");
  docker("restart", `${project}-api-1`);
  await until(() => json("/api/v1/authoring/capabilities"), value => value.enabled, "API restarts");
  await page.reload();
  await page.getByRole("button", { name: "Review available results", exact: true }).click();
  await page.locator('[name="world.title"]').waitFor();
  assert.equal(await page.locator('[name="world.title"]').inputValue(), title);
  assert.notEqual((await json(path)).status, "applied");
  await screenshot(page, "compose-human-review-after-refresh");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot(page, "compose-human-review-after-refresh-narrow");
  await page.setViewportSize({ width: 1280, height: 900 });
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  const applied = page.waitForResponse(response => response.url().endsWith(`${path}/apply`) && response.request().method() === "POST").then(response => response.status());
  await page.getByRole("button", { name: "Create world", exact: true }).click();
  assert.equal(await applied, 200);
  await page.waitForURL(/\/app\/worlds\/[0-9a-f-]{36}/);
  const worldId = /\/app\/worlds\/([0-9a-f-]{36})/.exec(page.url())[1];
  const world = await json(`/api/v1/worlds/${worldId}`);
  const persisted = JSON.parse(docker("exec", `${project}-postgres-1`, "psql", "-U", "p2proof", "-d", "p2proof", "-At", "-c", `select apply_receipt from authoring_jobs where id = '${initial.id}'`));
  assert.equal(persisted.worldId, worldId);
  assert.equal(world.draftContent.world.title, title);
  assert.equal((await json(path)).status, "applied");
  assert.deepEqual(errors, []);
  await screenshot(page, "compose-human-review-applied");
  process.stdout.write(JSON.stringify({ boundary: "ui-apply-after-refresh", receipt: persisted, persistedTitle: world.draftContent.world.title, pageErrors: errors }) + "\n");
} finally {
  await browser.close();
}
