import { expect, test } from "@playwright/test";
import { authoringJobViewSchema, type AuthoringJobView } from "../../packages/contracts/src/authoring.js";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { validateSourceCitation } from "../../packages/domain/src/source-authoring.js";

const base = "http://127.0.0.1:43174";
type StorySourceJob = Extract<AuthoringJobView, { kind: "story_source" }>;
type SourceJob = StorySourceJob & { source: NonNullable<StorySourceJob["source"]> };

function sourceJob(input: Record<string, unknown>): SourceJob {
  return authoringJobViewSchema.parse({
    id: "source-job", revision: 1, kind: "story_source", status: "running", target: { kind: "new_world" }, request: input as never,
    stages: [], expiresAt: "2026-09-13T00:00:00.000Z", incomplete: true, canApply: false,
    source: { source: { id: "source", name: String(input.name), text: String(input.text), sha256: "0".repeat(64), paragraphs: [{ id: "paragraph:0", start: 0, end: Array.from(String(input.text)).length }] }, boundaryParagraphId: String(input.boundaryParagraphId), mode: input.mode === "expand" ? "expand" : "faithful", facts: [], extractionComplete: false, acceptedFactIds: [], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], expansionCandidates: [] }
  }) as SourceJob;
}

function sourceInput(text: string, name = "chapter.txt") {
  return { kind: "story_source", idempotencyKey: "source-request", target: { kind: "new_world" }, name, text, mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "" };
}

function authoringCapabilities(supportedKinds = ["world_concept", "story_source"]) {
  return { enabled: true, supportedKinds, limits: { activeJobsPerOwner: 5, maximumInputBytes: 2 * 1024 * 1024, listPageSize: 20 } };
}

async function openSource(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities()) }));
  await page.goto(`${base}/app/worlds/new`);
  await page.locator('[name="creationMethod"][value="source"]').check();
}

test("source intake preserves a pasted chapter and renders the visible boundary at desktop and narrow widths", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities()) }));
  await page.goto(`${base}/app/worlds/new`);
  await page.locator('[name="creationMethod"][value="source"]').check();
  const source = page.locator("[data-source-text]");
  await source.fill("Mara waits at the gate.\n\nThe harbor is silent.");
  await expect(source).toHaveValue(/Mara waits/);
  await expect(page.locator("[data-source-size]")).toContainText("bytes");
  await expect(page.locator("[data-source-boundary] option")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "From story or chapter", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Extract source facts" })).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("source-intake-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: testInfo.outputPath("source-intake-narrow.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("source file intake rejects unsupported, malformed, and oversized files before a request", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/v1/authoring/source-jobs", route => { submissions += 1; return route.abort(); });
  await openSource(page);
  const file = page.locator("[data-source-file]");
  await file.setInputFiles({ name: "chapter.pdf", mimeType: "application/pdf", buffer: Buffer.from("not text") });
  await expect(page.locator("[data-source-intake-status]")).toHaveText("Choose one TXT or Markdown file no larger than 1 MiB.");
  await file.setInputFiles({ name: "chapter.txt", mimeType: "text/plain", buffer: Buffer.from([0xc3, 0x28]) });
  await expect(page.locator("[data-source-intake-status]")).toHaveText("The file is not valid UTF-8 text.");
  await file.setInputFiles({ name: "large.md", mimeType: "text/markdown", buffer: Buffer.alloc(1024 * 1024 + 1, 0x61) });
  await expect(page.locator("[data-source-intake-status]")).toHaveText("Choose one TXT or Markdown file no larger than 1 MiB.");
  expect(submissions).toBe(0);
});

test("file double BOM, current boundary, and network retry-safe idempotency reach the source endpoint unchanged", async ({ page }) => {
  const posted: Record<string, unknown>[] = []; let attempt = 0;
  await page.route("**/api/v1/authoring/source-jobs", route => {
    const input = route.request().postDataJSON() as Record<string, unknown>; posted.push(input); attempt += 1;
    if (attempt === 1) return route.abort("failed");
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(sourceJob(input)) });
  });
  await openSource(page);
  await page.locator("[data-source-file]").setInputFiles({ name: "chapter.txt", mimeType: "text/plain", buffer: Buffer.from("\ufeff\ufeffOne\r\n\r\nTwo", "utf8") });
  await expect(page.locator("[data-source-text]")).toHaveValue("\ufeff\ufeffOne\n\nTwo");
  await page.locator("[data-source-boundary]").selectOption("paragraph:0");
  await page.getByRole("button", { name: "Extract source facts" }).click();
  await expect(page.locator("[data-source-intake-status]")).toHaveText("The source could not be submitted. Check the source and try again.");
  await expect(page.locator("body")).not.toContainText("private provider detail");
  await page.getByRole("button", { name: "Retry original source submission" }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[0]!.text).toBe("\ufeff\ufeffOne\r\n\r\nTwo");
  expect(posted[0]!.boundaryParagraphId).toBe("paragraph:0");
  expect(posted[1]!.idempotencyKey).toBe(posted[0]!.idempotencyKey);
});

