import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const activeFiles = [
  "apps/web/public/index.html",
  "apps/web/public/story.html",
  "apps/web-next/index.html",
  "apps/web/public/nexus.js",
  "apps/web/src/story.js"
];

describe("active UI CSP compatibility", () => {
  it("contains no inline styles, event handlers, or generated style blocks", () => {
    for (const file of activeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\sstyle\s*=/i);
      expect(source, file).not.toMatch(/\son[a-z]+\s*=/i);
      expect(source, file).not.toMatch(/<style\b/i);
      expect(source, file).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    }
  });
});
