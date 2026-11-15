import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { renderMechanicsTable } from "../../apps/web-next/src/character-mechanics-table";

describe("character mechanics table", () => {
  it.each([["stat", ["Name", "Value", "Note"]], ["trigger", ["Name", "Condition", "Effect"]]] as const)("labels %s controls and safely labels unnamed rows", (kind, labels) => {
    const { document } = parseHTML("<div></div>"); const host = document.querySelector("div")!;
    renderMechanicsTable(host, { kind, items: [{}], max: 2, onChange: vi.fn() });
    for (const label of labels) expect(host.querySelector(`[aria-label="${label} for row 1"]`)).not.toBeNull();
    expect(host.querySelector(`button[aria-label="Remove Unnamed ${kind === "stat" ? "statistic" : "tracker"}"]`)).not.toBeNull();
  });
  it("merges edits, restores exact positions, replaces undo, and enforces the limit", () => {
    const { document, window } = parseHTML("<div></div>"); const host = document.querySelector("div")!; const change = vi.fn();
    renderMechanicsTable(host, { kind: "stat", items: [{ skill: "A", extra: { x: 1 } }, { name: "B" }], max: 2, onChange: change });
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Add statistic")?.disabled).toBe(true);
    const field = host.querySelector<HTMLInputElement>('[aria-label="Name for row 1"]')!; field.value = "Changed"; field.dispatchEvent(new window.Event("input"));
    expect(change.mock.lastCall?.[0]).toEqual([{ skill: "Changed", extra: { x: 1 } }, { name: "B" }]);
    (host.querySelector('button[aria-label="Remove Changed"]') as HTMLButtonElement).click();
    (host.querySelector('button[aria-label="Remove B"]') as HTMLButtonElement).click();
    ([...host.querySelectorAll("button")].find(b => b.textContent === "Undo remove") as HTMLButtonElement).click();
    expect(change.mock.lastCall?.[0]).toEqual([{ name: "B" }]);
  });
  it("restores the exact removed row at its index", () => {
    const { document } = parseHTML("<div></div>"); const host = document.querySelector("div")!; const change = vi.fn(); const row = { name: "A", extra: [1] };
    renderMechanicsTable(host, { kind: "stat", items: [row, { name: "B" }], max: 3, onChange: change });
    (host.querySelector('button[aria-label="Remove A"]') as HTMLButtonElement).click();
    ([...host.querySelectorAll("button")].find(b => b.textContent === "Undo remove") as HTMLButtonElement).click();
    expect(change.mock.lastCall?.[0]).toEqual([row, { name: "B" }]);
  });
  it("restores focus and announces the visible range after actions and pagination", () => {
    const { document, window } = parseHTML("<div></div>"); const host = document.querySelector("div")!;
    window.HTMLElement.prototype.focus = function () { Object.defineProperty(document, "activeElement", { configurable: true, value: this }); };
    renderMechanicsTable(host, { kind: "stat", items: Array.from({ length: 51 }, (_, i) => ({ name: `Stat ${i + 1}` })), max: 53, onChange: vi.fn() });
    const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Rows 1–50 of 51");
    button("Next rows").click();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Name for row 51");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Rows 51–51 of 51");
    button("Previous rows").click();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Name for row 1");
    button("Add statistic").click();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Name for row 52");
    (host.querySelector('button[aria-label="Remove Unnamed statistic"]') as HTMLButtonElement).click();
    expect(document.activeElement?.textContent).toBe("Undo remove");
    button("Undo remove").click();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Name for row 52");
  });
  it("focuses an enabled row control when undo is disabled for an over-limit collection", () => {
    const { document, window } = parseHTML("<div></div>"); const host = document.querySelector("div")!;
    window.HTMLElement.prototype.focus = function () { Object.defineProperty(document, "activeElement", { configurable: true, value: this }); };
    renderMechanicsTable(host, { kind: "stat", items: [{ name: "A" }, { name: "B" }, { name: "C" }], max: 2, onChange: vi.fn() });
    (host.querySelector('button[aria-label="Remove A"]') as HTMLButtonElement).click();
    expect(host.querySelector<HTMLButtonElement>('[data-undo-remove]')?.disabled).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Name for row 1");
  });
});