test("a lost submit response keeps the original request immutable and restores pending edits for an explicit new proposal", async ({ page }, testInfo) => {
  const posted: Record<string, unknown>[] = [];
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/v1/authoring/source-jobs", async route => {
    const input = route.request().postDataJSON() as Record<string, unknown>;
    posted.push(input);
    if (posted.length === 1) { await firstResponse; return route.abort("failed"); }
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(sourceJob(input)) });
  });
  await openSource(page);
  await page.locator("[data-source-text]").fill("Original first.\n\nOriginal second.");
  await page.locator("[data-source-boundary]").selectOption("paragraph:1");
  await page.getByRole("button", { name: "Extract source facts" }).click();
  await expect.poll(() => posted.length).toBe(1);
  await page.locator("[data-source-text]").fill("Edited first.\n\nEdited second.");
  await page.locator("[data-source-boundary]").selectOption("paragraph:0");
  releaseFirst();
  await expect(page.locator("[data-source-intake-status]")).toContainText("could not be submitted");
  await page.locator("[data-source-text]").fill("");
  await expect(page.getByRole("button", { name: "Retry original source submission" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start new proposal from edited source" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("source-submit-cleared-retry-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: testInfo.outputPath("source-submit-cleared-retry-narrow.png"), fullPage: true });
  await page.locator("[data-source-text]").fill("Edited first.\n\nEdited second.");
  await page.locator("[data-source-boundary]").selectOption("paragraph:0");
  await page.getByRole("button", { name: "Retry original source submission" }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]).toEqual(posted[0]);
  await expect(page.getByRole("button", { name: "Start new proposal from edited source" })).toBeVisible();
  await page.getByRole("button", { name: "Start new proposal from edited source" }).click();
  await expect(page.locator("[data-source-text]")).toHaveValue("Edited first.\n\nEdited second.");
  await expect(page.locator("[data-source-boundary]")).toHaveValue("paragraph:0");
  await expect(page.locator("[data-source-intake-status]")).toContainText("new durable proposal");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("source-submit-recovery-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: testInfo.outputPath("source-submit-recovery-narrow.png"), fullPage: true });
  await page.getByRole("button", { name: "Extract source facts" }).click();
  await expect.poll(() => posted.length).toBe(3);
  expect(posted[2]).toMatchObject({ text: "Edited first.\n\nEdited second.", boundaryParagraphId: "paragraph:0" });
  expect(posted[2]!.idempotencyKey).not.toBe(posted[0]!.idempotencyKey);
});

test("paragraph deletion replaces a stale source boundary before submission", async ({ page }) => {
  let received: Record<string, unknown> | null = null;
  await page.route("**/api/v1/authoring/source-jobs", route => { received = route.request().postDataJSON() as Record<string, unknown>; return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(sourceJob(received!)) }); });
  await openSource(page);
  const text = page.locator("[data-source-text]");
  await text.fill("First paragraph.\n\nSecond paragraph.");
  await page.locator("[data-source-boundary]").selectOption("paragraph:1");
  await text.fill("First paragraph.");
  await expect(page.locator("[data-source-boundary]")).toHaveValue("paragraph:0");
  await expect(page.locator("[data-source-boundary] option")).toHaveCount(1);
  await page.getByRole("button", { name: "Extract source facts" }).click();
  await expect.poll(() => received).not.toBeNull();
  expect(received!.boundaryParagraphId).toBe("paragraph:0");
});

