import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { AuthoringJobsApiError } from "../../apps/web-next/src/authoring-jobs-api.js";
import { createSourceAuthoringApi, SourceAuthoringApiError } from "../../apps/web-next/src/source-authoring-api.js";
import { mountSourceAuthoringPanel } from "../../apps/web-next/src/source-authoring-panel.js";
import { normalizeSourceText, sourceParagraphMap } from "../../packages/contracts/src/source-normalization.js";

const job = {
  id: "source-job", revision: 1, status: "awaiting_review", target: { kind: "new_world" }, stages: [],
  expiresAt: "2026-09-13T00:00:00.000Z", canApply: false, incomplete: false, kind: "story_source",
  source: {
    source: { id: "source", name: "chapter.txt", text: "Mara waits.", sha256: "0".repeat(64), paragraphs: [{ id: "paragraph:0", start: 0, end: 11 }] },
    boundaryParagraphId: "paragraph:0", mode: "faithful", facts: [], extractionComplete: true,
    acceptedFactIds: [], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], expansionCandidates: []
  }
};

describe("source authoring API", () => {
  it("uses the named source endpoints and validates the returned owner projection", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(job), { status: 202 }));
    const api = createSourceAuthoringApi(fetch as typeof globalThis.fetch);
    const submitted = await api.submitSourceAuthoring({ kind: "story_source", idempotencyKey: "key", target: { kind: "new_world" }, name: "chapter.txt", text: "Mara waits.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "" });
    await api.saveSourceFactReview(submitted.id, { expectedRevision: 1, acceptedFactIds: [], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: [] });
    await api.beginSourceSynthesis(submitted.id, 1);
    expect(fetch.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/v1/authoring/source-jobs", "POST"],
      ["/api/v1/authoring/source-jobs/source-job/facts", "PUT"],
      ["/api/v1/authoring/source-jobs/source-job/synthesis", "POST"]
    ]);
  });

  it.each([
    [409, "authoring_idempotency_conflict", "different source request"],
    [409, "authoring_revision_conflict", "changed elsewhere"],
    [409, "choose_source_facts", "Choose at least one"],
    [409, "authoring_invalid_state", "cannot accept"],
    [429, "authoring_active_job_limit", "Finish, cancel, or discard"]
  ])("maps allowlisted %s %s responses to fixed safe messages", async (status, code, message) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: "private provider detail" }), { status }));
    const api = createSourceAuthoringApi(fetch as typeof globalThis.fetch);
    const request = { kind: "story_source", idempotencyKey: "key", target: { kind: "new_world" }, name: "chapter.txt", text: "Mara waits.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "" } as const;
    const error = await api.submitSourceAuthoring(request).catch((caught) => caught);
    expect(error).toMatchObject({ name: "SourceAuthoringApiError", status, code });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("private provider detail");
  });

  it.each(["provider_exploded", "toString", "constructor"])("uses a safe generic fallback for unknown or inherited server code %s", async (code) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: "private provider detail" }), { status: 409 }));
    const api = createSourceAuthoringApi(fetch as typeof globalThis.fetch);
    const error = await api.beginSourceSynthesis("source-job", 1).catch((caught) => caught);
    expect(error).toMatchObject({ name: "SourceAuthoringApiError", status: 409, code: "unknown" });
    expect(error.message).toBe("The source authoring request could not be completed. Try again.");
  });
});

it("keeps the second BOM and code-point paragraph offsets in the browser-safe preview", () => {
  const normalized = normalizeSourceText("\uFEFF\uFEFFA\r\n\r\n😀 gate");
  expect(normalized).toBe("\uFEFFA\n\n😀 gate");
  expect(sourceParagraphMap(normalized)).toEqual([
    { id: "paragraph:0", start: 0, end: 2 },
    { id: "paragraph:1", start: 4, end: 10 }
  ]);
});

