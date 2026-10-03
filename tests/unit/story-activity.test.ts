import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { emptyActivitySnapshot, type ActivityViewState } from "../../packages/client-core/src/index.js";
import { ACTIVITY_DIAGNOSTIC_MESSAGES, type ActivityEvent } from "../../packages/contracts/src/index.js";
import { createStoryActivityView, safeActivityDiagnostic } from "../../apps/web/src/story-activity.js";
const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
function event(sequence = "1", overrides = {}): ActivityEvent {
  return { version: 1, eventId: `00000000-0000-4000-8000-${sequence.padStart(12, "0")}`, campaignId, sequence,
    occurredAt: "2026-10-03T12:34:56.000Z", publishedAt: "2026-10-03T12:34:56.000Z",
    source: "generation", kind: "generation.failed", severity: "error", status: "failed", jobId, generationJobId: jobId,
    segmentId: null, turnId: null, turnNumber: 2, attemptNumber: 1,
    diagnostic: { code: "request_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.request_failed!, httpStatus: 503 }, ...overrides } as ActivityEvent;
}
function boot(events = [event()]) {
  const { document } = parseHTML(readFileSync("apps/web/public/story.html", "utf8"));
  const state: ActivityViewState = { scope: { campaignId, ownerUserId: jobId, apiBase: "https://nexus.test/api/v1" }, snapshot: { ...emptyActivitySnapshot(), events, hasOlder: true }, events, observations: [], syncing: false, cached: false, delayed: false, incomplete: false, storageUnavailable: false, unsupported: false, identityRequired: false, activationPending: false, gap: null };
  const controller = { getState: () => state, subscribe: vi.fn(() => () => {}), setDialogOpen: vi.fn(), refresh: vi.fn(), loadOlder: vi.fn(), returnToLatest: vi.fn(), hidePrevious: vi.fn(), showPrevious: vi.fn() };
  const copyText = vi.fn().mockResolvedValue(undefined); const download = vi.fn(); const openRecovery = vi.fn().mockResolvedValue(undefined);
  const view = createStoryActivityView({ controller: controller as never, document: document as unknown as Document, copyText, download, openRecovery });
  const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
  const filter = (value: string) => { const select = document.getElementById("activityLogFilter")!; Object.defineProperty(select, "value", { value, configurable: true }); select.dispatchEvent(new document.defaultView!.Event("change")); };
  const search = (value: string) => { const input = document.getElementById("activityLogSearch") as HTMLInputElement; input.value = value; input.dispatchEvent(new document.defaultView!.Event("input")); };
  return { document, state, controller, copyText, download, view, click, filter, search, openRecovery };
}
describe("persistent legacy Story Activity view", () => {
  it("groups retries, displays local date/time and unavailable facts, preserving keyed expansion and scroll", () => {
    const app = boot([event("2", { kind: "generation.retry_queued", status: "queued", attemptNumber: 2 }), event()]);
    const group = app.document.querySelector("details.activity-log-entry")!;
    group.setAttribute("open", ""); const scroll = group.parentElement!.parentElement!; scroll.scrollTop = 77;
    app.view.render({ ...app.state, cached: true });
    expect(app.document.querySelectorAll("details.activity-log-entry")).toHaveLength(1);
    expect(app.document.querySelector("details.activity-log-entry")).toBe(group);
    expect(group.hasAttribute("open")).toBe(true); expect(scroll.scrollTop).toBe(77);
    expect(group.textContent).toContain("Attempt: 2"); expect(group.textContent).toContain("Attempt: 1");
    expect(group.textContent).toContain("Phase: unavailable");
    expect(group.textContent).toContain(new Date("2026-10-03T12:34:56.000Z").toLocaleString());
  });
  it("filters and searches only loaded safe records, with distinct browser and image records", () => {
    const app = boot([event(), event("2", { source: "image", kind: "image.failed", generationJobId: null, jobId: "33333333-3333-4333-8333-333333333333", status: "failed" })]);
    app.filter("illustrations"); expect(app.document.querySelectorAll("details.activity-log-entry")).toHaveLength(1);
    app.filter("generation"); expect(app.document.querySelector("details.activity-log-entry")!.textContent).toContain("Generation");
    app.search("not-loaded"); expect(app.document.querySelectorAll("details.activity-log-entry")).toHaveLength(0);
    expect(app.document.getElementById("activityLogEmpty")!.textContent).toContain("matches these filters");
    app.search("request_failed"); expect(app.document.querySelectorAll("details.activity-log-entry")).toHaveLength(1);
  });
  it("copy and versioned JSON download share selected groups or filtered loaded entries and exclude canaries", async () => {
    const app = boot([event(), event("2", { jobId: "33333333-3333-4333-8333-333333333333" }), { ...event("3"), raw: "PRIVATE_CANARY" } as unknown as ActivityEvent]);
    const checkbox = app.document.querySelector('input[aria-label="Select operation group"]') as HTMLInputElement;
    checkbox.checked = true; checkbox.dispatchEvent(new app.document.defaultView!.Event("change"));
    app.click("#btnCopyActivityLog"); app.click("#btnDownloadActivityLog"); await Promise.resolve();
    const copied = app.copyText.mock.calls[0]![0]; expect(copied).toBe(app.download.mock.calls[0]![0]);
    const exported = JSON.parse(copied); expect(exported.version).toBe(1); expect(exported.loadedOnly).toBe(true); expect(exported.entries).toHaveLength(1);
    expect(copied).not.toContain("PRIVATE_CANARY"); expect(app.document.body.textContent).not.toContain("PRIVATE_CANARY");
    expect(exported.scope.campaignId).toBe(campaignId);
  });
  it("reports clipboard failure, reversible hide/show, older/latest and current recovery without writing actions", async () => {
    const app = boot(); app.copyText.mockRejectedValueOnce(new Error("SECRET_EXCEPTION"));
    app.click("#btnCopyActivityLog"); await Promise.resolve(); await Promise.resolve();
    expect(app.document.getElementById("activityLogStatus")!.textContent).toContain("Clipboard unavailable");
    expect(app.document.body.textContent).not.toContain("SECRET_EXCEPTION");
    app.click("#btnClearActivityLog"); expect(app.controller.hidePrevious).toHaveBeenCalledOnce();
    app.view.render({ ...app.state, snapshot: { ...app.state.snapshot, hiddenThrough: { server: "1", browser: "0" }, browsingOlder: true } });
    app.click("#btnClearActivityLog"); expect(app.controller.showPrevious).toHaveBeenCalledOnce();
    app.click("#btnActivityOlder"); app.click("#btnActivityLatest"); expect(app.controller.loadOlder).toHaveBeenCalledOnce(); expect(app.controller.returnToLatest).toHaveBeenCalledOnce();
    app.click(".activity-log-details button"); expect(app.openRecovery).toHaveBeenCalledOnce();
  });
  it("explains cold offline activation, cached/delayed/storage/unsupported/gap coverage and revokes rows on scope loss", () => {
    const app = boot();
    app.view.render({ ...app.state, activationPending: true, identityRequired: true, cached: true, delayed: true, storageUnavailable: true, unsupported: true, gap: "restore" });
    expect(app.document.getElementById("activityLogNotices")!.textContent).toContain("Reconnect or refresh");
    expect(app.document.getElementById("activityLogNotices")!.textContent).toContain("Local history storage unavailable");
    app.view.render({ ...app.state, scope: null, events: [], observations: [] }); expect(app.document.querySelectorAll("details.activity-log-entry")).toHaveLength(0);
  });
  it("retains allowlisted domain codes and contract kinds while discarding raw paths", () => {
    expect(safeActivityDiagnostic({ domainCode: "provider_request_timeout", message: "PRIVATE_CANARY" }).code).toBe("provider_request_timeout");
    const result = safeActivityDiagnostic({ name: "ApiContractError", kind: "malformed_json", method: "GET", path: "https://secret.test?token=PRIVATE_CANARY", issues: ["PRIVATE_CANARY"] });
    expect(result.code).toBe("contract_invalid"); expect(result.method).toBe("GET"); expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it("normalizes HTTP facts without messages, payloads, URLs, unsafe correlation or arbitrary domain codes", () => {
    const result = safeActivityDiagnostic({ message: "PRIVATE_CANARY", details: { token: "SECRET" }, cause: "SECRET", correlationId: "https://secret.test", statusCode: 409, domainCode: "unsafe" }, "request_failed", "/api/v1/generation-jobs/:jobId/review");
    expect(result).toEqual({ code: "request_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.request_failed, httpStatus: 409, routeTemplate: "/api/v1/generation-jobs/:jobId/review" });
  });
});