test("evidence review keeps same-name identities separate, joins supporting facts, and saves representative-only roster choices", async ({ page }, testInfo) => {
  const text = "Iris watches the gate.\n\nIris repairs the lantern.\n\nIris sails north.";
  const sourceDocument = normalizeSourceDocument("chapter.txt", text, "source");
  const citation = (paragraphId: string, quote: string) => {
    const paragraph = sourceDocument.paragraphs.find((item) => item.id === paragraphId)!;
    const paragraphText = Array.from(sourceDocument.text).slice(paragraph.start, paragraph.end).join("");
    const stringOffset = paragraphText.indexOf(quote);
    if (stringOffset < 0) throw new Error(`Fixture quote is absent from ${paragraphId}.`);
    const start = paragraph.start + Array.from(paragraphText.slice(0, stringOffset)).length;
    const result = { sourceId: "source", paragraphId, start, end: start + Array.from(quote).length, quote };
    if (!validateSourceCitation(sourceDocument, result)) throw new Error(`Fixture citation is invalid for ${paragraphId}.`);
    return result;
  };
  const facts: SourceJob["source"]["facts"] = [
    { id: "iris-a", kind: "character", subject: "Iris", predicate: "watches", value: "the gate", provenance: "stated", citations: [citation("paragraph:0", "Iris watches the gate.")] },
    { id: "iris-support", kind: "character", subject: "Iris", predicate: "repairs", value: "the lantern", provenance: "stated", citations: [citation("paragraph:1", "Iris repairs the lantern.")] },
    { id: "iris-b", kind: "character", subject: "Iris", predicate: "sails", value: "north", provenance: "stated", citations: [citation("paragraph:2", "Iris sails north.")] },
    { id: "inferred", kind: "rule", subject: "Gate", predicate: "is", value: "guarded", provenance: "inferred", citations: [citation("paragraph:0", "gate")] },
    { id: "rejected", kind: "event", subject: "Iris", predicate: "leaves", value: "at dawn", provenance: "stated", citations: [citation("paragraph:2", "Iris sails north.")] },
    { id: "invented", kind: "tone", subject: "World", predicate: "feels", value: "bleak", provenance: "invented", citations: [] }
  ];
  let view: SourceJob | null = null; const reviews: Record<string, unknown>[] = []; let polls = 0;
  await page.route("**/api/v1/authoring/source-jobs**", route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/source-jobs")) {
      const input = request.postDataJSON() as Record<string, unknown>;
      view = sourceJob({ ...input, mode: "expand" }); view.status = "awaiting_review"; view.stages = [{ id: "chunk-0", key: "source:chunk:0", status: "validated", generation: 1, attemptCount: 1 }]; view.source = { ...view.source, source: sourceDocument, mode: "expand", extractionComplete: true, facts, expansionCandidates: [facts[3]!, facts[5]!], acceptedFactIds: ["iris-a", "iris-support", "iris-b"], rejectedFactIds: ["rejected"], uncertainFactIds: ["inferred", "invented"] };
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(view)) });
    }
    if (request.method() === "PUT" && url.pathname.endsWith("/facts")) {
      const review = request.postDataJSON() as Record<string, unknown>; reviews.push(review);
      view!.revision += 1; view!.source = { ...view!.source, acceptedFactIds: review.acceptedFactIds as string[], rejectedFactIds: review.rejectedFactIds as string[], uncertainFactIds: review.uncertainFactIds as string[], selectedCharacterFactIds: review.selectedCharacterFactIds as string[], characterIdentityGroups: review.characterIdentityGroups as never };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(view)) });
    }
    return route.fallback();
  });
  await page.route("**/api/v1/authoring/jobs/source-job", route => { polls += 1; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(view)) }); });
  await openSource(page);
  await page.locator("[data-source-text]").fill(text);
  await page.getByRole("button", { name: "Extract source facts" }).click();
  await expect(page.getByText("Extraction complete.")).toBeVisible();
  await expect(page.locator("[data-source-fact-id='inferred']")).toHaveCount(1);
  await expect(page.locator("[data-source-fact-id='invented']")).toHaveCount(1);
  await expect(page.locator("[data-fact-disposition='inferred']")).toHaveCount(1);
  await expect(page.locator("[data-fact-disposition='invented']")).toHaveCount(1);
  const irisA = page.locator("[data-source-fact-id='iris-a']");
  const pollsBeforeOpen = polls;
  await irisA.getByRole("button", { name: "Show paragraph:0" }).click();
  await expect(page.getByText(`paragraph:0 (0–${sourceDocument.paragraphs[0]!.end}): Iris watches the gate.`)).toBeVisible();
  await expect.poll(() => polls).toBeGreaterThan(pollsBeforeOpen);
  await expect(page.getByText(`paragraph:0 (0–${sourceDocument.paragraphs[0]!.end}): Iris watches the gate.`)).toBeVisible();
  await page.locator("[data-identity-fact-id='iris-a']").click();
  await page.locator("[data-identity-fact-id='iris-support']").click();
  await page.locator("[data-identity-join='iris-support']").selectOption("iris-a");
  await page.locator("[data-identity-fact-id='iris-b']").click();
  await expect(page.locator("[data-roster-representative]")).toHaveCount(2);
  await page.locator("[data-identity-representative='iris-a']").selectOption("iris-support");
  await page.locator("[data-roster-representative='iris-support']").check();
  await page.locator("[data-fact-disposition='inferred']").selectOption("accepted");
  await page.locator("[data-fact-disposition='rejected']").selectOption("rejected");
  await page.locator("[data-fact-disposition='invented']").selectOption("uncertain");
  await page.getByRole("button", { name: "Use selected facts" }).click();
  await expect.poll(() => reviews.length).toBe(1);
  expect(reviews[0]).toMatchObject({ acceptedFactIds: ["iris-a", "iris-support", "iris-b", "inferred"], rejectedFactIds: ["rejected"], uncertainFactIds: ["invented"], selectedCharacterFactIds: ["iris-support"], characterIdentityGroups: [{ representativeFactId: "iris-support", factIds: ["iris-a", "iris-support"] }, { representativeFactId: "iris-b", factIds: ["iris-b"] }] });
  await page.locator("[data-roster-representative='iris-support']").uncheck();
  await page.getByRole("button", { name: "Use selected facts" }).click();
  await expect.poll(() => reviews.length).toBe(2);
  expect(reviews[1]!.selectedCharacterFactIds).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 }); await page.screenshot({ path: testInfo.outputPath("source-evidence-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true); await page.screenshot({ path: testInfo.outputPath("source-evidence-narrow.png"), fullPage: true });
});

test("manual facts remap request-local character identity to server IDs without duplicate resubmission", async ({ page }, testInfo) => {
  const source = normalizeSourceDocument("chapter.txt", "Gate.", "source"); let job: SourceJob | null = null; const reviews: Record<string, unknown>[] = []; let persisted: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/authoring/source-jobs**", route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/source-jobs")) { const input = request.postDataJSON() as Record<string, unknown>; job = sourceJob(input); job.status = "awaiting_review"; job.source = { ...job.source, source, extractionComplete: true, facts: [], acceptedFactIds: [], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], expansionCandidates: [] }; return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) }); }
    if (request.method() === "PUT") { const review = request.postDataJSON() as Record<string, unknown>; reviews.push(review); job!.revision += 1; const localIds = (review.manualFacts as Array<Record<string, unknown>>).map((fact) => String(fact.id)); if (localIds.length) persisted = (review.manualFacts as Array<Record<string, unknown>>).map((fact, index) => ({ ...fact, id: `server-manual-${index}` })); const serverId = (id: string) => { const index = localIds.indexOf(id); return index >= 0 ? `server-manual-${index}` : id; }; job!.source = { ...job!.source, facts: persisted as never, acceptedFactIds: (review.acceptedFactIds as string[]).map(serverId), rejectedFactIds: review.rejectedFactIds as string[], uncertainFactIds: review.uncertainFactIds as string[], selectedCharacterFactIds: (review.selectedCharacterFactIds as string[]).map(serverId), characterIdentityGroups: (review.characterIdentityGroups as Array<{ representativeFactId: string; factIds: string[] }>).map((group) => ({ representativeFactId: serverId(group.representativeFactId), factIds: group.factIds.map(serverId) })) }; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) }); }
    return route.fallback();
  });
  await page.route("**/api/v1/authoring/jobs/source-job", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) }));
  await openSource(page); await page.locator("[data-source-text]").fill("Gate."); await page.getByRole("button", { name: "Extract source facts" }).click();
  await page.getByRole("button", { name: "Add manual fact" }).click(); await expect(page.locator("[data-identity-fact-id]")).toHaveCount(0);
  await page.locator("[name='manual.kind']").selectOption("character"); await page.locator("[name='manual.subject']").fill("Mara"); await page.locator("[name='manual.predicate']").fill("guards"); await page.locator("[name='manual.value']").fill("the gate"); await page.getByRole("button", { name: "Add manual fact" }).click();
  await page.locator("[name='manual.kind']").selectOption("rule"); await page.locator("[name='manual.subject']").fill("Gate"); await page.locator("[name='manual.predicate']").fill("requires"); await page.locator("[name='manual.value']").fill("a key"); await page.getByRole("button", { name: "Add manual fact" }).click();
  await page.locator("[data-identity-fact-id]").click(); await page.locator("[data-roster-representative]").check();
  await page.getByRole("button", { name: "Use selected facts" }).click(); await expect.poll(() => reviews.length).toBe(1);
  const first = reviews[0]!; const firstManual = first.manualFacts as Array<Record<string, unknown>>; expect(firstManual).toHaveLength(2); expect(new Set(firstManual.map((fact) => fact.id)).size).toBe(2); expect(firstManual).toEqual(expect.arrayContaining([expect.objectContaining({ provenance: "manual", citations: [], kind: "character" }), expect.objectContaining({ provenance: "manual", citations: [], kind: "rule" })])); expect(first.acceptedFactIds).toEqual(expect.arrayContaining(firstManual.map((fact) => fact.id))); expect(first.selectedCharacterFactIds).toHaveLength(1);
  await page.getByRole("button", { name: "Use selected facts" }).click(); await expect.poll(() => reviews.length).toBe(2);
  expect(reviews[1]!.manualFacts).toEqual([]); expect(reviews[1]!.acceptedFactIds).toEqual(["server-manual-0", "server-manual-1"]); expect(reviews[1]!.selectedCharacterFactIds).toEqual(["server-manual-0"]); expect(reviews[1]!.characterIdentityGroups).toEqual([{ representativeFactId: "server-manual-0", factIds: ["server-manual-0"] }]); await expect(page.locator("[data-source-fact-id='server-manual-0']")).toHaveAttribute("aria-label", "manual: Mara — guards: the gate"); await expect(page.locator("[data-source-fact-id='server-manual-1']")).toHaveAttribute("aria-label", "manual: Gate — requires: a key"); await page.screenshot({ path: testInfo.outputPath("source-manual-review.png"), fullPage: true });
});

