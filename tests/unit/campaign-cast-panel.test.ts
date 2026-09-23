import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { createLegacyCastPanel } from "../../apps/web/src/campaign-cast-panel.js";

describe("legacy cast panel", () => {
  it("renders hostile names as text and keeps a failed edit draft", async () => {
    const { document, window } = parseHTML("<html><body><button id='entry'>Characters</button></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "<img src=x onerror=alert(1)>", aliases: [],
      origin: { kind: "manual" as const }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0 };
    const authority = { revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, capabilities: { castEditing: true } };
    const api = { retryDiscovery: async () => { throw new Error("not used"); }, candidates: async () => ({ revision: 1, boundary: authority.boundary, candidates: [], nextCursor: null }),
      resolveCandidate: async () => { throw new Error("not used"); },
      discoveryStatus: async () => ({ enabled: true, state: "catching_up" as const, activeTurnNumber: 3,
      coverageStartTurn: 2, trackedThroughTurn: 2, unresolvedCount: 1,
      firstGap: { turnNumber: 3, jobId: null, status: "missing" as const, diagnosticCode: null } }),
      list: async () => ({ ...authority, characters: [person], nextCursor: null }),
      detail: async () => ({ ...authority, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null }),
      create: async () => { throw new Error("offline"); }, edit: async () => { throw new Error("offline"); } };
    let generationActive = true;
    const panel = createLegacyCastPanel({ api, campaignId: () => "campaign", generationActive: () => generationActive,
      openProtagonist: () => {}, navigateToTurn: async () => {}, confirmDiscard: () => false });
    const dialog = document.querySelector("dialog")!;
    dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open();
    expect(dialog.textContent).toContain("Character tracking is catching up");
    expect(dialog.textContent).toContain("Tracked turns 2–2");
    expect(dialog.textContent).toContain("1 character match needs review");
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain("Finish or resolve the current generation");
    expect([...dialog.querySelectorAll("button")].some((button) => button.textContent === "Add character")).toBe(false);
    generationActive = false;
    const row = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("<img"))!;
    row.click(); await new Promise((resolve) => setTimeout(resolve, 0));
    const name = dialog.querySelector<HTMLInputElement>("#cast-name")!;
    name.value = "Mara"; name.dispatchEvent(new window.Event("input"));
    dialog.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.querySelector<HTMLInputElement>("#cast-name")!.value).toBe("Mara");
    expect(dialog.textContent).toContain("offline");
    panel.requestClose(); expect(dialog.hasAttribute("open")).toBe(true);
    vi.unstubAllGlobals();
  });
});
