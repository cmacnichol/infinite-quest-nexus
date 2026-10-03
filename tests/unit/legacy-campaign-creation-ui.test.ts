import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { buildCampaignCreateRequest } from "../../packages/client-core/src/campaign-creation-draft.js";

const html = readFileSync("apps/web/public/index.html", "utf8");
const script = readFileSync("apps/web/public/nexus.js", "utf8");
const campaignId = "00000000-0000-4000-8000-000000000001";
const worldId = "00000000-0000-4000-8000-000000000002";
const worldVersionId = "00000000-0000-4000-8000-000000000003";

function createSubmitFunction(bindings: Record<string, unknown>) {
  const source = ["setCampaignCreationFieldsDisabled", "createCampaignFromWorld"].map((name) => {
    const start = script.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const next = /\n(?:async )?function /.exec(script.slice(start + 1));
    if (!next) throw new Error(`Missing function boundary after ${name}`);
    return script.slice(start, start + 1 + next.index);
  }).join("\n").replace("function createCampaignFromWorld", "async function createCampaignFromWorld");
  return Function(...Object.keys(bindings), `let createCampaignSubmitting = false; let createCampaignCommitted = false; ${source}; return createCampaignFromWorld;`)(...Object.values(bindings)) as (event: { submitter: HTMLElement }) => Promise<void>;
}

function formElements() {
  const { document } = parseHTML(html);
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element])) as Record<string, HTMLElement>;
  (elements.newCampaignTitle as HTMLInputElement).value = "My Campaign";
  (elements.newCampaignCharacter as HTMLSelectElement).innerHTML = '<option value="fixture-character">Hero</option>';
  Object.defineProperty(elements.newCampaignCharacter, "value", { value: "fixture-character", writable: true, configurable: true });
  Object.defineProperty(elements.newCampaignTurnControlStyle, "value", { value: "flexible_scene", writable: true, configurable: true });
  const dialog = elements.createCampaignDialog as HTMLDialogElement & { close: () => void };
  dialog.open = true;
  dialog.close = vi.fn();
  return { elements, dialog };
}

function submitEvent(elements: Record<string, HTMLElement>, intent: "create" | "start") {
  return { submitter: { value: intent } as unknown as HTMLButtonElement };
}

function submitHarness(overrides: Record<string, unknown> = {}) {
  const { elements, dialog } = formElements();
  const session = {
    worldId,
    worldVersionId,
    characters: [{ id: "fixture-character", name: "Hero" }],
    draft: { worldId, worldVersionId, title: "", selectedCharacterId: "fixture-character", turnControlStyle: "flexible_action", startAfterCreate: true },
    ready: true,
    committedCampaignId: null as string | null
  };
  const api = vi.fn().mockResolvedValue({ id: campaignId, selectedCharacterName: "Hero" });
  const loadCampaigns = vi.fn().mockResolvedValue(undefined);
  const setItem = vi.fn();
  const assign = vi.fn();
  const env = {
    elements,
    campaignCreationDialogSession: session,
    campaignCreationSessionIsCurrent: () => true,
    buildCampaignCreateRequest,
    normalizedTurnControlStyle: (value: string) => value === "flexible_scene" ? "flexible_scene" : "flexible_action",
    setCreateCampaignStatus(message = "") { elements.createCampaignStatus!.textContent = message; elements.createCampaignStatus!.hidden = !message; },
    updateCampaignCreationDialogAvailability: vi.fn(),
    refreshModalBaseline: vi.fn(),
    api,
    loadCampaigns,
    worldMessage: vi.fn(),
    localStorage: { setItem },
    window: { location: { assign } },
    ...overrides
  };
  return { create: createSubmitFunction(env), elements, dialog, session, api, loadCampaigns, setItem, assign };
}