function sourceListItem(job: SourceJob) {
  const { request: _request, result: _result, reviewedContent: _reviewed, reviewedStageIds: _selection, source: _source, ...item } = job;
  return item;
}

function sourceWorldContent(source: SourceJob["source"]["source"], acceptedFact: SourceJob["source"]["facts"][number]) {
  return {
    schemaVersion: 6,
    world: {
      title: "Harbor of Glass",
      genre: "",
      tone: "Quiet",
      premise: "A silent harbor waits beneath a glass moon.",
      backgroundStory: "The harbor remembers every departing ship.",
      firstAction: "Approach the north gate.",
      rules: "Promises made at the gate endure."
    },
    playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {},
    sourceMaterial: { version: 1, documents: [source], boundary: { sourceId: source.id, paragraphId: "paragraph:0" }, acceptedFacts: [acceptedFact], fieldEvidence: [{ path: "world.premise", factIds: [acceptedFact.id] }], characterIdentityGroups: [] }
  };
}

test("source query refresh and owner-list selection resume the same durable extraction with one poll owner", async ({ page }) => {
  const input = sourceInput("Mara waits.");
  const job = sourceJob(input); let reads = 0;
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities()) }));
  await page.route("**/api/v1/authoring/jobs**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/authoring/jobs") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobs: [sourceListItem(job)] }) });
    reads += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.goto(`${base}/app/worlds/new?authoringJob=source-job`);
  await expect(page.locator('[name="creationMethod"][value="source"]')).toBeChecked();
  await expect(page.getByText("Extraction is running; synthesis remains unavailable.")).toBeVisible();
  const beforePoll = reads;
  await expect.poll(() => reads).toBeGreaterThan(beforePoll);
  await page.reload();
  await expect(page.locator('[name="creationMethod"][value="source"]')).toBeChecked();
  await expect(page.getByText("Extraction is running; synthesis remains unavailable.")).toBeVisible();

  await page.goto(`${base}/app/worlds/new`);
  await page.locator('[name="creationMethod"][value="source"]').check();
  await page.getByRole("button", { name: "Show saved proposals" }).click();
  await page.getByRole("button", { name: /source-job · running/ }).click();
  await expect(page).toHaveURL(/authoringJob=source-job/);
  await expect(page.locator('[name="creationMethod"][value="source"]')).toBeChecked();
  await expect(page.getByText("chapter.txt", { exact: false }).first()).toBeVisible();
});

