import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const publicHtml = readFileSync("apps/web/public/index.html", "utf8");
const bridgeEntryPath = "apps/web/src/legacy-management-entry.ts";
const controllerSourcePath = "apps/web/src/nexus.js";
const publicControllerPath = "apps/web/public/nexus.js";
const bridgeSource = readFileSync(bridgeEntryPath, "utf8");
const controllerSource = existsSync(controllerSourcePath) ? readFileSync(controllerSourcePath, "utf8") : "";
const viteConfig = readFileSync("apps/web/vite.config.ts", "utf8");

describe("legacy management build contracts", () => {
  test("management HTML has one stable bridge startup entry", () => {
    const moduleScripts = [...publicHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/giu)]
      .map((match) => match[1]);

    expect(moduleScripts).toEqual(["/nexus/legacy-management.js"]);
    expect(publicHtml).not.toContain('src="/nexus/nexus.js"');
  });

  test("uses one authoritative source controller and removes the copied public controller", () => {
    expect(existsSync(controllerSourcePath)).toBe(true);
    expect(existsSync(publicControllerPath)).toBe(false);
    expect(controllerSource.length).toBeGreaterThan(0);
  });

  test("bridge starts management only behind the document sentinel and uses the canonical controller URL", () => {
    expect(bridgeSource).toMatch(/controllerUrl\s*=\s*["']\/nexus\/nexus\.js["']/u);
    expect(bridgeSource).toMatch(/typeof\s+document\s*!==?\s*["']undefined["']/u);
    expect(bridgeSource).toMatch(/import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*controllerUrl\s*\)/u);
    expect(bridgeSource).not.toMatch(/from\s+["']\.\/nexus\.js["']/u);
  });

  test("controller imports shared APIs directly and keeps the image browser as a lazy import", () => {
    expect(controllerSource).not.toMatch(/from\s+["']\/nexus\/legacy-management\.js["']/u);
    expect(controllerSource).toContain("@infinite-quest/client-core");
    expect(controllerSource).toContain("@infinite-quest/client-web");
    expect(controllerSource).toMatch(/import\s*\(\s*(?:\/\*\s*@vite-ignore\s*\*\/\s*)?(?:[A-Za-z_$][\w$]*|`[^`]*`)\s*\)/u);
    expect(controllerSource).toMatch(/image-library-browser\.js/u);
    expect(controllerSource).not.toMatch(/^\s*import\s+.*["']\/nexus\/image-library-browser\.js["']/mu);
    expect(controllerSource).not.toMatch(/Object\.assign\(\s*(?:window|globalThis)\b/u);
  });

  test("Vite stable development aliases re-export one canonical source module and emit stable names", () => {
    expect(viteConfig).toContain('response.end(`export * from "/nexus${entry}";`);');
    expect(viteConfig).toContain("/nexus/nexus.js");
    expect(viteConfig).toContain("/src/nexus.js");
    expect(viteConfig).toContain("/nexus/legacy-management.js");
    expect(viteConfig).toContain("legacy-management-entry.ts");
    expect(viteConfig).toMatch(/nexus["']?\s*:/u);
    expect(viteConfig).toMatch(/legacy-management["']?\s*:/u);
    expect(viteConfig).toMatch(/chunk\.name === "nexus"/u);
    expect(viteConfig).toContain('`${chunk.name}.js`');
    expect(viteConfig).toMatch(/chunk\.name === "legacy-management"/u);
  });

  test("bridge remains Node-safe and retains named compatibility exports", async () => {
    expect(typeof document).toBe("undefined");
    const bridge = await import("../../apps/web/src/legacy-management-entry.js");
    for (const name of [
      "createSelectionEditorState",
      "reduceSelectionEditor",
      "serializeSelectionEditorPatch",
      "createProviderPresetsApi",
      "createLegacySectionLoader",
      "createEditSession",
      "bindEditDialogDismissal",
      "requestEditDismissal"
    ] as const) {
      expect(typeof bridge[name], name).toBe("function");
    }
  });
});