it("shows twenty selected identity representatives and disables the twenty-first roster choice", () => {
  const { document } = parseHTML("<main></main>");
  const facts = Array.from({ length: 21 }, (_, index) => ({ id: `character-${index}`, kind: "character" as const, subject: `Iris ${index}`, predicate: "waits", value: "at the gate", provenance: "stated" as const, citations: [] }));
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: { submitSourceAuthoring: vi.fn(), saveSourceFactReview: vi.fn(), beginSourceSynthesis: vi.fn() } });
  panel.resume({ ...job, source: { ...job.source, facts, acceptedFactIds: facts.map((fact) => fact.id), selectedCharacterFactIds: facts.slice(0, 20).map((fact) => fact.id), characterIdentityGroups: facts.map((fact) => ({ representativeFactId: fact.id, factIds: [fact.id] })) } } as never);
  expect(document.querySelectorAll("[data-roster-representative]")).toHaveLength(21);
  expect((document.querySelector<HTMLInputElement>("[data-roster-representative='character-20']")!).disabled).toBe(true);
  expect(document.querySelector("main")!.textContent).toContain("maximum 20 representatives");
});

it("keeps ordinary source typing focused and renders exact evidence with an explicit character identity action", () => {
  const { document, window } = parseHTML("<main></main>");
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: { submitSourceAuthoring: vi.fn(), saveSourceFactReview: vi.fn(), beginSourceSynthesis: vi.fn() } });
  const editor = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  editor.value = "Mara waits."; editor.focus(); editor.dispatchEvent(new window.Event("input"));
  expect(document.querySelector<HTMLTextAreaElement>("[data-source-text]")?.value).toBe("Mara waits.");
  expect(document.querySelector("[data-action='submit-source']")).not.toBeNull();
  panel.resume({ ...job, stages: [{ id: "chunk", key: "source:chunk:0", generation: 1, status: "validated", attempts: 1 }], source: { ...job.source, facts: [{ id: "mara", kind: "character", subject: "Mara", predicate: "waits", value: "at the gate", provenance: "stated", citations: [{ sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 11, quote: "Mara waits." }] }] } } as never);
  expect(document.querySelector("main")!.textContent).toContain("paragraph:0 (0–11): Mara waits.");
  panel.resume({ ...job, source: { ...job.source, acceptedFactIds: ["mara"], facts: [{ id: "mara", kind: "character", subject: "Mara", predicate: "waits", value: "at the gate", provenance: "stated", citations: [{ sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 11, quote: "Mara waits." }] }] } } as never);
  const identity = document.querySelector<HTMLButtonElement>("[data-identity-fact-id='mara']")!;
  expect(identity.textContent).toContain("Confirm separate identity");
  identity.click();
  expect(document.querySelector("main")!.textContent).toContain("Identity confirmed: Mara");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function sourceApi(overrides: Record<string, unknown> = {}) {
  return {
    submitSourceAuthoring: vi.fn(),
    saveSourceFactReview: vi.fn(),
    beginSourceSynthesis: vi.fn(),
    ...overrides
  };
}

function choose(select: HTMLSelectElement, value: string, window: Window): void {
  Object.defineProperty(select, "value", { configurable: true, value });
  select.dispatchEvent(new window.Event("change"));
}

it("hands a submitted source job to the durable session immediately without starting a second poll owner", async () => {
  vi.useFakeTimers();
  const { document, window } = parseHTML("<main></main>");
  const running = { ...job, status: "running", incomplete: true, source: { ...job.source, extractionComplete: false } };
  const api = sourceApi({ submitSourceAuthoring: vi.fn().mockResolvedValue(running) });
  const loadAuthoringJob = vi.fn();
  const onJobAvailable = vi.fn();
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, {
    api: api as never,
    authoringJobs: { loadAuthoringJob, retryAuthoringStage: vi.fn() },
    onJobAvailable
  } as never);
  const editor = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  editor.value = "Mara waits.";
  editor.dispatchEvent(new window.Event("input"));
  document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(onJobAvailable).toHaveBeenCalledWith(running);
  expect(document.querySelector("main")!.textContent).toContain("Extraction is still running");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(loadAuthoringJob).not.toHaveBeenCalled();
  panel.dispose();
  vi.useRealTimers();
});