test("current source-stage failure stays actionable and a rejected retry remains caught", async ({ page }, testInfo) => {
  const input = sourceInput("Mara waits.");
  const job = sourceJob(input);
  job.status = "recoverable";
  job.stages = [
    { id: "old-synthesis", key: "source:synthesis", generation: 1, status: "failed", attemptCount: 1 },
    { id: "new-synthesis", key: "source:synthesis", generation: 2, status: "validated", attemptCount: 1 },
    { id: "current-chunk", key: "source:chunk:1", generation: 1, status: "recoverable", attemptCount: 1 }
  ];
  let attempts = 0;
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities()) }));
  await page.route("**/api/v1/authoring/jobs/source-job/retry", route => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "authoring_unavailable" }) });
    job.revision += 1; job.status = "running"; job.stages[2] = { ...job.stages[2]!, generation: 2, status: "queued" };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/authoring/jobs/source-job", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) }));
  await page.goto(`${base}/app/worlds/new?authoringJob=source-job`);
  await expect(page.getByText("Extraction needs retry before synthesis can begin.")).toBeVisible();
  await expect(page.getByText("Retry source:synthesis", { exact: true })).toHaveCount(0);
  await page.locator("[data-retry-stage-id='current-chunk']").click();
  await expect(page.locator("[data-source-command-status]")).toContainText("unavailable");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("source-failure-retry-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: testInfo.outputPath("source-failure-retry-narrow.png"), fullPage: true });
  await page.locator("[data-retry-stage-id='current-chunk']").click();
  await expect(page.locator("[data-source-command-status]")).toContainText("retry queued");
  expect(attempts).toBe(2);
});

