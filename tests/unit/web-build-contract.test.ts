import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

const rootDirectory = process.cwd();
const activeUiImplementationFiles = [
  "apps/web/public/index.html",
  "apps/web/public/nexus.js",
  "apps/web/public/nexus.css",
  "apps/web/src/story.js",
  "apps/web-next/src/campaign-editor-page.ts",
  "apps/web-next/src/styles.css"
] as const;

function localAssetPaths(html: string, prefix: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value?.startsWith(prefix) === true)
    .map((value) => value.slice(prefix.length));
}

describe("web build contract", () => {
  beforeAll(() => {
    execSync("pnpm build:web:legacy && pnpm build:web:next", {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: "pipe"
    });
  }, 60_000);

  test("legacy build emits its HTML assets and stable compiled entry", () => {
    const distDirectory = path.join(rootDirectory, "apps/web/dist");
    const html = readFileSync(path.join(distDirectory, "index.html"), "utf8");
    const storyHtml = readFileSync(path.join(distDirectory, "story.html"), "utf8");

    expect(localAssetPaths(html, "/nexus/")).not.toEqual([]);
    for (const assetPath of localAssetPaths(html, "/nexus/")) {
      expect(existsSync(path.join(distDirectory, assetPath)), assetPath).toBe(true);
    }
    expect(existsSync(path.join(distDirectory, "legacy-client.js"))).toBe(true);
    expect(storyHtml).toContain('src="/nexus/legacy-client.js"');
    expect(existsSync(path.join(distDirectory, "story.js"))).toBe(false);
    const emitted = [html, storyHtml, ...Array.from(new Set([...localAssetPaths(html, "/nexus/"), ...localAssetPaths(storyHtml, "/nexus/")]))
      .filter((assetPath) => assetPath.endsWith(".js"))
      .map((assetPath) => readFileSync(path.join(distDirectory, assetPath), "utf8"))].join("\n");
    expect(emitted).toContain("Semantic Retrieval");
    expect(emitted).toContain("embeddingRetrievalImplementation");
    expect(emitted).toContain("embeddingRetrievalShadowEnabled");
    expect(emitted).toContain("retrievalImplementation");
    expect(emitted).toContain("retrievalShadowEnabled");
    expect(emitted).toContain("Chronicle retrieval");
    expect(emitted).toContain("this turn predates retrieval auditing");
  });

  test("replacement build emits HTML whose hashed assets exist", () => {
    const distDirectory = path.join(rootDirectory, "apps/web-next/dist");
    const html = readFileSync(path.join(distDirectory, "index.html"), "utf8");
    const assetPaths = localAssetPaths(html, "/app/");
    const themeBootstrapPath = "theme-bootstrap.js";

    expect(assetPaths).not.toEqual([]);
    expect(assetPaths).toContain(themeBootstrapPath);
    expect(existsSync(path.join(distDirectory, themeBootstrapPath))).toBe(true);
    expect(html.indexOf(`/app/${themeBootstrapPath}`)).toBeLessThan(html.indexOf('type="module"'));
    for (const assetPath of assetPaths) {
      expect(existsSync(path.join(distDirectory, assetPath)), assetPath).toBe(true);
    }
    const emitted = [html, ...assetPaths.filter((assetPath) => assetPath.endsWith(".js"))
      .map((assetPath) => readFileSync(path.join(distDirectory, assetPath), "utf8"))].join("\n");
    expect(emitted).toContain("Semantic Retrieval");
    expect(emitted).toContain("retrievalImplementation");
    expect(emitted).toContain("retrievalShadowEnabled");
    expect(emitted).toContain("Chronicle retrieval");
    expect(emitted).toContain("this turn predates retrieval auditing");
  });

  test("replacement build keeps the Story entry in its hashed SPA asset graph", () => {
    const distDirectory = path.join(rootDirectory, "apps/web-next/dist");
    const html = readFileSync(path.join(distDirectory, "index.html"), "utf8");
    const assetPaths = localAssetPaths(html, "/app/").filter((assetPath) => assetPath.endsWith(".js"));
    const emitted = assetPaths
      .map((assetPath) => readFileSync(path.join(distDirectory, assetPath), "utf8"))
      .join("\n");

    expect(assetPaths).not.toEqual([]);
    expect(emitted).toContain("/app/story");
    expect(emitted).toContain("Campaign Tools");
  });

  test("keeps the reference-only root client outside the active UI implementation set", () => {
    expect(activeUiImplementationFiles).not.toContain("index.html");
    expect(activeUiImplementationFiles).toHaveLength(6);
  });
});