it("preserves a manual fact draft and dirty dispositions when the owning session receives a poll", () => {
  const { document, window } = parseHTML("<main></main>");
  const fact = { id: "mara", kind: "character", subject: "Mara", predicate: "waits", value: "at the gate", provenance: "stated", citations: [] };
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi() as never });
  panel.resume({ ...job, source: { ...job.source, facts: [fact], acceptedFactIds: [fact.id] } } as never);
  const disposition = document.querySelector<HTMLSelectElement>("[data-fact-disposition='mara']")!;
  choose(disposition, "uncertain", window as unknown as Window);
  const subject = document.querySelector<HTMLInputElement>("[name='manual.subject']")!;
  subject.value = "Mar";
  subject.dispatchEvent(new window.Event("input"));
  subject.focus();
  panel.resume({ ...job, revision: 2, stages: [{ id: "chunk", key: "source:chunk:0", generation: 1, status: "validated", attemptCount: 1 }], source: { ...job.source, facts: [fact], acceptedFactIds: [fact.id] } } as never);
  expect(document.querySelector<HTMLInputElement>("[name='manual.subject']")!.value).toBe("Mar");
  expect(document.querySelector<HTMLSelectElement>("[data-fact-disposition='mara']")!.value).toBe("uncertain");
});

it("rebases edits made during a manual-fact save onto returned durable IDs without resubmitting saved additions", async () => {
  const { document, window } = parseHTML("<main></main>");
  const baseFact = { id: "gate", kind: "location", subject: "Gate", predicate: "stands", value: "north", provenance: "stated", citations: [] };
  const first = deferred<typeof job>();
  const requests: Array<Record<string, unknown>> = [];
  const save = vi.fn(async (_id: string, review: Record<string, unknown>) => {
    requests.push(structuredClone(review));
    if (requests.length === 1) return first.promise;
    return { ...job, revision: 3, source: { ...job.source, facts: [baseFact], acceptedFactIds: review.acceptedFactIds } };
  });
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi({ saveSourceFactReview: save }) as never });
  panel.resume({ ...job, source: { ...job.source, facts: [baseFact], acceptedFactIds: [baseFact.id] } } as never);
  const addManual = (subject: string) => {
    const kind = document.querySelector<HTMLSelectElement>("[name='manual.kind']")!; choose(kind, "location", window as unknown as Window);
    for (const [field, value] of [["subject", subject], ["predicate", "stands"], ["value", "nearby"]] as const) {
      const input = document.querySelector<HTMLInputElement>(`[name='manual.${field}']`)!; input.value = value; input.dispatchEvent(new window.Event("input"));
    }
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add manual fact")!.click();
  };

  addManual("First addition");
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  addManual("Newer addition");
  const firstTemporaryId = (requests[0]!.manualFacts as Array<{ id: string }>)[0]!.id;
  const durableFirst = { ...(requests[0]!.manualFacts as Array<Record<string, unknown>>)[0]!, id: "server-manual-first" };
  first.resolve({ ...job, revision: 2, source: { ...job.source, facts: [baseFact, durableFirst], acceptedFactIds: [baseFact.id, durableFirst.id] } } as never);

  await vi.waitFor(() => expect(document.querySelector("[data-source-command-status]")?.textContent).toContain("Newer local decisions"));
  expect(document.querySelector(`[data-source-fact-id='${firstTemporaryId}']`)).toBeNull();
  expect(document.querySelector("[data-source-fact-id='server-manual-first']")).not.toBeNull();
  expect(document.querySelector("[data-source-review-conflict]")).toBeNull();
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(requests[1]!.expectedRevision).toBe(2);
  expect(requests[1]!.manualFacts).toEqual([expect.objectContaining({ subject: "Newer addition" })]);
  expect(requests[1]!.acceptedFactIds).toEqual(expect.arrayContaining(["gate", "server-manual-first"]));
  expect(requests[1]!.acceptedFactIds).not.toContain(firstTemporaryId);
});