test("a paused source capability still resumes and saves fact review while synthesis reports the execution pause", async ({ page }, testInfo) => {
  const input = sourceInput("The harbor is silent.");
  const source = normalizeSourceDocument("chapter.txt", input.text, "source");
  const job = sourceJob(input);
  const citation = { sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: Array.from(input.text).length, quote: input.text };
  const fact = { id: "harbor", kind: "location" as const, subject: "Harbor", predicate: "is", value: "silent", provenance: "stated" as const, citations: [citation] };
  job.status = "awaiting_review"; job.incomplete = false;
  job.source = { ...job.source, source, extractionComplete: true, facts: [fact], acceptedFactIds: [fact.id] };
  let reviews = 0;
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities(["world_concept"])) }));
  await page.route("**/api/v1/authoring/source-jobs/source-job/facts", route => {
    reviews += 1; job.revision += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/authoring/source-jobs/source-job/synthesis", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "source_authoring_disabled" }) }));
  await page.route("**/api/v1/authoring/jobs/source-job", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) }));
  await page.goto(`${base}/app/worlds/new?authoringJob=source-job`);
  await expect(page.locator('[name="creationMethod"][value="source"]')).toBeDisabled();
  await expect(page.getByText("Extraction complete.")).toBeVisible();
  await page.getByRole("button", { name: "Use selected facts" }).click();
  await expect.poll(() => reviews).toBe(1);
  await page.getByRole("button", { name: "Generate world draft" }).click();
  await expect(page.locator("[data-source-command-status]")).toContainText("Story-source execution is paused");
  await expect(page.locator("[data-fact-disposition='harbor']")).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("source-paused-resume-review-desktop.png"), fullPage: true });
});

