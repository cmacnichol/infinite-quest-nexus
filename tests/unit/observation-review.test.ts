import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { renderObservationReview } from "../../apps/web/src/character-editor/observation-review.js";

it("previews before retracting and cancellation makes no write", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const observation = { id: "one", mode: "fact", field: "story.role", value: "<captain>", evidence: { kind: "turn", turnNumber: 1, quote: "<safe>" } };
  const detail = { character: { id: "person", revision: 2 }, revision: 3, boundary: { turnNumber: 1, timelineRevision: 0 }, observations: [observation], observationDecisionStatus: [{ observationId: "one", state: "eligible", retractionEventId: null, reason: null }] };
  const preview = vi.fn(async () => ({ currentValue: "captain", projectedValue: null, currentConflict: false, projectedConflict: true, field: "story.role", source: observation, castRevision: 3, characterRevision: 2, boundary: detail.boundary } as never));
  const apply = vi.fn();
  renderObservationReview({ document, container: document.body, detail: detail as never, supported: true, editing: () => true, current: () => true, preview, apply, refresh: async () => {}, navigate() {} });
  expect(document.querySelector("captain")).toBeNull();
  expect(document.body.textContent).toContain("Observation: Role \u2014 <captain>");
  [...document.querySelectorAll("button")].find(b => b.textContent === "Retract fact")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Conflicting observations"));
  [...document.querySelectorAll("button")].find(b => b.textContent === "Cancel")!.click();
  expect(apply).not.toHaveBeenCalled();
});

it("retries the same receipt and disables a stale confirmation", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const observation = { id: "one", mode: "fact", field: "story.role", value: "captain", evidence: { kind: "turn", turnNumber: 1, quote: "captain" } };
  const detail = { character: { id: "person", revision: 2 }, revision: 3, boundary: { turnNumber: 1, timelineRevision: 0 }, observations: [observation], observationDecisionStatus: [{ observationId: "one", state: "eligible", retractionEventId: null, reason: null }] };
  const preview = vi.fn(async () => ({ currentValue: "captain", projectedValue: "captain", currentConflict: false, projectedConflict: false } as never));
  const apply = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockRejectedValueOnce({ statusCode: 409 });
  renderObservationReview({ document, container: document.body, detail: detail as never, supported: true, editing: () => true, current: () => true, preview, apply, refresh: async () => {}, navigate() {} });
  [...document.querySelectorAll("button")].find(b => b.textContent === "Retract fact")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("displayed value will remain unchanged"));
  const confirm = [...document.querySelectorAll("button")].find(b => b.textContent === "Confirm retraction")!;
  confirm.click(); await vi.waitFor(() => expect(document.body.textContent).toContain("Retry"));
  confirm.click(); await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh before"));
  expect(apply.mock.calls[0]![1]).toEqual(apply.mock.calls[1]![1]); expect(confirm.disabled).toBe(true);
});

it("retains invalidated retraction history without offering restore", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const observation = { id: "one", mode: "fact", field: "story.role", value: "captain", evidence: { kind: "turn", turnNumber: 1, quote: "captain", invalidated: true } };
  const detail = { observations: [], retractedObservationHistory: [observation], observationDecisionStatus: [{ observationId: "one", state: "read_only", retractionEventId: "event", reason: "source_invalid" }] };
  renderObservationReview({ document, container: document.body, detail: detail as never, supported: true, editing: () => true, current: () => true, preview: vi.fn(), apply: vi.fn(), refresh: async () => {}, navigate() {} });
  expect(document.body.textContent).toContain("no longer eligible for restoration");
  expect(document.body.textContent).not.toContain("Restore fact");
});

it("rejects a stale preview without offering a write", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const detail = { character: { revision: 2 }, revision: 3, boundary: { turnNumber: 1, timelineRevision: 0 }, observations: [{ id: "one", mode: "fact", field: "story.role", value: "captain", evidence: { kind: "turn", turnNumber: 1, quote: "captain" } }], observationDecisionStatus: [{ observationId: "one", state: "eligible", retractionEventId: null, reason: null }] };
  const apply = vi.fn();
  renderObservationReview({ document, container: document.body, detail: detail as never, supported: true, editing: () => true, current: () => true, preview: vi.fn().mockRejectedValue({ statusCode: 409 }), apply, refresh: async () => {}, navigate() {} });
  [...document.querySelectorAll("button")].find(b => b.textContent === "Retract fact")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh before trying again"));
  expect(document.body.textContent).not.toContain("Confirm retraction"); expect(apply).not.toHaveBeenCalled();
});