it("consumes a stale successful save's durable IDs while preserving the newer polled revision for explicit reconciliation", async () => {
  const { document, window } = parseHTML("<main></main>");
  const baseFact = { id: "gate", kind: "location", subject: "Gate", predicate: "stands", value: "north", provenance: "stated", citations: [] };
  const first = deferred<typeof job>();
  const requests: Array<Record<string, unknown>> = [];
  const save = vi.fn(async (_id: string, review: Record<string, unknown>) => {
    requests.push(structuredClone(review));
    if (requests.length === 1) return first.promise;
    return { ...job, revision: 4, source: { ...job.source, facts: [baseFact], acceptedFactIds: review.acceptedFactIds } };
  });
  let remote = { ...job, revision: 3 } as typeof job;
  const load = vi.fn(async () => remote);
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, {
    api: sourceApi({ saveSourceFactReview: save }) as never,
    authoringJobs: { loadAuthoringJob: load, retryAuthoringStage: vi.fn() }
  });
  panel.resume({ ...job, source: { ...job.source, facts: [baseFact], acceptedFactIds: [baseFact.id] } } as never);
  const addManual = (subject: string) => {
    choose(document.querySelector<HTMLSelectElement>("[name='manual.kind']")!, "location", window as unknown as Window);
    for (const [field, value] of [["subject", subject], ["predicate", "stands"], ["value", "nearby"]] as const) {
      const input = document.querySelector<HTMLInputElement>(`[name='manual.${field}']`)!;
      input.value = value; input.dispatchEvent(new window.Event("input"));
    }
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add manual fact")!.click();
  };

  addManual("First addition");
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  addManual("Newer addition");
  const firstTemporaryId = (requests[0]!.manualFacts as Array<{ id: string }>)[0]!.id;
  const durableFirst = { ...(requests[0]!.manualFacts as Array<Record<string, unknown>>)[0]!, id: "server-manual-first" };
  const revisionTwo = { ...job, revision: 2, source: { ...job.source, facts: [baseFact, durableFirst], acceptedFactIds: [baseFact.id, durableFirst.id] } };
  remote = { ...revisionTwo, revision: 3 } as never;
  panel.resume(remote as never);
  first.resolve(revisionTwo as never);

  await vi.waitFor(() => expect(document.querySelector("[data-source-command-status]")?.textContent).toContain("Newer local decisions"));
  expect(document.querySelector(`[data-source-fact-id='${firstTemporaryId}']`)).toBeNull();
  expect(document.querySelector("[data-source-fact-id='server-manual-first']")).not.toBeNull();
  expect(document.querySelector("[data-source-review-conflict]")).not.toBeNull();
  document.querySelector<HTMLButtonElement>("[data-action='compare-source-review']")!.click();
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  document.querySelector<HTMLButtonElement>("[data-action='reconcile-source-review']")!.click();
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(requests[1]!.expectedRevision).toBe(3);
  expect(requests[1]!.manualFacts).toEqual([expect.objectContaining({ subject: "Newer addition" })]);
  expect(requests[1]!.acceptedFactIds).toEqual(expect.arrayContaining(["gate", "server-manual-first"]));
  expect(requests[1]!.acceptedFactIds).not.toContain(firstTemporaryId);
});

it("retries an uncertain submission with its immutable body and preserves pending edits for an explicit new proposal", async () => {
  const { document, window } = parseHTML("<main></main>");
  const first = deferred<typeof job>();
  const submissions: Array<Record<string, unknown>> = [];
  const submit = vi.fn(async (input: Record<string, unknown>) => {
    submissions.push(structuredClone(input));
    if (submissions.length === 1) return first.promise;
    return { ...job, status: "running", incomplete: true, source: { ...job.source, extractionComplete: false } };
  });
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi({ submitSourceAuthoring: submit }) as never });
  const editor = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  editor.value = "Original one.\n\nOriginal two."; editor.dispatchEvent(new window.Event("input"));
  document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!.click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const edited = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  edited.value = "Edited first.\n\nEdited second."; edited.dispatchEvent(new window.Event("input"));
  choose(document.querySelector<HTMLSelectElement>("[data-source-boundary]")!, "paragraph:0", window as unknown as Window);
  first.reject(new TypeError("lost response"));
  await vi.waitFor(() => expect(document.querySelector("[data-source-intake-status]")?.textContent).toContain("could not be submitted"));

  document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!.click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submissions[1]).toEqual(submissions[0]);
  await vi.waitFor(() => expect(document.querySelector("[data-action='new-source-submission']")).not.toBeNull());
  document.querySelector<HTMLButtonElement>("[data-action='new-source-submission']")!.click();
  expect(document.querySelector<HTMLTextAreaElement>("[data-source-text]")!.value).toBe("Edited first.\n\nEdited second.");
  expect(document.querySelector<HTMLSelectElement>("[data-source-boundary]")!.value).toBe("paragraph:0");
  document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!.click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
  expect(submissions[2]).toMatchObject({ text: "Edited first.\n\nEdited second.", boundaryParagraphId: "paragraph:0" });
  expect(submissions[2]!.idempotencyKey).not.toBe(submissions[0]!.idempotencyKey);
});