describe("legacy campaign creation dialog", () => {
  it("preserves the selected character and Story Direction when the API rejects, then retries with the same fields", async () => {
    const harness = submitHarness();
    let rejectCreate!: (error: Error) => void;
    harness.api.mockReturnValueOnce(new Promise((_, reject) => { rejectCreate = reject; }));
    const event = submitEvent(harness.elements, "create");

    const pending = harness.create(event);
    expect((harness.elements.newCampaignTitle as HTMLInputElement).disabled).toBe(true);
    expect((harness.elements.newCampaignCharacter as HTMLSelectElement).disabled).toBe(true);
    expect((harness.elements.newCampaignTurnControlStyle as HTMLSelectElement).disabled).toBe(true);
    expect((harness.elements.cancelCreateCampaign as HTMLButtonElement).disabled).toBe(true);
    rejectCreate(new Error("Campaign could not be created."));
    await pending;
    expect(harness.elements.createCampaignStatus?.textContent).toContain("Campaign could not be created.");
    expect((harness.elements.newCampaignTitle as HTMLInputElement).disabled).toBe(false);
    expect((harness.elements.newCampaignCharacter as HTMLSelectElement).disabled).toBe(false);
    expect((harness.elements.newCampaignTurnControlStyle as HTMLSelectElement).disabled).toBe(false);
    expect((harness.elements.cancelCreateCampaign as HTMLButtonElement).disabled).toBe(false);
    expect((harness.elements.newCampaignTitle as HTMLInputElement).value).toBe("My Campaign");
    expect((harness.elements.newCampaignCharacter as HTMLSelectElement).value).toBe("fixture-character");
    expect((harness.elements.newCampaignTurnControlStyle as HTMLSelectElement).value).toBe("flexible_scene");

    await harness.create(event);
    expect(JSON.parse(harness.api.mock.calls[1]![1].body)).toEqual({
      worldVersionId,
      title: "My Campaign",
      selectedCharacterId: "fixture-character",
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 32_000,
      turnControlStyle: "flexible_scene"
    });
    expect(harness.loadCampaigns).toHaveBeenCalledWith(campaignId, { explicitPreselect: true });
  });

  it("records the committed ID before storage and refresh errors and never posts again", async () => {
    const harness = submitHarness({ localStorage: { setItem: vi.fn(() => { throw new Error("Storage unavailable."); }) } });
    harness.loadCampaigns.mockRejectedValue(new Error("Connection lost."));

    await harness.create(submitEvent(harness.elements, "create"));
    expect(harness.session.committedCampaignId).toBe(campaignId);
    expect(harness.elements.openCommittedCampaign!.hidden).toBe(false);
    expect(harness.elements.createCampaignStatus?.textContent).toContain("Campaign was created");
    await harness.create(submitEvent(harness.elements, "create"));
    expect(harness.api).toHaveBeenCalledTimes(1);
  });

  it("opens the exact committed ID for Create and start without refreshing the list", async () => {
    const harness = submitHarness();

    await harness.create(submitEvent(harness.elements, "start"));

    expect(harness.session.committedCampaignId).toBe(campaignId);
    expect(harness.setItem).toHaveBeenCalledWith("infiniteQuestLastCampaignId", campaignId);
    expect(harness.assign).toHaveBeenCalledWith(`/story/${encodeURIComponent(campaignId)}`);
    expect(harness.loadCampaigns).not.toHaveBeenCalled();
  });

  it("keeps the committed campaign openable when start navigation throws", async () => {
    const assign = vi.fn(() => { throw new Error("Navigation unavailable."); });
    const harness = submitHarness({ window: { location: { assign } } });

    await harness.create(submitEvent(harness.elements, "start"));

    expect(harness.session.committedCampaignId).toBe(campaignId);
    expect(harness.dialog.close).not.toHaveBeenCalled();
    expect(harness.elements.openCommittedCampaign!.hidden).toBe(false);
    expect(harness.elements.createCampaignStatus?.textContent).toContain("Campaign was created");
    await harness.create(submitEvent(harness.elements, "create"));
    expect(harness.api).toHaveBeenCalledTimes(1);
  });

  it("shows separate Create only and Create and start intents in the shared dialog", () => {
    const { document } = parseHTML(html);
    const dialog = document.querySelector("#createCampaignDialog");

    expect(dialog?.querySelector('[name="intent"][value="create"]')?.textContent).toBe("Create only");
    expect(dialog?.querySelector('[name="intent"][value="start"]')?.textContent).toBe("Create and start");
    expect(dialog?.querySelector('button[type="submit"]')?.getAttribute("value")).toBe("create");
    expect(dialog?.querySelector("#createCampaignWorldVersion")).not.toBeNull();
    expect(document.querySelector("#quickCampaignDialog")).toBeNull();
  });
});
