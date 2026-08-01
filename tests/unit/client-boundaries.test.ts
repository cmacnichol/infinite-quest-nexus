import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createNoopSessionPort } from "../../packages/client-web/src/index.js";
import type { PendingGenerationSubmission, SessionPort } from "../../packages/client-core/src/index.js";
import type { GenerationRequest } from "../../packages/contracts/src/generation.js";
// @ts-expect-error JavaScript check scripts intentionally have no declaration files.
import { collectClientBoundaryViolations, isBoundarySourceFile } from "../../scripts/check-client-boundaries.mjs";
// @ts-expect-error JavaScript check scripts intentionally have no declaration files.
import { formatWebBundleBudgetReport, inspectWebBundleBudget } from "../../scripts/check-web-bundle-budget.mjs";

describe("client boundary checks", () => {
  test("rejects client-core Web, Node, and framework dependencies", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-core/src/forbidden-dependencies.ts",
        text: `
          import { readFile } from "node:fs/promises";
          import { createRoot } from "react-dom/client";
          export const dependencies = [fetch, EventSource, localStorage, document, window, readFile, createRoot];
        `
      }
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      "packages/client-core/src/forbidden-dependencies.ts: client-core import node:fs/promises is prohibited",
      "packages/client-core/src/forbidden-dependencies.ts: client-core import react-dom/client is a prohibited framework dependency",
      "packages/client-core/src/forbidden-dependencies.ts: client-core must not use platform global EventSource",
      "packages/client-core/src/forbidden-dependencies.ts: client-core must not use platform global document",
      "packages/client-core/src/forbidden-dependencies.ts: client-core must not use platform global fetch",
      "packages/client-core/src/forbidden-dependencies.ts: client-core must not use platform global localStorage",
      "packages/client-core/src/forbidden-dependencies.ts: client-core must not use platform global window"
    ]));
  });

  test("allows framework-free client-web adapters to use Web APIs behind core ports", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-web/src/adapters.ts",
        text: `
          import type { Clock, DelayScheduler, IdFactory, PendingSubmissionStore } from "../../client-core/src/ports.js";

          export const clock: Clock = { now: () => Date.now() };
          export const ids: IdFactory = { create: () => crypto.randomUUID() };
          export const delays: DelayScheduler = {
            wait: (milliseconds, signal) => new Promise((resolve) => {
              if (signal.aborted) return resolve();
              setTimeout(resolve, milliseconds);
            })
          };
          export const pending: PendingSubmissionStore = {
            load: (campaignId) => JSON.parse(localStorage.getItem(campaignId) || "null"),
            save: (campaignId, submission) => localStorage.setItem(campaignId, JSON.stringify(submission)),
            clear: (campaignId) => localStorage.removeItem(campaignId)
          };
          export const events = (url: string) => new EventSource(url);
        `
      }
    ]);

    expect(violations).toEqual([]);
  });

  test("no-op session port neither supplies credentials nor retries unauthorized responses", async () => {
    const session: SessionPort = createNoopSessionPort();
    const request: GenerationRequest = {
      action: "Search the observatory for clues.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit",
      idempotencyKey: "submission-key-0001",
      context: { budgetTokens: 32000, compression: "auto", recentTurns: 8 }
    };
    const submission: PendingGenerationSubmission = {
      request,
      operationKind: "append",
      expectedTurnNumber: 7,
      createdAt: 1_725_000_000_000
    };

    expect(await session.authorization()).toEqual({});
    expect(await session.onUnauthorized({ statusCode: 401 })).toBe(false);
    expect(await session.onUnauthorized({ statusCode: 403 })).toBe(false);
    expect(submission.request.idempotencyKey).toBe("submission-key-0001");
  });

  test("reports without failing before the Slice 1 Vite output exists", () => {
    expect(inspectWebBundleBudget("/missing-vite-output")).toEqual({
      mode: "report-only",
      reason: "apps/web-next/dist/.vite/manifest.json is not present"
    });
  });

  test("reports parsed entry and lazy Vite chunks with their gzip sizes", () => {
    const rootDirectory = mkdtempSync(path.join(tmpdir(), "infinite-quest-bundle-"));
    const distDirectory = path.join(rootDirectory, "apps/web-next/dist");
    const entryContents = "export const entry = 'nexus';";
    const lazyContents = "export const lazy = 'quest';";

    try {
      mkdirSync(path.join(distDirectory, ".vite"), { recursive: true });
      mkdirSync(path.join(distDirectory, "assets"), { recursive: true });
      writeFileSync(path.join(distDirectory, "assets/main.js"), entryContents);
      writeFileSync(path.join(distDirectory, "assets/lazy.js"), lazyContents);
      writeFileSync(path.join(distDirectory, ".vite/manifest.json"), JSON.stringify({
        "src/lazy.ts": { file: "assets/lazy.js", isDynamicEntry: true },
        "src/main.ts": { file: "assets/main.js", isEntry: true }
      }));

      const result = inspectWebBundleBudget(rootDirectory);

      expect(result).toMatchObject({ mode: "report-only" });
      expect(result.chunks).toEqual([
        { source: "src/lazy.ts", kind: "lazy", gzipBytes: gzipSync(lazyContents).byteLength },
        { source: "src/main.ts", kind: "entry", gzipBytes: gzipSync(entryContents).byteLength }
      ]);
      expect(formatWebBundleBudgetReport(result)).toContain("src/main.ts: entry");
      expect(formatWebBundleBudgetReport(result)).toContain("src/lazy.ts: lazy");
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("discovers every supported JavaScript and TypeScript source extension", () => {
    for (const file of ["view.js", "view.cjs", "view.mjs", "view.jsx", "view.ts", "view.cts", "view.mts", "view.tsx"]) {
      expect(isBoundarySourceFile(`packages/client-web/src/${file}`)).toBe(true);
    }
    expect(isBoundarySourceFile("packages/client-web/src/view.css")).toBe(false);
  });

  test("rejects client-core platform globals while ignoring their spelling in comments and strings", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-core/src/workflow.ts",
        text: `
          // window and document are not dependencies here.
          const description = "fetch after a timer";
          export const schedule = () => setTimeout(() => undefined, 10);
        `
      }
    ]);

    expect(violations).toEqual([
      "packages/client-core/src/workflow.ts: client-core must not use platform global setTimeout"
    ]);
  });

  test("allows client-core imports from its own package and contracts", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-core/src/workflow.ts",
        text: `
          import { message } from "./message.js";
          import type { Campaign } from "../../contracts/src/index.js";
          export { message };
          export type { Campaign };
        `
      }
    ]);

    expect(violations).toEqual([]);
  });

  test("rejects client-core imports outside its pure dependency boundary", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-core/src/workflow.ts",
        text: 'import { request } from "../../client-web/src/http.js";'
      },
      {
        file: "packages/client-core/src/node.ts",
        text: 'import { readFile } from "node:fs/promises";'
      }
    ]);

    expect(violations).toEqual([
      "packages/client-core/src/node.ts: client-core import node:fs/promises is prohibited",
      "packages/client-core/src/workflow.ts: client-core import ../../client-web/src/http.js is outside client-core or contracts"
    ]);
  });

  test("rejects client-core Node globals and CommonJS, dynamic, and import-type loading", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-core/src/node.mts",
        text: `
          export type NodeStats = import("node:fs").Stats;
          const buffer = Buffer.alloc(1);
          const directory = __dirname;
          const filename = __filename;
          const filesystem = require("node:fs");
          const pathModule = import(\`node:path\`);
          export { buffer, directory, filename, filesystem, pathModule };
        `
      }
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      "packages/client-core/src/node.mts: client-core import node:fs is prohibited",
      "packages/client-core/src/node.mts: client-core import node:path is prohibited",
      "packages/client-core/src/node.mts: client-core must not use platform global Buffer",
      "packages/client-core/src/node.mts: client-core must not use platform global __dirname",
      "packages/client-core/src/node.mts: client-core must not use platform global __filename",
      "packages/client-core/src/node.mts: client-core must not use platform global require"
    ]));
  });

  test("rejects client-web framework imports and DOM rendering while allowing Web state inspection", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-web/src/http.ts",
        text: `
          import { createRoot } from "react-dom/client";
          export const hidden = document.visibilityState === "hidden";
          export const render = () => document.createElement("section");
        `
      }
    ]);

    expect(violations).toEqual([
      "packages/client-web/src/http.ts: client-web import react-dom/client is a prohibited framework dependency",
      "packages/client-web/src/http.ts: client-web must not manipulate rendered DOM via createElement"
    ]);
  });

  test("rejects indirect client-web DOM method calls and property writes", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-web/src/dom.tsx",
        text: `
          const element = document.querySelector("#root");
          element?.appendChild(document.createElement("section"));
          document.body.replaceChildren(element);
          element.innerHTML = "<main>Unsafe</main>";
        `
      }
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      "packages/client-web/src/dom.tsx: client-web must not manipulate rendered DOM via appendChild",
      "packages/client-web/src/dom.tsx: client-web must not manipulate rendered DOM via replaceChildren",
      "packages/client-web/src/dom.tsx: client-web must not manipulate rendered DOM property innerHTML"
    ]));
  });

  test("rejects client-web imports outside its adapter boundary", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "packages/client-web/src/http.ts",
        text: 'import { createServer } from "../../../services/api/src/server.js";'
      }
    ]);

    expect(violations).toEqual([
      "packages/client-web/src/http.ts: client-web import ../../../services/api/src/server.js is outside client-web, client-core, or contracts"
    ]);
  });

  test("rejects unapproved API and worker cross-role imports but permits documented transitional imports", () => {
    const violations = collectClientBoundaryViolations([
      {
        file: "services/worker/src/worker.ts",
        text: 'import { claimGeneration } from "../../api/src/generation-service.js";'
      },
      {
        file: "services/worker/src/new-worker.ts",
        text: 'import { createServer } from "../../api/src/server.js";'
      },
      {
        file: "services/api/src/route.ts",
        text: 'import { runWorker } from "../../worker/src/worker.js";'
      }
    ]);

    expect(violations).toEqual([
      "services/api/src/route.ts: cross-role import ../../worker/src/worker.js from api to worker is prohibited",
      "services/worker/src/new-worker.ts: cross-role import ../../api/src/server.js from worker to api is prohibited"
    ]);
  });
});