it.each([["cleared", ""], ["invalid", "broken\0draft"]])("keeps a frozen request retry accessible when newer intake is %s", async (_label, newerText) => {
  const { document, window } = parseHTML("<main></main>");
  const first = deferred<typeof job>();
  const submissions: Array<Record<string, unknown>> = [];
  const submit = vi.fn(async (input: Record<string, unknown>) => {
    submissions.push(structuredClone(input));
    if (submissions.length === 1) return first.promise;
    return { ...job, status: "running", incomplete: true, source: { ...job.source, extractionComplete: false } };
  });
  mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi({ submitSourceAuthoring: submit }) as never });
  const editor = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  editor.value = "Original source."; editor.dispatchEvent(new window.Event("input"));
  document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!.click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const pendingEditor = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  pendingEditor.value = newerText; pendingEditor.dispatchEvent(new window.Event("input"));
  first.reject(new TypeError("lost response"));
  await vi.waitFor(() => expect(document.querySelector("[data-source-intake-status]")?.textContent).toContain("could not be submitted"));
  const retry = document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!;
  expect(retry?.textContent).toBe("Retry original source submission");
  expect(retry?.disabled).toBe(false);
  retry.click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submissions[1]).toEqual(submissions[0]);
});

it("resumes a persisted fact review without requiring a redundant save before synthesis", async () => {
  const { document } = parseHTML("<main></main>");
  const fact = { id: "gate", kind: "location", subject: "Gate", predicate: "stands", value: "north", provenance: "stated", citations: [] };
  const beginSourceSynthesis = vi.fn().mockResolvedValue({ ...job, status: "queued", revision: 2 });
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi({ beginSourceSynthesis }) as never });
  panel.resume({ ...job, source: { ...job.source, facts: [fact], acceptedFactIds: [fact.id] } } as never);

  const synthesis = document.querySelector<HTMLButtonElement>("[data-action='generate-source-world']")!;
  expect(synthesis.disabled).toBe(false);
  synthesis.click();
  await vi.waitFor(() => expect(beginSourceSynthesis).toHaveBeenCalledWith("source-job", 1, expect.any(AbortSignal)));
});

it("moves one character fact between reversible identity groups without deleting its current group", () => {
  const { document, window } = parseHTML("<main></main>");
  const facts = ["watch", "repair", "sail"].map((predicate, index) => ({ id: `iris-${index}`, kind: "character", subject: "Iris", predicate, value: `detail-${index}`, provenance: "stated", citations: [] }));
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi() as never });
  panel.resume({ ...job, source: { ...job.source, facts, acceptedFactIds: facts.map((fact) => fact.id), characterIdentityGroups: facts.map((fact) => ({ representativeFactId: fact.id, factIds: [fact.id] })) } } as never);

  const repairJoin = document.querySelector<HTMLSelectElement>("[data-identity-join='iris-1']")!;
  choose(repairJoin, "iris-0", window as unknown as Window);
  expect(document.querySelectorAll("[data-roster-representative]")).toHaveLength(2);

  const alreadyJoined = document.querySelector<HTMLSelectElement>("[data-identity-join='iris-1']")!;
  alreadyJoined.dispatchEvent(new window.Event("change"));
  expect(document.querySelectorAll("[data-roster-representative]")).toHaveLength(2);

  const separate = document.querySelector<HTMLSelectElement>("[data-identity-join='iris-1']")!;
  choose(separate, "", window as unknown as Window);
  expect(document.querySelectorAll("[data-roster-representative]")).toHaveLength(3);
  expect(document.querySelector("[data-roster-representative='iris-1']")).not.toBeNull();
});

