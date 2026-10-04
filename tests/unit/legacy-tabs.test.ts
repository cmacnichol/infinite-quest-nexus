import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { bindLegacyTabGroup } from "../../apps/web/src/legacy-tabs.js";

interface TabFixtureItem {
  readonly key: string;
  readonly label: string;
  readonly tabId: string;
  readonly panelId: string;
  readonly disabled?: "native" | "aria";
}

const worldAuthorTabs: readonly TabFixtureItem[] = [
  { key: "basics", label: "Basics", tabId: "worldAuthorTabBasics", panelId: "world-author-overview" },
  { key: "lore", label: "Lore", tabId: "worldAuthorTabLore", panelId: "world-author-lore" },
  { key: "character", label: "Playable character", tabId: "worldAuthorTabCharacter", panelId: "world-author-mechanics" },
  { key: "review", label: "Review", tabId: "worldAuthorTabReview", panelId: "world-author-review" }
];

function createTabFixture(items = worldAuthorTabs, selectedKey = items[0]?.key ?? "") {
  const buttons = items.map(item => `<button id="${item.tabId}" ${item.disabled === "native" ? "disabled" : ""} ${item.disabled === "aria" ? 'aria-disabled="true"' : ""}>${item.label}</button>`).join("");
  const panels = items.map(item => `<section id="${item.panelId}"><label>${item.label} value <input value="keep"></label></section>`).join("");
  const { document, window } = parseHTML(`<body><div id="busyHost"><div id="tabRoot">${buttons}</div>${panels}<div id="outsideRail" role="tablist"><button id="campaignTabOverview" role="tab" aria-selected="true" tabindex="0">Overview</button></div></div></body>`);
  const root = document.getElementById("tabRoot") as HTMLElement;
  const mapping = items.map(item => ({
    key: item.key,
    tab: document.getElementById(item.tabId) as HTMLButtonElement,
    panel: document.getElementById(item.panelId) as HTMLElement
  }));
  let selected = selectedKey;
  let refuseActivation = false;
  const onActivate = vi.fn((key: string) => {
    if (!refuseActivation && !mapping.find(item => item.key === key)?.tab.disabled
      && mapping.find(item => item.key === key)?.tab.getAttribute("aria-disabled") !== "true") {
      selected = key;
    }
  });
  const binding = bindLegacyTabGroup({
    root,
    tabs: mapping,
    getSelectedKey: () => selected,
    onActivate
  });
  const keydown = (target: EventTarget, key: string) => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    target.dispatchEvent(event);
    return event;
  };
  const selectedTab = () => mapping.find(item => item.key === selected)?.tab ?? null;
  return {
    binding,
    document,
    items,
    keydown,
    mapping,
    onActivate,
    root,
    selectedTab,
    window,
    setBusy: (busy: boolean) => document.getElementById("busyHost")?.setAttribute("aria-busy", String(busy)),
    setRefuseActivation: (refuse: boolean) => { refuseActivation = refuse; },
    setSelected: (key: string) => { selected = key; }
  };
}

