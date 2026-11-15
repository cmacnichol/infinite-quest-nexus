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
  it.each(["Added Character", "Starting Cast Character"])("conflict link opens that field's choices on the sheet with focus on the first action: %s", async kind => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    let focused: Element | null = null;
    window.HTMLElement.prototype.focus = function () { focused = this; };
    const id = "11111111-1111-4111-8111-111111111111", boundary = { turnNumber: 2, timelineRevision: 0 }, capabilities = { castEditing: true };
    const worldProfile = characterProfileSchema.parse({});
    const originProfile = { seedEventId: id, worldVersionId: id, entityId: "marin", rosterName: "Marin", rosterAliases: [], legacyCharacterText: "", profile: worldProfile, evidence: { kind: "world", worldVersionId: id, sourcePath: "/characters/0" } };
    const person = { id, name: "Marin", aliases: [], origin: kind === "Added Character" ? { kind: "manual" } : { kind: "world", entityId: "marin", worldVersionId: id }, ...(kind === "Starting Cast Character" ? { originProfile, campaignProfile: worldProfile } : {}), profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 2, lastMentionedTurn: null };
    const observations = ["Tinker", "Sailor"].map(value => ({ id: crypto.randomUUID(), characterId: id, field: "story.role", value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "world", worldVersionId: id, sourcePath: "/characters/0" } }));
    const authority = { revision: 1, boundary, capabilities };
    const detail = { ...authority, character: person, observations, overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const api = { editAuthoredProfile: async () => { throw new Error("not used"); }, list: async () => ({ ...authority, characters: [person], nextCursor: null }), detail: async () => detail, candidates: async () => ({ ...authority, candidates: [], nextCursor: null }), discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Needs attention")!.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain("Marin · Role"));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Marin · Role")!.click();
    await vi.waitFor(() => expect(dialog.querySelector('[data-path="story.role"]')?.textContent).toContain("Tinker"));
    const row = dialog.querySelector('[data-path="story.role"]')!;
    expect(row.textContent).toContain("Sailor");
    expect(focused).toBe(row.querySelector(".character-sheet-choice button"));
    panel.requestClose(); vi.unstubAllGlobals();
  });
  it("ignores an older conflict navigation after a newer character opens", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const boundary = { turnNumber: 2, timelineRevision: 0 }, capabilities = { castEditing: true }, authority = { revision: 1, boundary, capabilities };
    const people = ["Marin", "Mara"].map((name, i) => ({ id: i ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111", name, aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 2, lastMentionedTurn: null }));
    const details = people.map(character => ({ ...authority, character, observations: ["story.role", "story.motivations"].flatMap(field => ["First", "Second"].map(value => ({ id: crypto.randomUUID(), characterId: character.id, field, value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "world", worldVersionId: character.id, sourcePath: "/characters/0" } }))), overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null }));
    let defer = false; const pending = new Map<string, (value: typeof details[number]) => void>();
    const api = { list: async () => ({ ...authority, characters: people, nextCursor: null }), detail: async (_campaign: string, id: string) => defer ? await new Promise<typeof details[number]>(resolve => pending.set(id, resolve)) : details.find(item => item.character.id === id)!, candidates: async () => ({ ...authority, candidates: [], nextCursor: null }), discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Needs attention")!.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain("Mara · Motivations"));
    const first = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Marin · Role")!;
    const second = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Mara · Motivations")!;
    defer = true; first.click(); second.click();
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get(people[1]!.id)!(details[1]!);
    await vi.waitFor(() => expect(dialog.querySelector('[data-path="story.motivations"] .character-sheet-choice')).not.toBeNull());
    pending.get(people[0]!.id)!(details[0]!); await new Promise(resolve => setTimeout(resolve, 0));
    expect(dialog.querySelector("#cast-title")?.textContent).toBe("Mara");
    expect(dialog.querySelector('[data-path="story.motivations"] .character-sheet-choice')).not.toBeNull();
    expect(dialog.querySelector('[data-path="story.role"] .character-sheet-choice')).toBeNull();
    panel.requestClose(); vi.unstubAllGlobals();
  });
  it("offers an inline edit on an Added Character sheet", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Marin", aliases: [], origin: { kind: "manual" as const }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const authority = { revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, capabilities: { castEditing: true } };
    const detail = { ...authority, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const api = { list: async () => ({ ...authority, characters: [person], nextCursor: null }), detail: async () => detail, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open();
    [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Edit Name")).toBe(true);
    panel.requestClose();
  });
  it("retains a receipt-fenced Undo after saving an Added Character field", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Marin", aliases: [], origin: { kind: "manual" as const }, profile: { "story.role": "Guard" }, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    let detail = { revision: 1, boundary, capabilities, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const edit = vi.fn(async (_campaign, _id, body) => { detail = { ...detail, revision: detail.revision + 1, character: { ...detail.character, revision: detail.character.revision + 1, profile: { "story.role": body.setOverrides?.["story.role"] ?? "Guard" } } }; return { revision: detail.revision, boundary, character: detail.character }; });
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: async () => detail, edit, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Role")!.click();
    const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Captain"; input.dispatchEvent(new window.Event("input"));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click(); await vi.waitFor(() => expect(dialog.textContent).toContain("Saved Role."));
    expect(edit.mock.calls[0]![2]).toEqual({ expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: expect.any(String), setOverrides: { "story.role": "Captain" } });
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Undo")!.click(); await vi.waitFor(() => expect(dialog.textContent).toContain("Undone"));
    expect(edit.mock.calls[1]![2]).toEqual({ expectedCastRevision: 2, expectedCharacterRevision: 2, expectedBoundary: boundary, idempotencyKey: expect.any(String), clearOverrides: ["story.role"] });
    panel.requestClose();
  });
  it("does not restore or execute expired Undo when a Retraction preview rerenders the sheet", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const id = "11111111-1111-4111-8111-111111111111", observationId = "22222222-2222-4222-8222-222222222222", boundary = { turnNumber: 1, timelineRevision: 0 }, capabilities = { castEditing: true, castObservationDecisions: true };
    const person = { id, name: "Marin", aliases: [], origin: { kind: "manual" as const }, profile: { "story.role": "Guard" }, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 1, lastMentionedTurn: null };
    const observation = { id: observationId, characterId: id, field: "story.role" as const, value: "Guard", mode: "fact" as const, speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn" as const, turnNumber: 1, turnId: id, quote: "A guard appeared", startOffset: 0, endOffset: 16, invalidated: false } };
    let detail = { revision: 1, boundary, capabilities, character: person, observations: [observation], observationDecisionStatus: [{ observationId, state: "eligible" as const, retractionEventId: null, reason: null }], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const edit = vi.fn(async (_campaign: string, _id: string, body: { name?: string }) => { detail = { ...detail, revision: 2, character: { ...person, name: body.name ?? person.name, revision: 2 } }; return { revision: 2, boundary, character: detail.character }; });
    const previewObservationDecision = vi.fn(async () => ({ currentValue: "Guard", projectedValue: null }));
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: async () => detail, edit, previewObservationDecision, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    vi.useFakeTimers();
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Name")!.click();
    const input = dialog.querySelector<HTMLInputElement>('[data-path="name"] input')!; input.value = "Mara"; input.dispatchEvent(new window.Event("input"));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click(); await vi.advanceTimersByTimeAsync(0);
    const oldUndo = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Undo")!; expect(oldUndo).toBeTruthy();
    await vi.advanceTimersByTimeAsync(30000); expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false);
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "This is wrong")!.click(); await vi.advanceTimersByTimeAsync(0);
    expect(dialog.textContent).toContain("After this"); expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false);
    oldUndo.click(); await vi.advanceTimersByTimeAsync(0); expect(edit).toHaveBeenCalledTimes(1);
    panel.requestClose(); vi.useRealTimers();
  });
  it.each(["before refresh", "after refresh", "refresh fails"] as const)("handles %s without rebasing Undo", async scenario => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Marin", aliases: [], origin: { kind: "manual" as const }, profile: { "story.role": "Guard" }, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    let detail = { revision: 1, boundary, capabilities, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null }, reads = 0;
    const read = vi.fn(async () => { reads++; if (reads === 2 && scenario === "refresh fails") throw new Error("offline"); if (reads === 2 && scenario === "before refresh") detail = { ...detail, revision: 3 }; return detail; });
    const edit = vi.fn(async (_campaign, _id, _body) => { if (scenario === "after refresh" && detail.revision === 2) throw Object.assign(new Error("conflict"), { statusCode: 409 }); detail = { ...detail, revision: 2, character: { ...person, revision: 2, profile: { "story.role": "Captain" } } }; return { revision: 2, boundary, character: detail.character }; });
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: read, edit, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Role")!.click(); const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Captain"; input.dispatchEvent(new window.Event("input"));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click();
    if (scenario === "before refresh") { await vi.waitFor(() => expect(dialog.textContent).toContain("Undo expired: the character was updated after your save.")); expect(edit).toHaveBeenCalledTimes(1); expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false); }
    if (scenario === "after refresh") { await vi.waitFor(() => expect(dialog.textContent).toContain("Saved Role.")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Undo")!.click(); await vi.waitFor(() => expect(dialog.textContent).toContain("Could not undo. The character changed; review the latest values.")); expect(edit).toHaveBeenCalledTimes(2); }
    if (scenario === "refresh fails") { await vi.waitFor(() => expect(dialog.textContent).toContain("Saved Role. Could not refresh this character.")); expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Reload")!.click(); await vi.waitFor(() => expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(true)); expect(edit).toHaveBeenCalledTimes(1); }
    panel.requestClose();
  });
  it("clears the refresh-failure notice after Reload once Undo is gone", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Marin", aliases: [], origin: { kind: "manual" as const }, profile: { "story.role": "Guard" }, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    let detail = { revision: 1, boundary, capabilities, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null }, reads = 0;
    // Read 1 opens the sheet, read 2 follows the save, read 3 follows Undo and fails, read 4 is Reload.
    const read = vi.fn(async () => { reads++; if (reads === 3) throw new Error("offline"); return detail; });
    const edit = vi.fn(async () => { const revision = detail.revision + 1; detail = { ...detail, revision, character: { ...person, revision } }; return { revision, boundary, character: detail.character }; });
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: read, edit, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    const buttons = () => [...dialog.querySelectorAll("button")];
    await panel.open(); buttons().find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    buttons().find(button => button.textContent === "Edit Role")!.click(); const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Captain"; input.dispatchEvent(new window.Event("input"));
    buttons().find(button => button.textContent === "Save")!.click();
    await vi.waitFor(() => expect(buttons().some(button => button.textContent === "Undo")).toBe(true));
    buttons().find(button => button.textContent === "Undo")!.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain("Undone. Could not refresh this character."));
    buttons().find(button => button.textContent === "Reload")!.click();
    await vi.waitFor(() => expect(dialog.textContent).not.toContain("Could not refresh this character."));
    expect(buttons().some(button => button.textContent === "Reload")).toBe(false); expect(reads).toBe(4);
    panel.requestClose();
  });
  it("uses the authored-profile endpoint for a Starting Cast Character", async () => {
    const { document, window } = parseHTML("<html><body></body></html>"); vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const id = "11111111-1111-4111-8111-111111111111", boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const profile = characterProfileSchema.parse({ story: { role: "Scout" } });
    const person = { id, name: "Marin", aliases: [], origin: { kind: "world" as const, entityId: "marin", worldVersionId: id }, originProfile: { seedEventId: id, worldVersionId: id, entityId: "marin", rosterName: "Marin", rosterAliases: [], legacyCharacterText: "", profile, evidence: { kind: "world" as const, worldVersionId: id, sourcePath: "/characters/0" } }, campaignProfile: profile, profile: { "story.role": "Scout" }, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const detail = { revision: 1, boundary, capabilities, character: person, observations: [], overrides: [], identityEvents: [], authoredHistory: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const editAuthoredProfile = vi.fn(async (_campaign: string, _id: string, _body: unknown) => ({ revision: 2, boundary, character: { ...person, revision: 2 } }));
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: async () => detail, editAuthoredProfile, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Role")!.click(); const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new window.Event("input")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click();
    await vi.waitFor(() => expect(editAuthoredProfile).toHaveBeenCalled()); expect(editAuthoredProfile.mock.calls[0]![2]).toEqual({ expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: expect.any(String), set: { "story.role": "Guide" } }); await vi.waitFor(() => expect(dialog.textContent).toContain("Undo expired")); panel.requestClose();
  });
  it("keeps a Main Character edit on conflict and offers the latest version", async () => {
    const { document, window } = parseHTML("<html><body></body></html>"); vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const id = "11111111-1111-4111-8111-111111111111", boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const person = { id, name: "Marin", aliases: [], origin: { kind: "protagonist" as const }, profile: {}, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const detail = { revision: 1, boundary, capabilities, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const profile = { name: "Marin", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), revision: 3 };
    const saveProfile = vi.fn(async () => { throw Object.assign(new Error("conflict"), { statusCode: 409 }); });
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: async () => detail, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, getProfile: async () => profile, saveProfile, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Role")!.click(); const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new window.Event("input")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain("This character changed. Your edit is kept")); expect(input.value).toBe("Guide"); expect(dialog.textContent).toContain("Load latest version"); expect(saveProfile).toHaveBeenCalledOnce();
  });
  it("previews and applies a Retraction before refreshing the sheet", async () => {
    const { document, window } = parseHTML("<html><body></body></html>"); vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const id = "11111111-1111-4111-8111-111111111111", observationId = "22222222-2222-4222-8222-222222222222", boundary = { turnNumber: 1, timelineRevision: 0 }, capabilities = { castEditing: true, castObservationDecisions: true };
    const person = { id, name: "Marin", aliases: [], origin: { kind: "manual" as const }, profile: { "story.role": "Guard" }, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 1, lastMentionedTurn: null };
    const observation = { id: observationId, characterId: id, field: "story.role" as const, value: "Guard", mode: "fact" as const, speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn" as const, turnNumber: 1, turnId: id, quote: "A guard appeared", startOffset: 0, endOffset: 16, invalidated: false } };
    const detail = { revision: 1, boundary, capabilities, character: person, observations: [observation], observationDecisionStatus: [{ observationId, state: "eligible" as const, retractionEventId: null, reason: null }], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    const previewObservationDecision = vi.fn(async () => ({ currentValue: "Guard", projectedValue: null })); const applyObservationDecision = vi.fn(async (_campaign: string, _id: string, _observation: string, _body: unknown) => ({})); const read = vi.fn(async () => detail);
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: read, previewObservationDecision, applyObservationDecision, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} }); const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "This is wrong")!.click(); await vi.waitFor(() => expect(dialog.textContent).toContain("After this")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Confirm")!.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); expect(previewObservationDecision).toHaveBeenCalledOnce(); expect(applyObservationDecision).toHaveBeenCalledOnce(); expect(applyObservationDecision.mock.calls[0]![3]).toEqual({ action: "retract", expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: expect.any(String) });
  });
  it.each(["before refresh", "after refresh"] as const)("fences Main Character Undo %s", async scenario => {
    const { document, window } = parseHTML("<html><body></body></html>"); vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const id = "11111111-1111-4111-8111-111111111111", boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const person = { id, name: "Marin", aliases: [], origin: { kind: "protagonist" as const }, profile: {}, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
    const detail = { revision: 1, boundary, capabilities, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null };
    let profile = { name: "Marin", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), revision: 1 }, reads = 0;
    const getProfile = vi.fn(async () => { reads++; if (reads === 2 && scenario === "before refresh") profile = { ...profile, revision: 3 }; return profile; });
    const saveProfile = vi.fn(async (_campaign: string, _body: unknown) => { if (scenario === "after refresh" && profile.revision === 2) throw Object.assign(new Error("conflict"), { statusCode: 409 }); profile = { ...profile, revision: 2, profile: characterProfileSchema.parse({ story: { role: "Guide" } }) }; return profile; });
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [person], nextCursor: null }), detail: async () => detail, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, getProfile, saveProfile, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} }); const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0)); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Role")!.click(); const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new window.Event("input")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click();
    if (scenario === "before refresh") { await vi.waitFor(() => expect(dialog.textContent).toContain("Undo expired")); expect(saveProfile).toHaveBeenCalledTimes(1); }
    else { await vi.waitFor(() => expect(dialog.textContent).toContain("Saved Role.")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Undo")!.click(); await vi.waitFor(() => expect(dialog.textContent).toContain("Could not undo. The character changed")); expect(saveProfile).toHaveBeenCalledTimes(2); }
    panel.requestClose();
  });
  it("waits for a sheet save before switching character", async () => {
    const { document, window } = parseHTML("<html><body></body></html>"); vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement); window.confirm = () => true;
    const boundary = { turnNumber: 0, timelineRevision: 0 }, capabilities = { castEditing: true };
    const person = (id: string, name: string) => ({ id, name, aliases: [], origin: { kind: "manual" as const }, profile: { "story.role": "Guard" }, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null });
    const first = person("11111111-1111-4111-8111-111111111111", "Marin"), second = person("22222222-2222-4222-8222-222222222222", "Mara");
    let finish!: (value: unknown) => void; const edit = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const api = { list: async () => ({ revision: 1, boundary, capabilities, characters: [first, second], nextCursor: null }), detail: async (_campaign: string, id: string) => ({ revision: 1, boundary, capabilities, character: id === first.id ? first : second, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null }), edit, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} }); const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Marin"))!.click(); await new Promise(resolve => setTimeout(resolve, 0)); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Edit Role")!.click(); const input = dialog.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new window.Event("input")); [...dialog.querySelectorAll("button")].find(button => button.textContent === "Save")!.click();
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Mara")!.click(); expect(dialog.querySelector("#cast-title")?.textContent).toBe("Marin");
    finish({ revision: 2, boundary, character: { ...first, revision: 2 } }); await vi.waitFor(() => expect(dialog.textContent).toContain("Saved Role."));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Mara")!.click(); await vi.waitFor(() => expect(dialog.querySelector("#cast-title")?.textContent).toBe("Mara")); expect(dialog.textContent).not.toContain("Saved Role."); panel.requestClose();
  });
  it("debounces search once and ignores an older response", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("HTMLElement", window.HTMLElement);
    const authority = { revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 }, capabilities: { castEditing: true, castLifecycle: false }, nextCursor: null };
    const person = (name: string) => ({ id: name, name, aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null });
    const pending = new Map<string, (value: unknown) => void>();
    const list = vi.fn((_campaign: string, args?: { query?: string }) => args?.query ? new Promise(resolve => pending.set(args.query!, resolve)) : Promise.resolve({ ...authority, characters: [] }));
    const api = { list, discoveryStatus: async () => null, workspaceStatus: async () => { throw new Error("unavailable"); } };
    const panel = createLegacyCastPanel({ api: api as never, campaignId: () => "campaign", generationActive: () => false, openProtagonist: () => {}, navigateToTurn: async () => {} });
    const dialog = document.querySelector("dialog")!; dialog.showModal = () => dialog.setAttribute("open", ""); dialog.close = () => dialog.removeAttribute("open");
    await panel.open(); expect(dialog.querySelector('#cast-filter option[value="removed"]')).not.toBeNull();
    vi.useFakeTimers();
    const search = dialog.querySelector<HTMLInputElement>("#cast-search")!;
    search.value = "a"; search.dispatchEvent(new window.Event("input")); search.value = "old"; search.dispatchEvent(new window.Event("input"));
    await vi.advanceTimersByTimeAsync(249); expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(2);
    // An in-flight response cannot replace a newer pending input.
    search.value = "new"; search.dispatchEvent(new window.Event("input"));
    pending.get("old")!({ ...authority, characters: [person("Old")] }); await vi.advanceTimersByTimeAsync(0);
    expect(dialog.querySelector<HTMLInputElement>("#cast-search")?.value).toBe("new");
    await vi.advanceTimersByTimeAsync(250); expect(list).toHaveBeenCalledTimes(3);
    pending.get("new")!({ ...authority, characters: [person("New")] }); await vi.advanceTimersByTimeAsync(0);
    expect(dialog.textContent).toContain("New"); expect(dialog.textContent).not.toContain("Old");
    const nextSearch = dialog.querySelector<HTMLInputElement>("#cast-search")!;
    nextSearch.value = "first"; nextSearch.dispatchEvent(new window.Event("input")); await vi.advanceTimersByTimeAsync(250);
    nextSearch.value = "second"; nextSearch.dispatchEvent(new window.Event("input")); await vi.advanceTimersByTimeAsync(250);
    pending.get("second")!({ ...authority, characters: [person("Second")] }); await vi.advanceTimersByTimeAsync(0);
    pending.get("first")!({ ...authority, characters: [person("First")] }); await vi.advanceTimersByTimeAsync(0);
    expect(dialog.textContent).toContain("Second"); expect(dialog.textContent).not.toContain("First");
    panel.requestClose(); vi.useRealTimers();
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
    const api = { previewObservationDecision: async () => { throw new Error("not used"); }, applyObservationDecision: async () => { throw new Error("not used"); }, reviewDecision: async () => { throw new Error("not used"); }, dismissedReview: async () => { throw new Error("not used"); }, contextPreview: async () => { throw new Error("not used"); }, resolveDetail: async () => { throw new Error("not used"); }, detachAttachment: async () => { throw new Error("not used"); }, workspaceStatus: async () => { throw new Error("not used"); }, retryDiscovery: async () => { throw new Error("not used"); }, candidates: async () => ({ revision: 1, boundary: authority.boundary, candidates: [], nextCursor: null }),
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
    expect([...dialog.querySelectorAll("button")].find((button) => button.textContent === "Add character")?.disabled).toBe(true);
    expect(dialog.querySelector(".cast-roster-status")?.compareDocumentPosition(dialog.querySelector("#cast-search")!)! & 4).toBeTruthy();
    const tools = dialog.querySelector(".cast-roster-tools")!;
    expect(tools.textContent).toContain("Refresh characters");
    expect(tools.textContent).toContain("Likely included for this input");
    expect(dialog.querySelector("#cast-filter option[value=removed]")).toBeNull();
    generationActive = false;
    const row = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("<img"))!;
    row.click(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.textContent).not.toContain("Pronouns: Unknown");
    expect(dialog.textContent).toContain("Your override: Role");
    expect(dialog.textContent).not.toContain("Your override: story.role");
    expect(dialog.querySelector('[aria-current="true"]')?.textContent).toContain("<img");
    const toggle = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Show empty fields")!;
    toggle.click();
    expect(dialog.querySelector('[data-path="identity.pronouns"]')?.textContent).toContain("Unknown");
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
