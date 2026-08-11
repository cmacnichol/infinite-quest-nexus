import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webNextRoot = path.resolve(import.meta.dirname, "../../apps/web-next");
const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("World Editor design contract", () => {
  it("composes the Draft Ledger workspace for desktop and compact screens", () => {
    expect(css).toMatch(/\.editor-command-row\s*\{/);
    expect(css).toMatch(/\.draft-ledger\s*\{/);
    expect(css).toMatch(/\.editor-section-index[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)/);
    expect(rule(".editor-workspace")).toMatch(/grid-template-columns:/);
    expect(rule(".draft-ledger-details")).toMatch(/grid-template-columns:/);
  });

  it("uses semantic colors and a theme-invariant overlay throughout editor selectors", () => {
    const editorRules = [...css.matchAll(/([^{}]*(?:editor|draft-ledger|collection|cover-artwork)[^{}]*)\{([^{}]*)\}/g)];
    const literalColors = editorRules.flatMap(([, selector, declarations]) =>
      [...declarations.matchAll(/#[\da-f]{3,8}\b|\brgba?\s*\(|\bcolor-mix\s*\(/gi)]
        .map((match) => `${selector.trim()}: ${match[0]}`)
    );

    expect(editorRules.length).toBeGreaterThan(0);
    expect(literalColors).toEqual([]);
    expect(rule(".cover-artwork::after")).toMatch(/var\(--artwork-overlay\)/);
  });

  it("makes section, drawer, collection, and invalid field states visible", () => {
    expect(css).toMatch(/\.editor-section-index button:focus-visible/);
    expect(css).toMatch(/\.draft-ledger button:focus-visible/);
    expect(css).toMatch(/\.collection-(?:toolbar|master|detail)[^{}]*:focus-visible/s);
    expect(css).toMatch(/\[aria-invalid="true"\][^{]*\{[^}]*border-color:\s*var\(--status-error\)/s);
    expect(css).toMatch(/\.field-error\s*\{[^}]*color:\s*var\(--status-error\)/s);
  });

  it("removes drawer motion when reduced motion is requested", () => {
    const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)$/)?.[1] ?? "";

    expect(rule(".draft-ledger-details")).toMatch(/transition:/);
    expect(reducedMotion).toMatch(/\.draft-ledger-details/);
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