describe("explicit legacy horizontal tab groups", () => {
  it("synchronizes mapped world-author tabs and panels with one selected tab", () => {
    const fixture = createTabFixture();
    fixture.binding.sync();

    expect(fixture.root.getAttribute("role")).toBe("tablist");
    expect(fixture.root.getAttribute("aria-orientation")).toBe("horizontal");
    expect(fixture.mapping.map(({ tab }) => [tab.id, tab.getAttribute("role"), tab.getAttribute("aria-controls")])).toEqual([
      ["worldAuthorTabBasics", "tab", "world-author-overview"],
      ["worldAuthorTabLore", "tab", "world-author-lore"],
      ["worldAuthorTabCharacter", "tab", "world-author-mechanics"],
      ["worldAuthorTabReview", "tab", "world-author-review"]
    ]);
    expect(fixture.mapping.map(({ panel }) => [panel.id, panel.getAttribute("role"), panel.getAttribute("aria-labelledby")])).toEqual([
      ["world-author-overview", "tabpanel", "worldAuthorTabBasics"],
      ["world-author-lore", "tabpanel", "worldAuthorTabLore"],
      ["world-author-mechanics", "tabpanel", "worldAuthorTabCharacter"],
      ["world-author-review", "tabpanel", "worldAuthorTabReview"]
    ]);
    expect(fixture.mapping.map(({ tab }) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(fixture.mapping.map(({ tab }) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
    expect(fixture.mapping.map(({ panel }) => panel.hasAttribute("hidden"))).toEqual([false, true, true, true]);

    fixture.setSelected("review");
    fixture.binding.sync();
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabReview");
    expect(fixture.mapping.map(({ panel }) => panel.hasAttribute("hidden"))).toEqual([true, true, true, false]);
    expect(fixture.onActivate).not.toHaveBeenCalled();
  });

  it("wraps Left and Right and maps Home and End across enabled tabs only", () => {
    const items: readonly TabFixtureItem[] = [
      worldAuthorTabs[0]!,
      { ...worldAuthorTabs[1]!, disabled: "native" },
      { ...worldAuthorTabs[2]!, disabled: "aria" },
      worldAuthorTabs[3]!
    ];
    const fixture = createTabFixture(items);
    fixture.binding.sync();
    const basics = fixture.mapping[0]!.tab;
    const focusSpies = fixture.mapping.map(({ tab }) => vi.spyOn(tab, "focus"));

    basics.focus();
    fixture.keydown(basics, "ArrowRight");
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabReview");
    fixture.keydown(fixture.mapping[3]!.tab, "ArrowRight");
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabBasics");
    fixture.keydown(basics, "ArrowLeft");
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabReview");
    expect(focusSpies[3]).toHaveBeenCalledTimes(2);
    expect(fixture.onActivate.mock.calls.map(([key]) => key)).toEqual(["review", "basics", "review"]);
    fixture.setSelected("basics");
    fixture.binding.sync();
    basics.focus();
    fixture.keydown(basics, "End");
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabReview");
    fixture.keydown(fixture.mapping[3]!.tab, "Home");
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabBasics");
    expect(fixture.onActivate.mock.calls.map(([key]) => key)).toEqual(["review", "basics", "review", "review", "basics"]);
    expect(fixture.onActivate).toHaveBeenCalledTimes(5);
  });

  it("does not activate or move focus when the selected setter refuses a disabled or busy target", () => {
    const fixture = createTabFixture();
    fixture.binding.sync();
    const basics = fixture.mapping[0]!.tab;
    const focusSpies = fixture.mapping.map(({ tab }) => vi.spyOn(tab, "focus"));
    basics.focus();
    fixture.setBusy(true);
    fixture.keydown(basics, "ArrowRight");
    expect(fixture.onActivate).not.toHaveBeenCalled();
    expect(focusSpies.slice(1).every(spy => spy.mock.calls.length === 0)).toBe(true);

    fixture.setBusy(false);
    fixture.setRefuseActivation(true);
    fixture.keydown(basics, "ArrowRight");
    expect(fixture.onActivate).toHaveBeenCalledTimes(1);
    expect(fixture.onActivate).toHaveBeenCalledWith("lore");
    expect(focusSpies.slice(1).every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(basics.getAttribute("aria-selected")).toBe("true");
    expect(fixture.mapping[1]!.tab.getAttribute("tabindex")).toBe("-1");
  });

  it("ignores vertical arrows, editable controls and nested tab groups", () => {
    const fixture = createTabFixture();
    fixture.binding.sync();
    const basics = fixture.mapping[0]!.tab;
    basics.focus();
    expect(fixture.keydown(basics, "ArrowUp").defaultPrevented).toBe(false);
    expect(fixture.keydown(basics, "ArrowDown").defaultPrevented).toBe(false);

    const input = fixture.document.querySelector("#world-author-overview input") as HTMLInputElement;
    expect(fixture.keydown(input, "ArrowRight").defaultPrevented).toBe(false);
    expect(fixture.keydown(input, "Home").defaultPrevented).toBe(false);

    const nested = fixture.document.createElement("div");
    nested.setAttribute("role", "tablist");
    const nestedTab = fixture.document.createElement("button");
    nestedTab.setAttribute("role", "tab");
    nested.appendChild(nestedTab);
    fixture.root.appendChild(nested);
    expect(fixture.keydown(nestedTab, "ArrowRight").defaultPrevented).toBe(false);
    expect(fixture.onActivate).not.toHaveBeenCalled();
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabBasics");
  });

  it("lets the existing delegated click owner activate once and supports programmatic reset sync", () => {
    const fixture = createTabFixture();
    fixture.binding.sync();
    const lore = fixture.mapping[1]!.tab;
    fixture.root.addEventListener("click", event => {
      const target = event.target;
      const item = fixture.mapping.find(candidate => candidate.tab === target);
      if (!item) return;
      fixture.onActivate(item.key);
      fixture.binding.sync();
    });
    lore.dispatchEvent(new fixture.window.Event("click", { bubbles: true }));
    expect(fixture.onActivate).toHaveBeenCalledTimes(1);
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabLore");

    fixture.setSelected("basics");
    fixture.binding.sync();
    expect(fixture.selectedTab()?.id).toBe("worldAuthorTabBasics");
    expect(fixture.onActivate).toHaveBeenCalledTimes(1);
  });

  it("does not bind or mutate the separately owned campaign settings rail", () => {
    const fixture = createTabFixture();
    const campaignTab = fixture.document.getElementById("campaignTabOverview") as HTMLButtonElement;
    fixture.binding.sync();
    fixture.keydown(campaignTab, "ArrowRight");

    expect(fixture.onActivate).not.toHaveBeenCalled();
    expect(campaignTab.getAttribute("aria-selected")).toBe("true");
    expect(campaignTab.getAttribute("tabindex")).toBe("0");
    fixture.binding.dispose();
  });
});
