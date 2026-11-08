import { castDetailSchema, characterProfileSchema } from "../../packages/contracts/src/index.js";
import { buildPresetRequest, changePresetField, createPresetDraft, presetField } from "../../packages/client-core/src/characters/preset-editor.js";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mainProfileSourceLabel, createLegacyCastPanel } from "../../apps/web/src/campaign-cast-panel.js";

describe("legacy cast panel", () => {
  it("projects each seeded field badge and builds one edit from reset, clear and restore actions", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const world = characterProfileSchema.parse({ story: { role: "Ferryman", goals: "Find the boat" }, appearance: { eyes: "Green" } });
    const campaign = characterProfileSchema.parse({ ...world, story: { ...world.story, role: "Guide", background: "From the coast" } });
    const detail = castDetailSchema.parse({ revision: 4, boundary: { turnNumber: 2, timelineRevision: 0 },
      character: { id, name: "Marin", aliases: ["Captain"], origin: { kind: "world", entityId: "marin", worldVersionId: id },
        originProfile: { seedEventId: id, worldVersionId: id, entityId: "marin", rosterName: "Marin", rosterAliases: [], legacyCharacterText: "", profile: world,
          evidence: { kind: "world", worldVersionId: id, sourcePath: "/playableCharacters/0" } },
        campaignProfile: campaign, profile: { "story.role": "Guide", "story.goals": "Make port", "story.personality": "Patient" },
        fieldSources: { "appearance.eyes": "authored", "story.role": "campaign_edit", "story.background": "campaign_edit", "story.personality": "observation", "story.goals": "override" },
        revision: 3, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 2 },
      observations: [], identityEvents: [], overrides: [], unresolvedCandidateIds: [], editorDestination: null });
    detail.observations = ["Tinker", "Sailor"].map(value => ({ id: crypto.randomUUID(), characterId: id, field: "story.motivations", value,
      mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "world", worldVersionId: id, sourcePath: "/characters/0" } }));
    expect(Object.fromEntries(["appearance.eyes", "story.role", "story.background", "story.personality", "state.location", "story.goals", "appearance.description", "story.motivations"]
      .map(path => [path, presetField(detail, path).badge]))).toEqual({
      "appearance.eyes": "World canon", "story.role": "Edited for this campaign", "story.background": "Added for this campaign",
      "story.personality": "From story", "state.location": "Updates with story", "story.goals": "Your edit",
      "appearance.description": "Observed in story", "story.motivations": "Needs attention"
    });
    const state = createPresetDraft(detail);
    changePresetField(state, "identity.aliases", [], "reset");
    changePresetField(state, "story.role", "Ferryman", "reset");
    changePresetField(state, "story.goals", "Find the boat", "restore");
    changePresetField(state, "appearance.description", "", "hide");
    expect(buildPresetRequest(state, id)).toEqual({ expectedCastRevision: 4, expectedCharacterRevision: 3, expectedBoundary: detail.boundary,
      idempotencyKey: id, resetIdentity: true, reset: ["story.role"], restoreAuthoredGoals: true, setOverrides: { "appearance.description": "" } });
  });
  it("labels main profile provenance from the profile read, with an unknown fallback", () => {
    expect(mainProfileSourceLabel({ inheritedFromSnapshot: true, storedProfile: null })).toBe("World snapshot");
    expect(mainProfileSourceLabel({ inheritedFromSnapshot: false, storedProfile: {} })).toBe("Campaign profile");
    expect(mainProfileSourceLabel(null)).toBe("Source unavailable");
  });
  it("renders hostile names as text and keeps a failed edit draft", async () => {
    const { document, window } = parseHTML("<html><body><button id='entry'>Characters</button></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "<img src=x onerror=alert(1)>", aliases: [],
      origin: { kind: "manual" as const }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const authority = { revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, capabilities: { castEditing: true } };
    let saveFails = true;
    const api = { contextPreview: async () => { throw new Error("not used"); }, resolveDetail: async () => { throw new Error("not used"); }, detachAttachment: async () => { throw new Error("not used"); }, workspaceStatus: async () => { throw new Error("not used"); }, retryDiscovery: async () => { throw new Error("not used"); }, candidates: async () => ({ revision: 1, boundary: authority.boundary, candidates: [], nextCursor: null }),
      resolveCandidate: async () => { throw new Error("not used"); },
      discoveryStatus: async () => ({ enabled: true, state: "catching_up" as const, activeTurnNumber: 3,
      coverageStartTurn: 2, trackedThroughTurn: 2, unresolvedCount: 1,
      firstGap: { turnNumber: 3, jobId: null, status: "missing" as const, diagnosticCode: null } }),
      list: async (_campaign?: string, query?: { cursor?: string }) => ({ ...authority,
        characters: query?.cursor ? [{ ...person, id: "22222222-2222-4222-8222-222222222222", name: "Mara" }] : [person], nextCursor: query?.cursor ? null : "page-two" }),
      detail: async () => ({ ...authority, character: person, observations: [], overrides: [{ field: "story.role" as const, value: "guard", evidence: { kind: "user" as const, editId: "33333333-3333-4333-8333-333333333333", effectiveTurnNumber: 0 } }], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null }),
      create: async () => { throw new Error("offline"); }, edit: async () => { if (saveFails) throw new Error("offline"); return { ...authority, character: person, eventId: "33333333-3333-4333-8333-333333333333" }; } };
    let generationActive = true;
    const panel = createLegacyCastPanel({ api, campaignId: () => "campaign", generationActive: () => generationActive,
      openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!;
    dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open();
    expect([...dialog.querySelectorAll("button")].filter(button => button.textContent === "Needs attention")).toHaveLength(1);
    expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Review conflicts")).toBe(false);
    expect(dialog.textContent).toContain("Character tracking is catching up");
    expect(dialog.textContent).toContain("Tracked turns 2–2");
    expect(dialog.textContent).toContain("1 character match needs review");
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain("Finish or resolve the current generation");
    expect([...dialog.querySelectorAll("button")].some((button) => button.textContent === "Add character")).toBe(false);
    generationActive = false;
    const row = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("<img"))!;
    row.click(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.textContent).not.toContain("Pronouns: Unknown");
    expect(dialog.textContent).toContain("Your override: Role");
    expect(dialog.textContent).not.toContain("Your override: story.role");
    expect(dialog.querySelector('[aria-current="true"]')?.textContent).toContain("<img");
    const toggle = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Show empty fields")!;
    toggle.click();
    expect(dialog.textContent).toContain("Pronouns: Unknown");
    [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Edit character")!.click();
    expect([...dialog.querySelectorAll("summary")].map(item => item.textContent)).toContain("Personality and voice");
    const reset = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Use discovered value for role")!;
    reset.click();
    expect(dialog.querySelector("#cast-story-role")?.parentElement?.querySelector('[role="status"]')?.textContent).toContain("discovered value");
    const name = dialog.querySelector<HTMLInputElement>("#cast-name")!;
    name.value = "Mara"; name.dispatchEvent(new window.Event("input"));
    await vi.waitFor(() => expect(dialog.textContent).toContain("already exists"));
    expect(dialog.querySelector<HTMLButtonElement>("#cast-save")!.disabled).toBe(false);
    dialog.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.querySelector<HTMLInputElement>("#cast-name")!.value).toBe("Mara");
    expect(dialog.textContent).toContain("offline");
    expect(dialog.querySelector('[role="alert"]')?.getAttribute("tabindex")).toBe("-1");
    panel.requestClose(); expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.textContent).toContain("Save changes");
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Keep editing")!.click();
    expect(dialog.querySelector<HTMLInputElement>("#cast-name")!.value).toBe("Mara");
    saveFails = false;
    dialog.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Edit character")).toBe(true));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit character")!.click();
    const secondName = dialog.querySelector<HTMLInputElement>("#cast-name")!;
    secondName.value = "Aria"; secondName.dispatchEvent(new window.Event("input"));
    panel.requestClose();
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save changes")!.click();
    await vi.waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
    await panel.open();
    [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("<img"))!.click();
    await vi.waitFor(() => expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Edit character")).toBe(true));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit character")!.click();
    const discardedName = dialog.querySelector<HTMLInputElement>("#cast-name")!;
    discardedName.value = "Discarded"; discardedName.dispatchEvent(new window.Event("input"));
    dialog.dispatchEvent(new window.Event("cancel", { cancelable: true }));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Discard changes")!.click();
    expect(dialog.hasAttribute("open")).toBe(false);
    vi.unstubAllGlobals();
  });
  it("refreshes the main sheet after a successful profile edit", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const authority = { revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, capabilities: { castEditing: true } };
    let name = "Iven"; let finish: ((saved: boolean) => void) | undefined;
    const api = { list: async () => ({ ...authority, characters: [person], nextCursor: null }), detail: async () => ({ ...authority, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [] }), discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("offline"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false,
      getProfile: async () => ({ name, profile: { identity: {}, story: {}, appearance: {} }, revision: 1 } as never),
      openProtagonist: callback => { finish = callback; }, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; Object.defineProperty(dialog, "open", { get: () => dialog.hasAttribute("open") }); dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Iven")!.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain("Edit main character"));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit main character")!.click();
    name = "Updated Iven"; finish!(true);
    await vi.waitFor(() => expect(dialog.querySelector("#cast-title")?.textContent).toBe("Updated Iven"));
    vi.unstubAllGlobals();
  });

});
