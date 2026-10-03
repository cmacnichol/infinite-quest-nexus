import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

const managementHtml = readFileSync("apps/web/public/index.html", "utf8");
const managementScript = readFileSync("apps/web/public/nexus.js", "utf8");

function functionSources(names: string[]) {
  return names.map((name) => {
    const match = new RegExp(`(?:async )?function ${name}\\(`, "u").exec(managementScript);
    if (!match || match.index === undefined) throw new Error(`Unable to locate management function ${name}.`);
    const next = /\n(?:async )?function /.exec(managementScript.slice(match.index + 1));
    const end = next ? match.index + 1 + next.index : managementScript.length;
    return managementScript.slice(match.index, end);
  });
}

function selectionHarness({
  api,
  initialWorld = null,
  authorOpen = false,
  dismiss = async () => "dismissed"
}: {
  api: (path: string) => Promise<Record<string, unknown>>;
  initialWorld?: Record<string, unknown> | null;
  authorOpen?: boolean;
  dismiss?: () => Promise<"dismissed" | "stayed">;
}) {
  const { document } = parseHTML(managementHtml);
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element])) as Record<string, any>;
  elements.worldAuthorDialog.open = authorOpen;
  const messages: string[] = [];
  const loadCharacters = vi.fn(async () => undefined);
  const source = functionSources(["selectWorld", "isCurrentWorldSelection"]);
  const names = [
    "elements", "api", "dismissEditDialog", "worldAuthorBusy", "editDialogSessions", "renderManagementWorlds",
    "setWorldEditorDisabled", "number", "Option", "updateWorldVersionDeleteAvailability", "updateCharacterGeneratorAvailability",
    "loadWorldVersionPlayableCharacters", "worldMessage", "resumeWorldCoverJob", "initialWorld"
  ];
  const implementation = Function(
    ...names,
    `let selectedWorld = initialWorld; let worldSelectionId = ""; let worldSelectionEpoch = 0; let worldCoverJobPollSequence = 0;\n${source.join("\n")}\nreturn { selectWorld, isCurrentWorldSelection, get state() { return { selectedWorld, worldSelectionId, worldSelectionEpoch }; } };`
  )(
    elements,
    api,
    dismiss,
    false,
    new WeakMap(),
    () => undefined,
    () => undefined,
    (value: unknown) => String(value),
    function Option(label: string, value: string) {
      const option = document.createElement("option");
      option.textContent = label;
      option.value = value;
      return option;
    },
    () => undefined,
    () => undefined,
    loadCharacters,
    (message: string) => messages.push(message),
    async () => undefined,
    initialWorld
  ) as {
    selectWorld(worldId: string): Promise<void>;
    isCurrentWorldSelection(worldId: string, epoch: number): boolean;
    state: { selectedWorld: Record<string, unknown> | null; worldSelectionId: string; worldSelectionEpoch: number };
  };
  return { implementation, elements, messages, loadCharacters };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function world(id: string, title: string) {
  return { id, title, status: "active", draftRevision: 1, versions: [], campaigns: [] };
}

describe("legacy world navigation", () => {
  it("keeps the latest selected world's details after reversed responses", async () => {
    const pendingA = deferred<Record<string, unknown>>();
    const api = vi.fn((path: string) => path.endsWith("world-a") ? pendingA.promise : Promise.resolve(world("world-b", "World Beta")));
    const { implementation, elements, loadCharacters } = selectionHarness({ api });

    const selectA = implementation.selectWorld("world-a");
    const selectB = implementation.selectWorld("world-b");
    await selectB;
    pendingA.resolve(world("world-a", "World Alpha"));
    await selectA;

    expect(implementation.state.selectedWorld?.id).toBe("world-b");
    expect(elements.worldEditorTitle.textContent).toBe("World Beta");
    expect(loadCharacters).toHaveBeenCalledWith({ worldId: "world-b", selectionEpoch: 2 });
  });

  it("ignores a stale selection error without reporting it over the current world", async () => {
    const pendingA = deferred<Record<string, unknown>>();
    const api = vi.fn((path: string) => path.endsWith("world-a") ? pendingA.promise : Promise.resolve(world("world-b", "World Beta")));
    const { implementation, messages } = selectionHarness({ api });

    const selectA = implementation.selectWorld("world-a");
    const selectB = implementation.selectWorld("world-b");
    await selectB;
    pendingA.reject(new Error("World Alpha request failed"));
    await selectA;

    expect(implementation.state.selectedWorld?.id).toBe("world-b");
    expect(messages).not.toContain("World Alpha request failed");
  });

  it("does not request a new world while the dirty editor decision says Stay", async () => {
    const api = vi.fn(async () => world("world-b", "World Beta"));
    const dismiss = vi.fn(async () => "stayed" as const);
    const { implementation } = selectionHarness({ api, initialWorld: world("world-a", "World Alpha"), authorOpen: true, dismiss });

    await implementation.selectWorld("world-b");

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
    expect(implementation.state.selectedWorld?.id).toBe("world-a");
    expect(implementation.state.worldSelectionEpoch).toBe(0);
  });

  it("invalidates only the changed world's cache and fences its pending detail response", () => {
    const details = new Map([["world-a", { title: "Old Alpha" }], ["world-b", { title: "Current Beta" }]]);
    const epochs = new Map<string, number>();
    const names = ["beginDashboardWorldDetailRequest", "isDashboardWorldDetailRequestCurrent", "invalidateDashboardWorldDetails"];
    const implementation = Function(
      "dashboardWorldDetails", "dashboardWorldDetailRequestEpochs",
      `${functionSources(names).join("\n")}\nreturn { beginDashboardWorldDetailRequest, isDashboardWorldDetailRequestCurrent, invalidateDashboardWorldDetails };`
    )(details, epochs) as {
      beginDashboardWorldDetailRequest(worldId: string): number;
      isDashboardWorldDetailRequestCurrent(worldId: string, requestEpoch: number): boolean;
      invalidateDashboardWorldDetails(worldId: string): void;
    };
    const oldRequest = implementation.beginDashboardWorldDetailRequest("world-a");

    implementation.invalidateDashboardWorldDetails("world-a");

    expect(implementation.isDashboardWorldDetailRequestCurrent("world-a", oldRequest)).toBe(false);
    expect(details.has("world-a")).toBe(false);
    expect(details.get("world-b")).toEqual({ title: "Current Beta" });
  });
});
