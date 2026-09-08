import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { closedCurrentSourceStage, renderedClosedJobStatus, safeClosedStage, safeJobSummary } from "./source-smoke-safe-diagnostics.mjs";
import { findAllowedFact } from "./source-smoke-fact-allowlist.mjs";
import { currentSourceWorldStageIds, sourceWorldReady } from "./source-smoke-world-readiness.mjs";

// This script drives only the disposable P3.9 API. It assumes the guarded
// Compose project and its one-shot server-side provider bridge are already up.
const project = "infinitequest-ai-assist-p3-9-smoke";
const base = process.env.P3_SMOKE_BASE_URL ?? "http://127.0.0.1:45690";
const baseUrl = new URL(base);
assert.equal(baseUrl.protocol, "http:");
assert.equal(baseUrl.hostname, "127.0.0.1", "P3_SMOKE_BASE_URL must be the disposable loopback API.");
assert.equal(baseUrl.port || "80", "45690", "P3_SMOKE_BASE_URL must use the disposable P3.9 port.");
assert.ok(["", "/"].includes(baseUrl.pathname), "P3_SMOKE_BASE_URL must not target an arbitrary API path.");
const output = process.env.P3_SMOKE_SCREENSHOTS;
assert.ok(output, "Set P3_SMOKE_SCREENSHOTS to the approved screenshot directory.");
const browserExecutablePath = process.env.P3_SMOKE_BROWSER_EXECUTABLE;
await mkdir(output, { recursive: true });
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const container = (service) => `${project}-${service}-1`;
const labels = (name) => docker("inspect", "-f", "{{index .Config.Labels \"com.docker.compose.project\"}}", name);
for (const service of ["postgres", "api", "worker"]) assert.equal(labels(container(service)), project, `Refusing non-P3.9 container ${container(service)}.`);
const apiPorts = JSON.parse(docker("inspect", "-f", "{{json .NetworkSettings.Ports}}", container("api")));
assert.deepEqual(apiPorts["8080/tcp"], [{ HostIp: "127.0.0.1", HostPort: "45690" }], "The selected API is not the P3.9 loopback publication.");
const json = async (path, body, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  const raw = await response.text();
  if (!raw) throw new Error(`${method} ${path} returned an empty response`);
  return JSON.parse(raw);
};
const until = async (read, predicate, label, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (predicate(result)) return result;
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};
const capture = async (page, name) => {
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  await page.screenshot({ path: resolve(output, `${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, `${name}-narrow.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
};
const extractionReady = (job) => job.status === "awaiting_review" && job.source?.extractionComplete;
const reviewedSourceWorldReady = (job) => {
  const currentStageIds = currentSourceWorldStageIds(job);
  return sourceWorldReady(job) && currentStageIds.length > 1 && currentStageIds.every((id) => job.reviewedStageIds?.includes(id)) && job.reviewedContent?.playableCharacters?.length === 1;
};
const stopForClosedSourceStage = async (page, job, screenshotName) => {
  const stage = closedCurrentSourceStage(job);
  if (!stage) return job;
  const renderedStatus = renderedClosedJobStatus(job);
  assert.ok(renderedStatus, "A closed source stage requires a recoverable or failed job status.");
  await page.getByText(renderedStatus, { exact: false }).waitFor({ timeout: 30_000 });
  await capture(page, screenshotName);
  process.stdout.write(`${JSON.stringify(safeClosedStage(job, stage))}\n`);
  throw new Error("Source extraction reached a durable closed stage.");
};

const browser = await chromium.launch(browserExecutablePath ? { executablePath: browserExecutablePath } : undefined);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.name));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.type()); });
try {
  const capabilities = await json("/api/v1/authoring/capabilities");
  assert.equal(capabilities.enabled, true);
  assert.ok(capabilities.supportedKinds.includes("story_source"));
  const providers = await json("/api/v1/providers");
  const selected = providers.providers.filter((profile) => profile.providerRole === "text" && profile.enabled && profile.isDefault);
  assert.equal(selected.length, 1, "The one-shot bridge must create exactly one enabled default text profile.");
  assert.ok(selected[0].providerType && selected[0].defaultModel, "The selected provider must retain a type and model in the browser-safe profile projection.");
  const chapter = "Mara keeps the harbor gate at dusk.\n\nMara carries the brass key and asks visitors to name their purpose.\n\nEXCLUDED_REVELATION_SENTINEL The moonless vault opens after the fleet departs.";
  const selectedPrefix = chapter.split("\n\n").slice(0, 2).join("\n\n");
  const selectedPrefixCodePoints = Array.from(selectedPrefix);
  const resumeJobId = process.env.P3_SMOKE_RESUME_JOB_ID;
  const explicitPublicRetry = process.env.P3_SMOKE_PUBLIC_RETRY === "true";
  let jobPath;
  let extracted;
  let resumeWorldReview = false;
  if (resumeJobId) {
    jobPath = `/api/v1/authoring/jobs/${resumeJobId}`;
    await page.goto(`${base}/app/worlds/new?authoringJob=${encodeURIComponent(resumeJobId)}`);
    const observed = await until(
      () => json(jobPath),
      (job) => Boolean(closedCurrentSourceStage(job)) || (job.source?.selectedCharacterFactIds?.length ? sourceWorldReady(job) : extractionReady(job)),
      "saved source extraction outcome"
    );
    const recoverableStage = closedCurrentSourceStage(observed);
    if (!recoverableStage) {
      extracted = observed;
      resumeWorldReview = sourceWorldReady(observed);
    } else {
      await capture(page, "source-recoverable-before-public-retry");
      if (!explicitPublicRetry) await stopForClosedSourceStage(page, observed, "source-closed-stage");
      assert.equal(recoverableStage.status, "recoverable", "Only a retryable source stage may receive the explicit public retry.");
      assert.equal(recoverableStage.failure?.retryable, true, "The live-provider validation failure must remain eligible for explicit public retry.");
      process.stdout.write(`${JSON.stringify({ boundary: "ui-stage-retry", stage: recoverableStage.key, generation: recoverableStage.generation, failureCode: recoverableStage.failure?.code ?? "unknown" })}\n`);
      await page.locator(`[data-action="retry-authoring-stage"][data-stage-id="${recoverableStage.id}"]`).click();
      const retried = await until(
        () => json(jobPath),
        (job) => extractionReady(job) || Boolean(closedCurrentSourceStage(job)),
        "source extraction outcome after explicit public retry",
        360_000
      );
      extracted = await stopForClosedSourceStage(page, retried, "source-closed-stage-after-public-retry");
    }
  } else {
    await page.goto(`${base}/app/worlds/new`);
    await page.locator('[name="creationMethod"][value="source"]').check();
    await page.locator("[data-source-text]").fill(chapter);
    await page.locator("[data-source-boundary]").selectOption("paragraph:1");
    await capture(page, "source-intake-boundary");
    const submission = page.waitForResponse((response) => response.url().endsWith("/api/v1/authoring/source-jobs") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Extract source facts", exact: true }).click();
    const submitted = await (await submission).json();
    jobPath = `/api/v1/authoring/jobs/${submitted.id}`;
    process.stdout.write(`${JSON.stringify({ boundary: "source-job-submitted", jobId: submitted.id })}\n`);
    await until(() => json(jobPath), (job) => job.stages.some((stage) => stage.key === "source:plan" && stage.status === "validated"), "source plan checkpoint");
    docker("restart", container("worker"));
    extracted = await until(
      () => json(jobPath),
      (job) => extractionReady(job) || Boolean(closedCurrentSourceStage(job)),
      "source extraction outcome after worker restart",
      360_000
    );
    extracted = await stopForClosedSourceStage(page, extracted, "source-closed-stage");
  }
  assert.ok(extracted.source.facts.length > 0, "Live provider produced no reviewable source facts.");
  assert.equal(JSON.stringify(extracted.source.facts).includes("EXCLUDED_REVELATION_SENTINEL"), false, "The extracted fact projection must exclude the unselected spoiler.");
  for (const fact of extracted.source.facts) for (const citation of fact.citations) {
    assert.ok(Number.isInteger(citation.start) && Number.isInteger(citation.end), "A source citation must retain integer global coordinates.");
    assert.ok(citation.start >= 0 && citation.end <= selectedPrefixCodePoints.length, "A source citation crossed the selected boundary.");
    assert.equal(selectedPrefixCodePoints.slice(citation.start, citation.end).join(""), citation.quote, "A source citation must match its selected-prefix coordinates.");
    assert.equal(citation.quote.includes("EXCLUDED_REVELATION_SENTINEL"), false, "Later spoiler crossed the selected boundary.");
  }
  const supportedStatements = [
    "Mara keeps the harbor gate at dusk.",
    "Mara carries the brass key and asks visitors to name their purpose."
  ];
  const expectedFacts = [
    {
      statement: supportedStatements[0],
      subject: "mara",
      variants: [
        { predicate: "keeps", value: "the harbor gate at dusk", quotes: [supportedStatements[0]] },
        { predicate: "keeps the harbor gate", value: "at dusk", quotes: [supportedStatements[0]] }
      ]
    },
    {
      statement: supportedStatements[1],
      subject: "mara",
      variants: [{ predicate: "carries", value: "the brass key", quotes: [supportedStatements[1], "Mara carries the brass key"] }]
    }
  ];
  const supportedFacts = expectedFacts.map((expected) => {
    const fact = findAllowedFact(extracted.source.facts, expected);
    assert.ok(fact, `Live review requires the explicitly allowlisted stated fact for '${expected.statement}'.`);
    return fact;
  });
  assert.equal(new Set(supportedFacts.map((fact) => fact.id)).size, expectedFacts.length, "Each expected statement must map to a distinct reviewed fact.");
  for (const fact of supportedFacts) for (const citation of fact.citations) {
    assert.ok(chapter.includes(citation.quote), "A reviewed citation must remain an exact selected-source substring.");
    assert.equal(citation.quote.includes("EXCLUDED_REVELATION_SENTINEL"), false);
  }
  const unsupportedFacts = extracted.source.facts.filter((fact) => !supportedFacts.some((supported) => supported.id === fact.id));
  let synthesized;
  if (resumeWorldReview) {
    synthesized = extracted;
  } else {
    await page.reload();
    await page.getByText("Extraction complete.", { exact: false }).waitFor();
    for (const fact of supportedFacts) {
      const disposition = page.locator(`[data-fact-disposition='${fact.id}']`);
      await disposition.selectOption("accepted");
      assert.equal(await page.locator(`[data-fact-disposition='${fact.id}']`).inputValue(), "accepted");
    }
    for (const fact of unsupportedFacts) {
      const disposition = page.locator(`[data-fact-disposition='${fact.id}']`);
      const selection = fact.provenance === "inferred" ? "uncertain" : "rejected";
      await disposition.selectOption(selection);
      assert.equal(await disposition.inputValue(), selection);
    }
    const [representative, supporting] = supportedFacts;
    await page.locator(`[data-source-fact-id='${representative.id}'] button`).first().click();
    await page.locator(`[data-identity-fact-id='${representative.id}']`).click();
    await page.locator(`[data-identity-fact-id='${supporting.id}']`).click();
    await page.locator(`[data-identity-join='${supporting.id}']`).selectOption(representative.id);
    const roster = page.locator(`[data-roster-representative='${representative.id}']`);
    await roster.check();
    assert.equal(await roster.isChecked(), true);
    await capture(page, "source-reviewed-facts-citations-roster");
    await page.getByRole("button", { name: "Use selected facts", exact: true }).click();
    const savedReview = await until(() => json(jobPath), (job) => job.source?.acceptedFactIds?.length === supportedFacts.length && job.source?.selectedCharacterFactIds?.length === 1, "explicit source review save");
    assert.deepEqual([...savedReview.source.acceptedFactIds].sort(), supportedFacts.map((fact) => fact.id).sort());
    assert.deepEqual(savedReview.source.rejectedFactIds.sort(), unsupportedFacts.filter((fact) => fact.provenance !== "inferred").map((fact) => fact.id).sort());
    assert.deepEqual(savedReview.source.uncertainFactIds.sort(), unsupportedFacts.filter((fact) => fact.provenance === "inferred").map((fact) => fact.id).sort());
    assert.deepEqual(savedReview.source.selectedCharacterFactIds, [representative.id]);
    assert.deepEqual(savedReview.source.characterIdentityGroups, [{ representativeFactId: representative.id, factIds: [representative.id, supporting.id] }]);
    await page.getByRole("button", { name: "Generate world draft", exact: true }).click();
    synthesized = await until(
      () => json(jobPath),
      (job) => sourceWorldReady(job) || Boolean(closedCurrentSourceStage(job)),
      "source synthesis and selected character"
    );
  }
  await stopForClosedSourceStage(page, synthesized, "source-post-extraction-stage-closed");
  if (resumeWorldReview) await page.getByRole("button", { name: "Compare local and generated result", exact: true }).waitFor();
  await page.getByRole("button", { name: "Review available results", exact: true }).waitFor();
  await page.getByRole("button", { name: "Review available results", exact: true }).click();
  synthesized = await until(() => json(jobPath), reviewedSourceWorldReady, "explicit current source-world review adoption");
  assert.deepEqual([...synthesized.reviewedStageIds].sort(), [...currentSourceWorldStageIds(synthesized)].sort());
  assert.equal(synthesized.reviewedContent.playableCharacters.length, 1);
  await capture(page, "source-world-draft");
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  const applyResponse = page.waitForResponse((response) => response.url().endsWith(`${jobPath}/apply`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create world", exact: true }).click();
  const applied = await applyResponse;
  if (applied.status() !== 200) {
    await page.locator("[data-creation-error]").waitFor();
    await capture(page, "source-world-apply-error");
    process.stdout.write(`${JSON.stringify({ boundary: "source-world-apply", status: applied.status(), renderedCreationError: true })}\n`);
    throw new Error(`Source world apply returned HTTP ${applied.status()}.`);
  }
  await page.waitForURL(/\/app\/worlds\/[0-9a-f-]{36}/);
  const worldId = /\/app\/worlds\/([0-9a-f-]{36})/.exec(page.url())[1];
  const world = await json(`/api/v1/worlds/${worldId}`);
  assert.equal(JSON.stringify(world.draftContent.sourceMaterial).includes("EXCLUDED_REVELATION_SENTINEL"), false);
  assert.equal(world.draftContent.sourceMaterial.documents[0].text, selectedPrefix);
  assert.equal(world.draftContent.sourceMaterial.documents[0].sha256, createHash("sha256").update(selectedPrefix, "utf8").digest("hex"));
  await capture(page, "source-world-applied");
  const version = await json(`/api/v1/worlds/${worldId}/publish`, { expectedRevision: world.draftRevision, releaseNotes: "P3.9 disposable live source smoke" });
  assert.equal(version.worldId, worldId);
  assert.match(version.worldVersionId, /^[0-9a-f-]{36}$/u);
  const publishedCharacters = await json(`/api/v1/world-versions/${version.worldVersionId}/playable-characters`);
  assert.equal(publishedCharacters.characters.length, 1, "The selected reviewed roster must produce one published playable character.");
  const campaign = await json("/api/v1/campaigns", { worldVersionId: version.worldVersionId, selectedCharacterId: publishedCharacters.characters[0].id, title: "P3.9 disposable source campaign" });
  assert.equal(campaign.worldId, worldId);
  assert.equal(campaign.worldVersionId, version.worldVersionId);
  assert.equal(campaign.selectedCharacterId, publishedCharacters.characters[0].id);
  const exported = await json(`/api/v1/worlds/${worldId}/export?worldVersionId=${encodeURIComponent(version.worldVersionId)}`);
  assert.equal(exported.content.sourceMaterial.documents[0].text, selectedPrefix);
  assert.equal(exported.content.sourceMaterial.documents[0].sha256, createHash("sha256").update(selectedPrefix, "utf8").digest("hex"));
  assert.equal(JSON.stringify(exported.content.sourceMaterial).includes("EXCLUDED_REVELATION_SENTINEL"), false);
  await capture(page, "source-world-published-campaign-created");
  assert.equal(pageErrors.length, 0, "The rendered browser flow must not raise page errors.");
  assert.equal(consoleErrors.length, 0, "The rendered browser flow must not log console errors.");
  process.stdout.write(`${JSON.stringify({ result: "live-source-browser-smoke", provider: { role: selected[0].providerRole, model: selected[0].defaultModel }, job: safeJobSummary(await json(jobPath)), worldCreated: true, published: true, campaignCreated: true, pageErrors, consoleErrors })}\n`);
} finally {
  await browser.close();
}
