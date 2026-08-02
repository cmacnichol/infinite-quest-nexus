import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

const rootDirectory = process.cwd();

function localAssetPaths(html: string, prefix: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value?.startsWith(prefix) === true)
    .map((value) => value.slice(prefix.length));
}

describe("web build contract", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: "pipe"
    });
  }, 60_000);

  test("legacy build emits its HTML assets and stable compiled entry", () => {
    const distDirectory = path.join(rootDirectory, "apps/web/dist");
    const html = readFileSync(path.join(distDirectory, "index.html"), "utf8");

    expect(localAssetPaths(html, "/nexus/")).not.toEqual([]);
    for (const assetPath of localAssetPaths(html, "/nexus/")) {
      expect(existsSync(path.join(distDirectory, assetPath)), assetPath).toBe(true);
    }
    expect(existsSync(path.join(distDirectory, "legacy-client.js"))).toBe(true);
  });

  test("replacement build emits HTML whose hashed assets exist", () => {
    const distDirectory = path.join(rootDirectory, "apps/web-next/dist");
    const html = readFileSync(path.join(distDirectory, "index.html"), "utf8");
    const assetPaths = localAssetPaths(html, "/app/");

    expect(assetPaths).not.toEqual([]);
    for (const assetPath of assetPaths) {
      expect(existsSync(path.join(distDirectory, assetPath)), assetPath).toBe(true);
    }
  });
});