it("keeps a conflicted local review until the author compares and explicitly reconciles its revision", async () => {
  const { document, window } = parseHTML("<main></main>");
  const fact = { id: "mara", kind: "location", subject: "Gate", predicate: "stands", value: "north", provenance: "stated", citations: [] };
  const remote = { ...job, revision: 3, source: { ...job.source, facts: [fact], acceptedFactIds: [fact.id], rejectedFactIds: [] } };
  const save = vi.fn()
    .mockRejectedValueOnce(new SourceAuthoringApiError("authoring_revision_conflict", 409))
    .mockImplementation(async (_id, review) => ({ ...remote, revision: 4, source: { ...remote.source, acceptedFactIds: review.acceptedFactIds, rejectedFactIds: review.rejectedFactIds } }));
  const load = vi.fn().mockResolvedValue(remote);
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, {
    api: sourceApi({ saveSourceFactReview: save }) as never,
    authoringJobs: { loadAuthoringJob: load, retryAuthoringStage: vi.fn() }
  });
  panel.resume({ ...job, source: { ...job.source, facts: [fact], acceptedFactIds: [fact.id] } } as never);
  const disposition = document.querySelector<HTMLSelectElement>("[data-fact-disposition='mara']")!;
  choose(disposition, "rejected", window as unknown as Window);
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-source-review-conflict]")).not.toBeNull());
  expect(document.querySelector<HTMLSelectElement>("[data-fact-disposition='mara']")!.value).toBe("rejected");

  document.querySelector<HTMLButtonElement>("[data-action='compare-source-review']")!.click();
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  expect(document.querySelector("[data-source-review-comparison]")?.textContent).toContain("Server revision 3");
  expect(document.querySelector("[data-source-review-comparison]")?.textContent).toContain("Your review uses revision 1");
  document.querySelector<HTMLButtonElement>("[data-action='reconcile-source-review']")!.click();
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 3, acceptedFactIds: [], rejectedFactIds: [fact.id] });
});

it("renders equal-count decision, manual, identity, roster, and evidence differences before reconciliation", async () => {
  const { document, window } = parseHTML("<main></main>");
  const citation = { sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 11, quote: "Mara waits." };
  const facts = [
    { id: "north", kind: "location", subject: "North gate", predicate: "is", value: "open", provenance: "stated", citations: [citation] },
    { id: "south", kind: "location", subject: "South gate", predicate: "is", value: "closed", provenance: "stated", citations: [citation] },
    { id: "east", kind: "location", subject: "East gate", predicate: "is", value: "barred", provenance: "manual", citations: [] },
    { id: "mara-role", kind: "character", subject: "Mara", predicate: "is", value: "keeper", provenance: "stated", citations: [citation] },
    { id: "mara-detail", kind: "character", subject: "Mara", predicate: "waits", value: "at the gate", provenance: "stated", citations: [citation] }
  ];
  const remote = { ...job, revision: 3, source: { ...job.source, facts, acceptedFactIds: ["north", "east", "mara-role", "mara-detail"], rejectedFactIds: ["south"], characterIdentityGroups: [{ representativeFactId: "mara-role", factIds: ["mara-role"] }, { representativeFactId: "mara-detail", factIds: ["mara-detail"] }], selectedCharacterFactIds: ["mara-role"] } };
  const save = vi.fn().mockRejectedValue(new SourceAuthoringApiError("authoring_revision_conflict", 409));
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi({ saveSourceFactReview: save }) as never, authoringJobs: { loadAuthoringJob: vi.fn().mockResolvedValue(remote), retryAuthoringStage: vi.fn() } });
  panel.resume({ ...job, source: { ...remote.source } } as never);
  choose(document.querySelector<HTMLSelectElement>("[data-fact-disposition='north']")!, "rejected", window as unknown as Window);
  choose(document.querySelector<HTMLSelectElement>("[data-fact-disposition='south']")!, "accepted", window as unknown as Window);
  choose(document.querySelector<HTMLSelectElement>("[data-fact-disposition='east']")!, "rejected", window as unknown as Window);
  choose(document.querySelector<HTMLSelectElement>("[data-identity-join='mara-detail']")!, "mara-role", window as unknown as Window);
  choose(document.querySelector<HTMLSelectElement>("[data-identity-representative='mara-role']")!, "mara-detail", window as unknown as Window);
  const manualSubject = document.querySelector<HTMLInputElement>("[name='manual.subject']")!; manualSubject.value = "West gate"; manualSubject.dispatchEvent(new window.Event("input"));
  for (const [field, value] of [["predicate", "is"], ["value", "locked"]] as const) { const input = document.querySelector<HTMLInputElement>(`[name='manual.${field}']`)!; input.value = value; input.dispatchEvent(new window.Event("input")); }
  choose(document.querySelector<HTMLSelectElement>("[name='manual.kind']")!, "location", window as unknown as Window);
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add manual fact")!.click();
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-source-review-conflict]")).not.toBeNull());
  expect(save.mock.calls[0]?.[1].acceptedFactIds).toHaveLength(remote.source.acceptedFactIds.length);
  document.querySelector<HTMLButtonElement>("[data-action='compare-source-review']")!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-source-review-comparison]")).not.toBeNull());
  const comparison = document.querySelector<HTMLElement>("[data-source-review-comparison]")!;
  expect(comparison.textContent).toContain("North gate — is: open · Local: rejected · Server: accepted");
  expect(comparison.textContent).toContain("South gate — is: closed · Local: accepted · Server: rejected");
  expect(comparison.textContent).toContain("Local manual additions: West gate — is: locked");
  expect(comparison.textContent).toContain("East gate — is: barred · Local: rejected · Server: accepted");
  expect(comparison.textContent).toContain("Server manual facts: East gate — is: barred");
  expect(comparison.textContent).toContain("Local representative Mara — waits: at the gate");
  expect(comparison.textContent).toContain("Server representative Mara — is: keeper");
  expect(comparison.textContent).toContain("Local roster: Mara — waits: at the gate");
  expect(comparison.textContent).toContain("Server roster: Mara — is: keeper");
  expect(comparison.querySelector("button")?.textContent).toContain("Show paragraph:0");
  expect(comparison.querySelector("[data-action='reconcile-source-review']")).not.toBeNull();
  expect(comparison.querySelector("[data-action='reload-source-review']")).not.toBeNull();
});