test("a source-review 409 preserves focused local work until explicit compare and reconciliation", async ({ page }, testInfo) => {
  const input = sourceInput("The gate stands north.\n\nThe tower stands south.");
  input.boundaryParagraphId = "paragraph:1";
  const job = sourceJob(input);
  const source = normalizeSourceDocument("chapter.txt", input.text, "source");
  const citation = (paragraphId: string, quote: string) => {
    const paragraph = source.paragraphs.find((item) => item.id === paragraphId)!;
    const passage = Array.from(source.text).slice(paragraph.start, paragraph.end).join("");
    const offset = passage.indexOf(quote);
    const start = paragraph.start + Array.from(passage.slice(0, offset)).length;
    return { sourceId: source.id, paragraphId, start, end: start + Array.from(quote).length, quote };
  };
  const facts = [
    { id: "gate", kind: "location" as const, subject: "Gate", predicate: "stands", value: "north", provenance: "stated" as const, citations: [citation("paragraph:0", "gate stands north")] },
    { id: "tower", kind: "location" as const, subject: "Tower", predicate: "stands", value: "south", provenance: "stated" as const, citations: [citation("paragraph:1", "tower stands south")] }
  ];
  job.status = "awaiting_review"; job.incomplete = false; job.source = { ...job.source, source, extractionComplete: true, facts, acceptedFactIds: ["gate"], rejectedFactIds: ["tower"] };
  let reads = 0; let saves = 0; const reviews: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities()) }));
  await page.route("**/api/v1/authoring/source-jobs/source-job/facts", route => {
    const review = route.request().postDataJSON() as Record<string, unknown>; reviews.push(review); saves += 1;
    if (saves === 1) { job.revision = 2; return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "authoring_revision_conflict" }) }); }
    job.revision = 3; job.source = { ...job.source, acceptedFactIds: review.acceptedFactIds as string[], rejectedFactIds: review.rejectedFactIds as string[], uncertainFactIds: review.uncertainFactIds as string[] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/authoring/jobs/source-job", route => { reads += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) }); });
  await page.goto(`${base}/app/worlds/new?authoringJob=source-job`);
  await page.locator("[data-fact-disposition='gate']").selectOption("rejected");
  await page.locator("[data-fact-disposition='tower']").selectOption("accepted");
  const manual = page.locator("[name='manual.subject']");
  await manual.fill("Mar"); await manual.focus();
  const before = reads; await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(manual).toHaveValue("Mar");
  await expect(manual).toBeFocused();
  await page.getByRole("button", { name: "Use selected facts" }).click();
  await expect(page.locator("[data-source-review-conflict]")).toBeVisible();
  await expect(page.locator("[data-fact-disposition='gate']")).toHaveValue("rejected");
  await page.getByRole("button", { name: "Compare server review" }).click();
  await expect(page.locator("[data-source-review-comparison]")).toContainText("Server revision 2");
  await expect(page.locator("[data-source-review-comparison]")).toContainText("Your review uses revision 1");
  await expect(page.locator("[data-source-review-comparison]")).toContainText("Gate — stands: north · Local: rejected · Server: accepted");
  await expect(page.locator("[data-source-review-comparison]")).toContainText("Tower — stands: south · Local: accepted · Server: rejected");
  await page.locator("[data-source-review-difference='gate']").getByRole("button", { name: "Show paragraph:0" }).click();
  await expect(page.locator("[data-source-review-difference='gate']")).toContainText("gate stands north");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("source-review-conflict-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: testInfo.outputPath("source-review-conflict-narrow.png"), fullPage: true });
  await page.getByRole("button", { name: "Keep local decisions on revision 2" }).click();
  await page.getByRole("button", { name: "Use selected facts" }).click();
  await expect.poll(() => saves).toBe(2);
  expect(reviews[1]).toMatchObject({ expectedRevision: 2, acceptedFactIds: ["tower"], rejectedFactIds: ["gate"] });
});

