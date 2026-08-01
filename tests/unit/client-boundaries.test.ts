import { describe, expect, test } from "vitest";
// @ts-expect-error JavaScript check scripts intentionally have no declaration files.
import { collectClientBoundaryViolations } from "../../scripts/check-client-boundaries.mjs";
// @ts-expect-error JavaScript check scripts intentionally have no declaration files.
import { inspectWebBundleBudget } from "../../scripts/check-web-bundle-budget.mjs";

describe("client boundary checks", () => {
  test("reports without failing before the Slice 1 Vite output exists", () => {
    expect(inspectWebBundleBudget("/missing-vite-output")).toEqual({
      mode: "report-only",
      reason: "apps/web-next/dist/.vite/manifest.json is not present"
    });
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
      "packages/client-web/src/http.ts: client-web must not manipulate rendered DOM via document.createElement"
    ]);
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
