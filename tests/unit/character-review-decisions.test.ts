import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { renderCastReview } from "../../apps/web/src/cast-review-queue.js";
import type { CampaignCastApi } from "../../packages/client-web/src/campaign-cast-api.js";

it("keeps a draft for another source while saving a decision in the same group", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const boundary = { turnNumber: 2, timelineRevision: 0 };
  const items = ["pier", "gate"].map((value, index) => ({
    id: value, resolvedCharacterId: "guide", proposal: { name: "Guide" },
    source: { turnNumber: index + 1, turnId: value, narrationRevision: 0 },
    details: [{ field: "state.location", value, observationIndex: 0, reason: "unsupported_subject", quote: value, sourceHash: value, canAcceptObservation: true }]
  }));
  const person = { id: "guide", name: "Guide", revision: 0, profile: {} };
  const api = { candidates: async () => ({ revision: 0, boundary, candidates: items.slice(), nextCursor: null }),
    list: async () => ({ revision: 0, boundary, characters: [person], nextCursor: null }),
    detail: async () => ({ character: person }),
    resolveDetail: async () => { items.shift(); } };
  renderCastReview({ document, container: document.body, api: api as unknown as CampaignCastApi, campaign: "campaign",
    current: () => true, editing: () => true, navigate() {}, back() {}, key: () => "test", clearKeys() {} });
  await vi.waitFor(() => expect(document.querySelectorAll("textarea")).toHaveLength(2));
  expect(document.body.textContent).toContain("Later observations can update this field");
  const draft = document.querySelectorAll("textarea")[1]!;
  draft.value = "Harbor office"; draft.dispatchEvent(new document.defaultView!.Event("input"));
  [...document.querySelectorAll("button")].find(button => button.textContent === "Apply and next")!.click();
  await vi.waitFor(() => expect(document.querySelectorAll("textarea")).toHaveLength(1));
  expect(document.querySelector("textarea")!.value).toBe("Harbor office");
});


it("offers only the actions permitted for each candidate detail", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const candidate = { id: "one", resolvedCharacterId: "guide", proposal: { name: "Guide" }, source: { turnNumber: 1 },
    details: [{ field: "story.role", value: "captain", observationIndex: 0, reason: "claim", quote: "captain", sourceHash: "hash", canAcceptObservation: true, allowedActions: ["dismiss"] }] };
  const api = { candidates: async () => ({ revision: 0, boundary, candidates: [candidate], nextCursor: null }),
    list: async () => ({ revision: 0, boundary, characters: [{ id: "guide", name: "Guide", revision: 0, profile: {} }], nextCursor: null }) };
  renderCastReview({ document, container: document.body, api: api as unknown as CampaignCastApi, campaign: "campaign", current: () => true, editing: () => true, navigate() {}, back() {}, key: () => "test", clearKeys() {} });
  await vi.waitFor(() => expect(document.body.textContent).toContain("Dismiss detail"));
  expect(document.body.textContent).not.toContain("Keep as override");
  expect(document.body.textContent).not.toContain("Apply and next");
});


it("opens the selected candidate instead of the first pending item", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const candidates = ["Ada", "Bea"].map(name => ({ id: name, resolvedCharacterId: name, proposal: { name }, source: { turnNumber: 1 }, details: [{ field: "story.role", value: name, observationIndex: 0, quote: name, sourceHash: name }] }));
  const api = { candidates: async () => ({ revision: 0, boundary, candidates, nextCursor: null }), list: async () => ({ revision: 0, boundary, characters: [], nextCursor: null }) };
  renderCastReview({ document, container: document.body, api: api as unknown as CampaignCastApi, campaign: "campaign", current: () => true, editing: () => true, navigate() {}, back() {}, key: () => "test", clearKeys() {}, initialItem: "detail:Bea:story.role" });
  await vi.waitFor(() => expect(document.body.textContent).toContain("Bea · Role"));
});


it("puts the selected candidate first when several sources share a field", async () => {
  const { document } = parseHTML("<html><body></body></html>");
  const boundary = { turnNumber: 2, timelineRevision: 0 };
  const candidates = ["one", "two"].map((id, index) => ({ id, resolvedCharacterId: "guide", proposal: { name: "Guide" }, source: { turnNumber: index + 1 }, details: [{ field: "story.role", value: id, observationIndex: 0, quote: id, sourceHash: id }] }));
  const api = { candidates: async () => ({ revision: 0, boundary, candidates, nextCursor: null }), list: async () => ({ revision: 0, boundary, characters: [{ id: "guide", name: "Guide", profile: {} }], nextCursor: null }) };
  renderCastReview({ document, container: document.body, api: api as unknown as CampaignCastApi, campaign: "campaign", current: () => true, editing: () => true, navigate() {}, back() {}, key: () => "test", clearKeys() {}, initialItem: "detail:guide:story.role:two" });
  await vi.waitFor(() => expect(document.querySelectorAll("textarea")).toHaveLength(2));
  expect(document.querySelectorAll("textarea")[0]!.value).toBe("two");
});