test("source synthesis requires explicit adoption, preserves edits through polls, and applies only the reviewed draft", async ({ page }, testInfo) => {
  const input = sourceInput("The harbor is silent.");
  const job = sourceJob(input);
  const source = normalizeSourceDocument("chapter.txt", input.text, "source");
  const citation = { sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: Array.from(input.text).length, quote: input.text };
  if (!validateSourceCitation(source, citation)) throw new Error("Final synthesis fixture citation must match the retained source.");
  const fact = { id: "harbor", kind: "location" as const, subject: "Harbor", predicate: "is", value: "silent", provenance: "stated" as const, citations: [citation] };
  job.status = "awaiting_review"; job.incomplete = false; job.source = { ...job.source, source, extractionComplete: true, facts: [fact], acceptedFactIds: [fact.id] };
  const result = sourceWorldContent(job.source.source, fact);
  let synthesisStarted = false; let synthesisReads = 0; let legacyWorldWrites = 0;
  const reviewBodies: Array<Record<string, unknown>> = []; const applyBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/authoring/capabilities", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringCapabilities()) }));
  await page.route("**/api/v1/authoring/source-jobs/source-job/facts", route => {
    const review = route.request().postDataJSON() as Record<string, unknown>;
    job.revision += 1; job.source = { ...job.source, acceptedFactIds: review.acceptedFactIds as string[], rejectedFactIds: review.rejectedFactIds as string[], uncertainFactIds: review.uncertainFactIds as string[] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/authoring/source-jobs/source-job/synthesis", route => {
    synthesisStarted = true; job.revision += 1; job.status = "running"; job.incomplete = true;
    job.stages = [{ id: "source-world", key: "source:synthesis", generation: 1, status: "queued", attemptCount: 1 }];
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/authoring/jobs/source-job/review", route => {
    const review = route.request().postDataJSON() as Record<string, unknown>; reviewBodies.push(review);
    job.revision += 1; job.reviewedContent = review.content as never; job.reviewedStageIds = review.selectedStageIds as string[]; job.canApply = true;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/authoring/jobs/source-job/apply", route => {
    applyBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    job.revision += 1; job.status = "applied"; job.canApply = false;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobId: job.id, worldId: "44444444-4444-4444-8444-444444444444", draftRevision: 1 }) });
  });
  await page.route("**/api/v1/authoring/jobs/source-job", route => {
    if (synthesisStarted) {
      synthesisReads += 1;
      if (synthesisReads >= 1 && !job.result) {
        job.revision += 1; job.status = "awaiting_review"; job.incomplete = false; job.result = result as never;
        job.stages = [
          { id: "source-plan", key: "source:plan", generation: 1, status: "validated", attemptCount: 1 },
          { id: "source-chunk", key: "source:chunk:0", generation: 1, status: "validated", attemptCount: 1 },
          { id: "source-world", key: "source:synthesis", generation: 1, status: "validated", attemptCount: 1 },
          { id: "source-character", key: "source:character:harbor", generation: 1, status: "validated", attemptCount: 1 }
        ];
      }
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(authoringJobViewSchema.parse(job)) });
  });
  await page.route("**/api/v1/worlds", route => { if (route.request().method() === "POST") legacyWorldWrites += 1; return route.abort(); });
  await page.route("**/api/v1/worlds/44444444-4444-4444-8444-444444444444", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", title: "Reviewed Harbor", status: "draft", imageUrl: "", forkedFromWorldId: null, forkedFromWorldVersionId: null, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", draftRevision: 1, draftContent: result, draftBasedOnWorldVersionId: null, draftUpdatedAt: "2026-09-07T00:00:00.000Z", versions: [], campaigns: [] }) }));

  await page.goto(`${base}/app/worlds/new?authoringJob=source-job`);
  await page.getByRole("button", { name: "Use selected facts" }).click();
  await page.getByRole("button", { name: "Generate world draft" }).click();
  expect(legacyWorldWrites).toBe(0); expect(applyBodies).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Review available results" })).toBeVisible();
  await page.getByRole("button", { name: "Review available results" }).click();
  const title = page.locator('[name="world.title"]'); const genre = page.locator('[name="world.genre"]');
  await expect(genre).toHaveValue("");
  const readsBeforeEditing = synthesisReads;
  await title.fill("Reviewed Harbor"); await genre.fill("Coastal fantasy");
  await expect.poll(() => synthesisReads).toBeGreaterThan(readsBeforeEditing);
  await expect(title).toHaveValue("Reviewed Harbor"); await expect(genre).toHaveValue("Coastal fantasy");
  await expect.poll(() => reviewBodies.length).toBeGreaterThan(0);
  expect(reviewBodies.at(-1)?.content).toMatchObject({ world: { title: "Reviewed Harbor", genre: "Coastal fantasy" } });
  expect(reviewBodies.at(-1)?.selectedStageIds).toEqual(["source-character", "source-world"]);
  expect(legacyWorldWrites).toBe(0); expect(applyBodies).toHaveLength(0);
  await page.setViewportSize({ width: 1280, height: 720 }); await page.screenshot({ path: testInfo.outputPath("source-final-draft-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true); await page.screenshot({ path: testInfo.outputPath("source-final-draft-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  for (let index = 0; index < 5; index += 1) await page.locator('[data-action="continue-stage"]').click();
  await page.getByRole("button", { name: "Create world", exact: true }).click();
  await expect.poll(() => applyBodies.length).toBe(1);
  expect(applyBodies[0]).toMatchObject({ selectedStageIds: ["source-character", "source-world"], content: { world: { title: "Reviewed Harbor", genre: "Coastal fantasy" } } });
  expect(legacyWorldWrites).toBe(0);
});
