import { describe, expect, it, vi } from "vitest";
import type { RuntimeLifecycleDependencies } from "../../services/runtime/src/lifecycle.js";
import type { RuntimeRoleDependencies } from "../../services/runtime/src/runtime-role.js";
import { authoringResult, authoringRuntimeFixture } from "../helpers/authoring-runtime.js";
import { createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";

const seams = vi.hoisted(() => ({ lifecycle: vi.fn(), dispatch: vi.fn(), repository: vi.fn(), claim: vi.fn(async () => null) }));
vi.mock("../../packages/database/src/index.js", async (original) => ({
  ...await original<typeof import("../../packages/database/src/index.js")>(),
  loadRuntimeConfig: () => ({ role: "worker" })
}));
vi.mock("../../packages/database/src/authoring-job-repository.js", async (original) => ({
  ...await original<typeof import("../../packages/database/src/authoring-job-repository.js")>(),
  createPostgresAuthoringRepository: seams.repository
}));
vi.mock("../../services/runtime/src/lifecycle.js", () => ({ runRuntimeLifecycle: seams.lifecycle }));
vi.mock("../../services/runtime/src/runtime-role.js", () => ({ dispatchRuntimeRole: seams.dispatch }));

describe("production main authoring binding", () => {
  it("exposes only execution, model inventory, direct resolution and prompt capabilities to worker authoring", () => {
    const graph = createWorkerProviderApplicationComposition({} as never, { credentialSecret: "synthetic-test-secret", transport: {} as never });
    expect(Object.keys(graph.worldGeneration).sort()).toEqual(["execution", "inventory", "promptTools", "prompts", "resolution"]);
    expect(Object.keys(graph.worldGeneration.inventory).sort()).toEqual(["discoverCandidateModels", "listModels"]);
    expect(Object.keys(graph.worldGeneration.resolution)).toEqual(["resolveDirect"]);
    expect(graph).not.toHaveProperty("application");
    expect(graph).not.toHaveProperty("transaction");
    expect(graph.worldGeneration.resolution).not.toHaveProperty("createProfile");
  });
  it("passes the main graph's pool, provider collaborator and shutdown signal to the real runtime application", async () => {
    const before = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)]));
    try {
      await import("../../services/runtime/src/main.js");
      const dependencies = seams.lifecycle.mock.calls[0]![2] as RuntimeLifecycleDependencies;
      const pool = {} as never;
      const controller = new AbortController();
      await dependencies.dispatchRole({ role: "worker" } as never, pool, controller.signal, {} as never, undefined);
      const roles = seams.dispatch.mock.calls[0]![3] as RuntimeRoleDependencies;
      seams.repository.mockReturnValue({ claim: seams.claim });
      const runtime = authoringRuntimeFixture(async () => authoringResult("unused"));
      const application = roles.createWorkerAuthoring(pool, runtime.providers as never, controller.signal);
      await expect(application.runNext({ workerId: "main-worker", leaseSeconds: 17 })).resolves.toBe(false);
      expect(seams.repository).toHaveBeenCalledWith(pool);
      expect(seams.claim).toHaveBeenCalledWith("main-worker", 17);
      controller.abort();
      await expect(application.runNext({ workerId: "main-worker", leaseSeconds: 17 })).resolves.toBe(false);
      expect(seams.claim).toHaveBeenCalledTimes(1);
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        for (const listener of process.listeners(signal)) {
          if (!before.get(signal)!.includes(listener)) process.removeListener(signal, listener);
        }
      }
    }
  });
});
