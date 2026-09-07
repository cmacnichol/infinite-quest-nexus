import { describe, expect, it, vi } from "vitest";
import { createAuthoringWorkerApplication } from "../../packages/application/src/authoring/worker.js";
import type { AuthoringClaim, AuthoringExecutionRepository } from "../../packages/application/src/authoring/ports.js";

const claim: AuthoringClaim = {
  jobId: "00000000-0000-4000-8000-000000000001",
  stageId: "00000000-0000-4000-8000-000000000002",
  ownerUserId: "00000000-0000-4000-8000-000000000003",
  jobGeneration: 1,
  stageGeneration: 1,
  leaseToken: "00000000-0000-4000-8000-000000000004",
  leaseExpiresAt: "2026-09-06T00:00:30.000Z"
};

function repository(overrides: Partial<AuthoringExecutionRepository> = {}): AuthoringExecutionRepository {
  return {
    claim: vi.fn(async () => claim),
    checkpoint: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    cleanupAuthoring: vi.fn(async () => 0),
    heartbeat: vi.fn(async () => true),
    readClaimInput: vi.fn(),
    initializeExecutionSnapshot: vi.fn(),
    loadClaim: vi.fn(),
    findIdempotency: vi.fn(), submit: vi.fn(), read: vi.fn(), list: vi.fn(), review: vi.fn(), retry: vi.fn(), cancel: vi.fn(), discard: vi.fn(),
    ...overrides
  } as never;
}

describe("authoring worker application", () => {
  it("runs bounded retention cleanup without claiming generation", async () => {
    const store = repository();
    const application = createAuthoringWorkerApplication({ repository: store, execute: vi.fn() });

    await expect(application.cleanup()).resolves.toBe(0);
    expect(store.cleanupAuthoring).toHaveBeenCalledWith({ batchSize: 100 });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("claims one stage and checkpoints the executor's validated output", async () => {
    const store = repository();
    const output = { kind: "character", character: { id: "hero", name: "Hero" } } as never;
    const execute = vi.fn(async () => output);
    const application = createAuthoringWorkerApplication({ repository: store, execute });

    await expect(application.runNext({ workerId: "worker-a", leaseSeconds: 30 })).resolves.toBe(true);
    expect(store.claim).toHaveBeenCalledWith("worker-a", 30);
    expect(execute).toHaveBeenCalledWith(claim, { workerId: "worker-a", leaseSeconds: 30 });
    expect(store.checkpoint).toHaveBeenCalledWith(claim, output);
  });

  it("does not overwrite a stage when a fenced executor returns no output", async () => {
    const store = repository();
    const application = createAuthoringWorkerApplication({ repository: store, execute: vi.fn(async () => null) });

    await expect(application.runNext({ workerId: "worker-a", leaseSeconds: 30 })).resolves.toBe(false);
    expect(store.checkpoint).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("projects a typed execution failure through the repository fence", async () => {
    const store = repository();
    const application = createAuthoringWorkerApplication({
      repository: store,
      execute: vi.fn(async () => { throw { authoringFailure: { code: "authoring_provider_unavailable", stage: "world", retryable: true, issues: [] } }; })
    });

    await expect(application.runNext({ workerId: "worker-a", leaseSeconds: 30 })).resolves.toBe(false);
    expect(store.fail).toHaveBeenCalledWith(claim, {
      code: "authoring_provider_unavailable", stage: "world", retryable: true, issues: []
    });
  });
});
