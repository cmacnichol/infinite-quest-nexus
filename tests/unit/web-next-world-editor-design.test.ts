import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webNextRoot = path.resolve(import.meta.dirname, "../../apps/web-next");
const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");

function rule(selector: string): string {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].replace(/\s+/g, " ").trim() === normalizedSelector) return match[2];
  }
  return "";
}

function mediaBlock(maxWidth: number): string {
  const start = css.search(new RegExp(`@media\\s*\\(max-width:\\s*${maxWidth}px\\)`));
  if (start < 0) return "";
  const next = css.indexOf("@media", start + 1);
  return css.slice(start, next < 0 ? undefined : next);
}

describe("World Editor design contract", () => {
  it("composes the Draft Ledger workspace for desktop and compact screens", () => {
    const compact = mediaBlock(720);

    expect(css).toMatch(/\.editor-command-row\s*\{/);
    expect(css).toMatch(/\.draft-ledger\s*\{/);
    expect(css).toMatch(/\.editor-section-index[^}]*min-height:\s*44px/s);
    expect(compact).not.toBe("");
    expect(rule(".editor-workspace")).toMatch(/grid-template-columns:/);
    expect(rule(".draft-ledger-details")).toMatch(/grid-template-columns:/);
    expect(rule(".draft-ledger")).toMatch(/position:\s*sticky/);
    expect(rule(".draft-ledger")).toMatch(/bottom:\s*0/);
    expect(rule(".draft-ledger-summary")).toMatch(/grid-template-columns:[^;]*auto\s+auto/);
    expect(compact).toMatch(/\.editor-section-index\s*\{[^}]*flex-direction:\s*row[^}]*overflow-x:\s*auto/s);
    expect(compact).toMatch(/\.editor-readonly-context\s*\{[^}]*grid-column:\s*1[^}]*border-top:\s*1px solid var\(--rule\)[^}]*border-left:\s*0/s);
    expect(compact).toMatch(/\.draft-ledger-summary \.editor-save-cell\s*\{[^}]*grid-column:\s*2[^}]*border-top:\s*1px solid var\(--rule\)/s);
    expect(compact).toMatch(/\.draft-ledger-details\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  it("keeps immutable context and advanced recovery actions readable", () => {
    expect(rule(".editor-readonly-context")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".editor-readonly-context p")).toMatch(/margin:\s*0/);
    expect(rule(".advanced-json-actions")).toMatch(/display:\s*flex/);
    expect(rule(".advanced-json-actions")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("gives disclosure and cover choices explicit aligned touch targets", () => {
    expect(rule(".advanced-json summary")).toMatch(/min-height:\s*(?:44px|[3-9]\dpx)/);
    expect(rule(".advanced-json summary")).toMatch(/display:\s*flex/);
    expect(rule(".advanced-json summary")).toMatch(/align-items:\s*center/);
    expect(rule(".cover-editor fieldset label")).toMatch(/min-height:\s*(?:44px|[3-9]\dpx)/);
    expect(rule(".cover-editor fieldset label")).toMatch(/display:\s*flex/);
    expect(rule(".cover-editor fieldset label")).toMatch(/align-items:\s*center/);
  });

  it("uses semantic colors and a theme-invariant overlay throughout editor selectors", () => {
    const editorRules = [...css.matchAll(/([^{}]*(?:editor|draft-ledger|collection|cover-artwork|field-error|advanced-json|structured-fields|save-conflict)[^{}]*)\{([^{}]*)\}/g)];
    const literalColors = editorRules.flatMap(([, selector, declarations]) =>
      [...declarations.matchAll(/#[\da-f]{3,8}\b|\brgba?\s*\(|\bcolor-mix\s*\(/gi)]
        .map((match) => `${selector.trim()}: ${match[0]}`)
    );

    expect(editorRules.length).toBeGreaterThan(0);
    expect(literalColors).toEqual([]);
    expect(rule(".cover-artwork::after")).toMatch(/var\(--artwork-overlay\)/);
  });

  it("makes section, drawer, collection, and invalid field states visible", () => {
    const focusedEditorFields = rule(".editor-field input:focus-visible, .editor-field textarea:focus-visible");
    const focusedInvalidFields = rule([
      '.editor-field input[aria-invalid="true"]:focus-visible',
      '.editor-field textarea[aria-invalid="true"]:focus-visible',
      '.advanced-json textarea[aria-invalid="true"]:focus-visible',
      '.cover-editor input[aria-invalid="true"]:focus-visible'
    ].join(", "));

    expect(css).toMatch(/\.editor-section-index button:focus-visible/);
    expect(css).toMatch(/\.draft-ledger button:focus-visible/);
    expect(css).toMatch(/\.collection-(?:toolbar|master|detail)[^{}]*:focus-visible/s);
    expect(css).toMatch(/\[aria-invalid="true"\][^{]*\{[^}]*border-color:\s*var\(--status-error\)/s);
    expect(css).toMatch(/\.field-error\s*\{[^}]*color:\s*var\(--status-error\)/s);
    expect(focusedEditorFields).toMatch(/outline:\s*3px solid var\(--accent\)/);
    expect(focusedEditorFields).toMatch(/box-shadow:\s*none/);
    expect(focusedInvalidFields).toMatch(/outline:\s*3px solid var\(--accent\)/);
  });

  it("removes drawer motion when reduced motion is requested", () => {
    const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)$/)?.[1] ?? "";

    expect(rule(".draft-ledger-details")).toMatch(/transition:/);
    expect(reducedMotion).toMatch(/\.draft-ledger-details\s*\{[^}]*transition:\s*none/s);
  });

  it("persists the editor patterns and selected surface direction", () => {
    const designMarkdown = fs.readFileSync(path.join(webNextRoot, "DESIGN.md"), "utf8");
    const design = JSON.parse(fs.readFileSync(path.join(webNextRoot, ".impeccable/design.json"), "utf8"));
    const surface = fs.readFileSync(
      path.join(webNextRoot, ".impeccable/surfaces/src-world-editor-page-ts.md"),
      "utf8"
    );
    const componentNames = design.components.map((component: { name: string }) => component.name);

    for (const name of [
      "Editor Command Row",
      "Section Index",
      "Master-Detail Collection Editor",
      "Editor Field and Error",
      "Draft Ledger"
    ]) {
      expect(designMarkdown).toContain(`### ${name}`);
      expect(componentNames).toContain(name);
    }
    expect(surface).toMatch(/mode:\s*Operate/i);
    expect(surface).toMatch(/draft-only/i);
    expect(surface).toMatch(/Bottom Drawer/i);
    expect(surface).toMatch(/loading[\s\S]*empty[\s\S]*validation[\s\S]*conflict/i);
    expect(surface).toMatch(/horizontal section switcher/i);
  });
});
