import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync("apps/web/public/index.html", "utf8");
const script = readFileSync("apps/web/public/nexus.js", "utf8");

function campaignFunctions(bindings: Record<string, unknown>) {
  const names = ["normalizedTurnControlStyle", "updateCampaignCreationAvailability", "setCreateCampaignStatus", "openCreateCampaignDialog", "createCampaignFromWorld"];
  const sources = names.map((name) => {
    const start = script.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const definitionStart = script.slice(start - 6, start) === "async " ? start - 6 : start;
    const next = /\n(?:async )?function /.exec(script.slice(start + 1));
    if (!next) throw new Error(`Missing function boundary after ${name}`);
    return script.slice(definitionStart, start + 1 + next.index);
  });
  return Function(...Object.keys(bindings), `let createCampaignSubmitting = false; let createCampaignCommitted = false; ${sources.join("\n")}; return { openCreateCampaignDialog, createCampaignFromWorld };`)(...Object.values(bindings)) as {
    openCreateCampaignDialog: () => void;
    createCampaignFromWorld: () => Promise<void>;
  };
}

describe("legacy campaign creation dialog", () => {
  it("shows an API error locally, preserves the draft, blocks duplicate requests, and succeeds on retry", async () => {
    const { document } = parseHTML(html);
    const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element])) as Record<string, HTMLElement>;
    for (const select of document.querySelectorAll("select")) {
      Object.defineProperty(select, "value", { value: "", writable: true, configurable: true });
    }
    const dialog = elements.createCampaignDialog as HTMLElement & { close: () => void };
    dialog.close = vi.fn();
    const openManagedModal = vi.fn();
    const worldMessage = vi.fn();
    const loadCampaigns = vi.fn().mockResolvedValue(undefined);
    let rejectFirst!: (error: Error) => void;
    const first = new Promise((_, reject) => { rejectFirst = reject; });
    const api = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ id: "campaign-1", selectedCharacterName: "Hero" });
    const { openCreateCampaignDialog, createCampaignFromWorld } = campaignFunctions({
      elements, api, loadCampaigns, worldMessage, openManagedModal,
      selectedWorld: { id: "world-1" }, selectedWorldVersionId: () => "version-1",
      worldVersionCampaignReady: true,
      worldVersionCharacters: [{ id: "character-1" }]
    });

    openCreateCampaignDialog();
    expect(elements.createCampaignStatus?.getAttribute("role")).toBe("alert");
    expect(elements.createCampaignStatus?.hidden).toBe(true);
    (elements.newCampaignTitle as HTMLInputElement).value = "My Campaign";
    (elements.newCampaignTurnControlStyle as HTMLSelectElement).value = "flexible_scene";
    const pending = createCampaignFromWorld();
    await createCampaignFromWorld();
    expect(api).toHaveBeenCalledTimes(1);
    expect((elements.confirmCreateCampaign as HTMLButtonElement).disabled).toBe(true);
    rejectFirst(new Error("Event rule 1 needs a valid effect. Correlation ID: test-123 <img src=x>"));
    await pending;

    expect(elements.createCampaignStatus?.textContent).toContain("Event rule 1 needs a valid effect.");
    expect(elements.createCampaignStatus?.querySelector("img")).toBeNull();
    expect(elements.createCampaignStatus?.hidden).toBe(false);
    expect(dialog.close).not.toHaveBeenCalled();
    expect((elements.newCampaignTitle as HTMLInputElement).value).toBe("My Campaign");
    expect((elements.newCampaignTurnControlStyle as HTMLSelectElement).value).toBe("flexible_scene");
    expect((elements.confirmCreateCampaign as HTMLButtonElement).disabled).toBe(false);

    await createCampaignFromWorld();
    expect(elements.createCampaignStatus?.hidden).toBe(true);
    expect(api).toHaveBeenCalledTimes(2);
    expect(JSON.parse(api.mock.calls[1]![1].body)).toMatchObject({ title: "My Campaign", turnControlStyle: "flexible_scene", selectedCharacterId: "character-1" });
    expect(loadCampaigns).toHaveBeenCalledWith("campaign-1");
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });

  it("reports a committed campaign when list refresh fails without offering a creation retry", async () => {
    const { document } = parseHTML(html);
    const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element])) as Record<string, HTMLElement>;
    for (const select of document.querySelectorAll("select")) {
      Object.defineProperty(select, "value", { value: "", writable: true, configurable: true });
    }
    const dialog = elements.createCampaignDialog as HTMLElement & { close: () => void };
    dialog.close = vi.fn();
    const api = vi.fn().mockResolvedValue({ id: "campaign-1", selectedCharacterName: "Hero" });
    const loadCampaigns = vi.fn().mockRejectedValue(new Error("Connection lost"));
    const worldMessage = vi.fn();
    const { openCreateCampaignDialog, createCampaignFromWorld } = campaignFunctions({
      elements, api, loadCampaigns, worldMessage, openManagedModal: vi.fn(),
      selectedWorld: { id: "world-1" }, selectedWorldVersionId: () => "version-1",
      worldVersionCampaignReady: true, worldVersionCharacters: [{ id: "character-1" }]
    });

    openCreateCampaignDialog();
    (elements.newCampaignTitle as HTMLInputElement).value = "My Campaign";
    await createCampaignFromWorld();

    expect(api).toHaveBeenCalledTimes(1);
    expect(dialog.close).toHaveBeenCalledTimes(1);
    expect((elements.newCampaignTitle as HTMLInputElement).value).toBe("");
    expect(elements.createCampaignStatus!.hidden).toBe(true);
    expect(worldMessage.mock.calls.some(([message, type]) => type === "error" && message.includes("Campaign was created") && message.includes("Refresh"))).toBe(true);
    await createCampaignFromWorld();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("clears a stale error when the dialog opens", () => {
    const { document } = parseHTML(html);
    const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element])) as Record<string, HTMLElement>;
    for (const select of document.querySelectorAll("select")) {
      Object.defineProperty(select, "value", { value: "", writable: true, configurable: true });
    }
    elements.createCampaignStatus!.textContent = "Previous failure";
    elements.createCampaignStatus!.hidden = false;
    const openManagedModal = vi.fn();
    const { openCreateCampaignDialog } = campaignFunctions({
      elements, openManagedModal, worldMessage: vi.fn(),
      selectedWorld: { id: "world-1" }, selectedWorldVersionId: () => "version-1",
      worldVersionCampaignReady: true, worldVersionCharacters: [{ id: "character-1" }]
    });

    openCreateCampaignDialog();
    expect(elements.createCampaignStatus!.textContent).toBe("");
    expect(elements.createCampaignStatus!.hidden).toBe(true);
    expect(openManagedModal.mock.calls.length).toBe(1);
    expect(openManagedModal.mock.calls[0]![0] === elements.createCampaignDialog).toBe(true);
  });
});