it("does not offer revision reconciliation for a non-revision 409", async () => {
  const { document, window } = parseHTML("<main></main>");
  const fact = { id: "gate", kind: "location", subject: "Gate", predicate: "stands", value: "north", provenance: "stated", citations: [] };
  const save = vi.fn().mockRejectedValue(new SourceAuthoringApiError("authoring_invalid_state", 409));
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi({ saveSourceFactReview: save }) as never });
  panel.resume({ ...job, source: { ...job.source, facts: [fact], acceptedFactIds: [fact.id] } } as never);
  choose(document.querySelector<HTMLSelectElement>("[data-fact-disposition='gate']")!, "rejected", window as unknown as Window);
  document.querySelector<HTMLButtonElement>("[data-action='save-source-review']")!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-source-command-status]")?.textContent).toContain("cannot accept"));
  expect(document.querySelector("[data-source-review-conflict]")).toBeNull();
});

it("shows only failed stages from the current generation and catches retry failures", async () => {
  const { document } = parseHTML("<main></main>");
  const retry = vi.fn().mockRejectedValue(new AuthoringJobsApiError("unavailable", 503));
  const panel = mountSourceAuthoringPanel(document.querySelector("main")!, { api: sourceApi() as never, authoringJobs: { loadAuthoringJob: vi.fn(), retryAuthoringStage: retry } });
  panel.resume({ ...job, status: "recoverable", stages: [
    { id: "old", key: "source:synthesis", generation: 1, status: "failed", attemptCount: 1 },
    { id: "new", key: "source:synthesis", generation: 2, status: "validated", attemptCount: 1 },
    { id: "current-failure", key: "source:chunk:1", generation: 1, status: "recoverable", attemptCount: 1 }
  ] } as never);
  expect(document.querySelector("main")!.textContent).not.toContain("Retry source:synthesis");
  document.querySelector<HTMLButtonElement>("[data-retry-stage-id='current-failure']")!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-source-command-status]")?.textContent).toContain("unavailable"));
  expect(retry).toHaveBeenCalledOnce();
});

it("aborts intake work and ignores a stale submit response after disposal", async () => {
  const { document, window } = parseHTML("<main></main>");
  const pending = deferred<typeof job>();
  let submittedSignal: AbortSignal | undefined;
  const api = sourceApi({ submitSourceAuthoring: vi.fn((_input, signal) => { submittedSignal = signal; return pending.promise; }) });
  const onJobAvailable = vi.fn();
  const host = document.querySelector<HTMLElement>("main")!;
  const panel = mountSourceAuthoringPanel(host, { api: api as never, onJobAvailable } as never);
  const editor = document.querySelector<HTMLTextAreaElement>("[data-source-text]")!;
  editor.value = "Mara waits.";
  editor.dispatchEvent(new window.Event("input"));
  document.querySelector<HTMLButtonElement>("[data-action='submit-source']")!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(submittedSignal).toBeInstanceOf(AbortSignal);
  const before = host.textContent;
  panel.dispose();
  expect(submittedSignal?.aborted).toBe(true);
  pending.resolve(job);
  await Promise.resolve();
  expect(onJobAvailable).not.toHaveBeenCalled();
  expect(host.textContent).toBe(before);
});
