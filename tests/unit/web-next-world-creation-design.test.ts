import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountWorldCreationPage } from "../../apps/web-next/src/world-creation-page.js";

const webNextRoot = path.resolve(import.meta.dirname, "../../apps/web-next");
const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
const creationSource = fs.readFileSync(path.join(webNextRoot, "src/world-creation-page.ts"), "utf8");

function cssRule(source: string, selector: string): string {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].replace(/\s+/g, " ").trim() === normalizedSelector) return match[2];
  }
  return "";
}

function atRule(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) return "";
  const opening = source.indexOf("{", start + header.length);
  if (opening < 0) return "";
  let depth = 1;
  for (let index = opening + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  return "";
}

function creationFixture() {
  const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Creation fixture is missing.");
  return { document, root };
}

describe("World Creation Atlas Workspace design contract", () => {
  it("keeps method selection compact and all creation actions touch accessible", () => {
    const method = cssRule(css, ".creation-method-control");
    const tool = cssRule(css, ".creation-prompt-tools button");
    const stageAction = cssRule(css, ".creation-stage-actions button");
    const dynamicActions = cssRule(css, ".creation-stage-index button, .creation-canvas button, .creation-canvas summary, .creation-cover-control");
    const coverControl = cssRule(css, ".creation-cover-control");

    expect(method).toMatch(/height:\s*48px/);
    expect(method).toMatch(/display:\s*inline-flex/);
    expect(method).not.toMatch(/min-height:\s*(?:[6-9]\d|\d{3,})px/);
    expect(tool).toMatch(/min-width:\s*44px/);
    expect(tool).toMatch(/min-height:\s*44px/);
    expect(stageAction).toMatch(/min-height:\s*44px/);
    expect(dynamicActions).toMatch(/min-height:\s*44px/);
    expect(coverControl).toMatch(/min-height:\s*44px/);
    expect(coverControl).toMatch(/display:\s*flex/);
  });

  it("keeps illustrative sample worlds out of runtime creation content", () => {
    expect(creationSource).not.toContain("A glass city follows a migrating star");
    expect(creationSource).not.toContain("A glass city follows a migrating star…");
  });

  it("renders only Copy, Paste, and Expand prompt tools with authored SVG icons", () => {
    const { document, root } = creationFixture();
    mountWorldCreationPage(root, { generateWorldPreview: vi.fn() });

    const toolbar = document.querySelector(".creation-prompt-heading .creation-prompt-tools");
    const actions = [...(toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? [])];

    expect(actions.map((action) => action.dataset.action)).toEqual(["copy-prompt", "paste-prompt", "expand-prompt"]);
    expect(actions.every((action) => action.querySelector('svg[aria-hidden="true"]'))).toBe(true);
    expect(actions[0]?.querySelector("span")).toBeNull();
    expect(actions[1]?.querySelector("span")).toBeNull();
    expect(actions[2]?.textContent?.trim()).toBe("Expand");
  });

  it("constructs a desktop stage rail, broad canvas, and bottom progress ledger", () => {
    expect(cssRule(css, ".creation-workspace")).toMatch(/grid-template-columns:\s*minmax\([^;]+\)\s+minmax\(0,\s*1fr\)/);
    expect(cssRule(css, ".creation-stage-index")).toMatch(/border-right:\s*1px solid var\(--rule-strong\)/);
    expect(cssRule(css, ".creation-stage-index button")).toMatch(/min-height:\s*64px/);
    expect(cssRule(css, ".creation-canvas")).toMatch(/min-height:/);
    expect(cssRule(css, ".creation-progress-ledger, .creation-stage-actions")).toMatch(/position:\s*sticky/);
    expect(cssRule(css, ".creation-progress-ledger, .creation-stage-actions")).toMatch(/bottom:\s*0/);
    expect(cssRule(css, ".creation-progress-ledger, .creation-stage-actions")).toMatch(/display:\s*grid/);
  });

  it("recomposes at 720px into a horizontal stage index, two-cell ledger, and full-width compact dialog", () => {
    const compact = atRule(css, "@media (max-width: 720px)");

    expect(cssRule(compact, ".creation-stage-index")).toMatch(/flex-direction:\s*row/);
    expect(cssRule(compact, ".creation-stage-index")).toMatch(/overflow-x:\s*auto/);
    expect(cssRule(compact, ".creation-stage-index button")).toMatch(/min-height:\s*52px/);
    expect(cssRule(compact, ".creation-progress-ledger, .creation-stage-actions")).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(cssRule(compact, ".creation-stage-actions::before")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(cssRule(compact, ".creation-prompt-dialog")).toMatch(/width:\s*100%/);
    expect(cssRule(compact, ".creation-prompt-dialog")).toMatch(/max-width:\s*none/);
    expect(cssRule(compact, ".creation-prompt-dialog")).toMatch(/margin:\s*0/);
    expect(cssRule(compact, ".creation-prompt-dialog")).toMatch(/inset:\s*auto\s+0\s+0/);
  });

  it("styles current, completed, focus, checked, disabled, and dialog states without color-only meaning", () => {
    expect(cssRule(css, '.creation-stage-index [data-stage-state="current"]')).toMatch(/box-shadow:[^;]+var\(--accent\)/);
    const completed = cssRule(css, '.creation-stage-index [data-stage-state="completed"]::after');
    expect(completed).toMatch(/content:\s*""/);
    expect(completed).toMatch(/transform:\s*rotate\(45deg\)/);
    expect(cssRule(css, ".creation-stage-index [aria-disabled=\"true\"]")).toMatch(/opacity:/);
    expect(cssRule(css, ".creation-method-control:has(input:checked)")).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(cssRule(css, ".creation-prompt-tools button:focus-visible, .creation-stage-actions button:focus-visible, .creation-prompt-dialog button:focus-visible")).toMatch(/outline:/);
    expect(cssRule(css, ".creation-prompt-dialog[open]")).toMatch(/display:\s*grid/);
  });

  it("preserves hidden state text and actions while bounding Review content above the ledger", () => {
    const hiddenCompletion = cssRule(css, ".creation-stage-index .visually-hidden");
    const hiddenManual = cssRule(css, ".creation-manual-action[hidden]");
    const serializedReview = cssRule(css, '.creation-canvas[data-creation-stage="review"] [data-review-serialized]');

    expect(hiddenCompletion).toMatch(/position:\s*absolute/);
    expect(hiddenCompletion).toMatch(/min-height:\s*0/);
    expect(hiddenCompletion).toMatch(/clip:/);
    expect(hiddenManual).toMatch(/display:\s*none/);
    expect(serializedReview).toMatch(/max-height:/);
    expect(serializedReview).toMatch(/overflow:\s*auto/);
  });

  it("removes dialog, stage, and progress transitions when reduced motion is requested", () => {
    const reducedMotion = atRule(css, "@media (prefers-reduced-motion: reduce)");
    const rule = cssRule(reducedMotion, ".creation-prompt-dialog, .creation-stage-index [data-stage-state], .creation-progress-ledger, .creation-stage-actions");

    expect(rule).toMatch(/transition:\s*none/);
    expect(rule).toMatch(/animation:\s*none/);
  });

  it("uses semantic color tokens throughout every creation selector", () => {
    const prohibitedLiteral = /#[\da-f]{3,8}\b|\brgba?\s*\(|\bcolor-mix\s*\(/i;
    const creationRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].includes(".creation-"));

    expect(creationRules.length).toBeGreaterThan(20);
    expect(creationRules.flatMap((match) => match[2]
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => prohibitedLiteral.test(declaration))
      .map((declaration) => `${match[1].trim()} { ${declaration} }`))).toEqual([]);
  });

  it("records all five creation primitives in the design sidecar", () => {
    const design = JSON.parse(fs.readFileSync(path.join(webNextRoot, ".impeccable/design.json"), "utf8"));
    const names = design.components.map((component: { name: string }) => component.name);

    expect(names).toEqual(expect.arrayContaining([
      "Creation Stage Index",
      "Compact Method Control",
      "Prompt Toolbar",
      "Expanded Prompt Dialog",
      "Creation Progress Ledger"
    ]));
  });
});
