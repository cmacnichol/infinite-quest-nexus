import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import { authoringHash, authoringResult, authoringRuntimeFixture, deferred } from "../helpers/authoring-runtime.js";
import fixture from "../fixtures/authoring/reliability.json" with { type: "json" };
import { ProviderHttpError } from "../../packages/story-engine/src/providers.js";

afterEach(() => vi.useRealTimers());

describe("runtime authoring worker composition", () => {
  function actualRuntime(execute = vi.fn(async () => authoringResult(JSON.stringify(fixture.character)))) {
    const runtime = authoringRuntimeFixture(execute);
    const claim = { jobId: "job", stageId: "stage", ownerUserId: "owner", jobGeneration: 1, stageGeneration: 1, leaseToken: "token", leaseExpiresAt: "2026-09-06T00:00:30.000Z" };
    const loaded = { input: runtime.input, snapshot: runtime.snapshot, stageKey: "character:hero", parentOutputs: [] };
    const repository = { claim: vi.fn(async () => claim), loadClaim: vi.fn(async (_claim: typeof claim) => loaded), heartbeat: vi.fn(async () => true), checkpoint: vi.fn(async () => true), fail: vi.fn(async () => true) };
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const application = createRuntimeAuthoringWorkerApplication({ repository: repository as never, providers: runtime.providers, signal: controller.signal, sha256: authoringHash });
    return { ...runtime, claim, loaded, repository, controller, removed, application, execute };
  }

  it.each(["abort", "heartbeat false", "heartbeat error"])("blocks a paid request when %s occurs during the final awaited claim read", async (stop) => {
    vi.useFakeTimers();
    const runtime = actualRuntime();
    const reading = deferred<void>();
    const release = deferred<typeof runtime.loaded>();
    runtime.repository.loadClaim.mockResolvedValueOnce(runtime.loaded).mockResolvedValueOnce(runtime.loaded).mockImplementationOnce(() => { reading.resolve(); return release.promise; });
    const running = runtime.application.runNext({ workerId: "worker", leaseSeconds: 3 });
    await reading.promise;
    if (stop === "abort") runtime.controller.abort();
    else {
      if (stop === "heartbeat false") runtime.repository.heartbeat.mockResolvedValue(false);
      else runtime.repository.heartbeat.mockRejectedValue(new Error("heartbeat unavailable"));
      await vi.advanceTimersByTimeAsync(1000);
    }
    release.resolve(runtime.loaded);
    await expect(running).resolves.toBe(false);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.repository.checkpoint).not.toHaveBeenCalled();
    expect(runtime.repository.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["repair", "backoff", "acceptance"])("prevents subsequent provider work and checkpoint after heartbeat loss during %s", async (boundary) => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const release = deferred<void>();
    const execute = vi.fn(async () => {
      started.resolve();
      if (boundary === "backoff") throw new ProviderHttpError(429, 2000, "synthetic rate limit");
      await release.promise;
      return authoringResult(boundary === "repair" ? fixture.malformed : JSON.stringify(fixture.character));
    });
    const runtime = actualRuntime(execute);
    runtime.repository.heartbeat.mockRejectedValue(new Error("unavailable"));
    const running = runtime.application.runNext({ workerId: "worker", leaseSeconds: 3 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    // The database read still reports the lease current; local loss must win.
    expect(await runtime.repository.loadClaim(runtime.claim)).toEqual(runtime.loaded);
    release.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(running).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.repository.checkpoint).not.toHaveBeenCalled();
    expect(runtime.repository.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses each run's lease duration and never overlaps heartbeat transactions", async () => {
    vi.useFakeTimers();
    const release = deferred<void>();
    const started = deferred<void>();
    const runtime = actualRuntime(vi.fn(async () => { started.resolve(); await release.promise; return authoringResult(JSON.stringify(fixture.character)); }));
    const heartbeat = deferred<boolean>();
    runtime.repository.heartbeat.mockImplementationOnce(() => heartbeat.promise);
    const running = runtime.application.runNext({ workerId: "worker", leaseSeconds: 6 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1999);
    expect(runtime.repository.heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.repository.heartbeat).toHaveBeenCalledWith(runtime.claim, 6);
    await vi.advanceTimersByTimeAsync(10000);
    expect(runtime.repository.heartbeat).toHaveBeenCalledTimes(1);
    heartbeat.resolve(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(runtime.repository.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.repository.heartbeat).toHaveBeenCalledTimes(2);
    release.resolve();
    await expect(running).resolves.toBe(true);
    runtime.repository.heartbeat.mockClear();
    const secondRelease = deferred<void>();
    const secondStarted = deferred<void>();
    runtime.execute.mockImplementationOnce(async () => { secondStarted.resolve(); await secondRelease.promise; return authoringResult(JSON.stringify(fixture.character)); });
    const second = runtime.application.runNext({ workerId: "worker", leaseSeconds: 3 });
    await secondStarted.promise;
    await vi.advanceTimersByTimeAsync(999);
    expect(runtime.repository.heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.repository.heartbeat).toHaveBeenCalledWith(runtime.claim, 3);
    secondRelease.resolve();
    await expect(second).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans timer and listener after provider failure and ignores a heartbeat completing after execution", async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const release = deferred<void>();
    const heartbeat = deferred<boolean>();
    const runtime = actualRuntime(vi.fn(async () => {
      started.resolve();
      await release.promise;
      throw new ProviderHttpError(400, null, "synthetic rejection");
    }));
    runtime.repository.heartbeat.mockImplementationOnce(() => heartbeat.promise);
    const running = runtime.application.runNext({ workerId: "worker", leaseSeconds: 3 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    release.resolve();
    await expect(running).resolves.toBe(false);
    expect(runtime.repository.fail).toHaveBeenCalledWith(runtime.claim, expect.objectContaining({ code: "authoring_provider_rejected" }));
    expect(runtime.removed).toHaveBeenCalledWith("abort", expect.any(Function));
    heartbeat.resolve(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(runtime.repository.heartbeat).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pins the first resolved default provider, effective prompts, and canonical protocols", async () => {
    const claim = { jobId: "job", stageId: "stage", ownerUserId: "owner", jobGeneration: 1, stageGeneration: 1, leaseToken: "token", leaseExpiresAt: "2026-09-06T00:00:30.000Z" };
    const snapshot = { providerProfileId: "text-profile", model: "model-a", configurationHash: "a".repeat(64), contextWindowTokens: 8192, maxOutputTokens: 1024, requestTimeoutMs: 5000, prompts: {}, protocols: {} };
    const repository = {
      claim: vi.fn(async () => claim), heartbeat: vi.fn(async () => true), checkpoint: vi.fn(async () => true), fail: vi.fn(async () => true),
      loadClaim: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ input: { kind: "world_concept", prompt: "prompt" }, snapshot, stageKey: "world", parentOutputs: [] }),
      readClaimInput: vi.fn(async () => ({ kind: "world_concept", prompt: "prompt" })), initializeExecutionSnapshot: vi.fn(async () => snapshot)
    };
    const execution = { text: vi.fn(async () => ({ id: "text-profile", model: "model-a", contextWindowTokens: 8192, maxOutputTokens: 1024, requestTimeoutMs: 5000, temperature: 0.7, configuration: {}, execute: vi.fn() })) };
    const providers = {
      resolution: { resolveDirect: vi.fn(async () => ({ status: "resolved", providerProfileId: "text-profile", model: "model-a" })) },
      execution,
      prompts: { loadWorldGenerationPromptSnapshot: vi.fn(async () => ({ snapshot: { world_generation: { content: "effective world" }, world_generation_recovery: { content: "repair" }, world_character_generation: { content: "character" }, world_character_generation_recovery: { content: "character repair" }, character_generation: { content: "standalone" } } })) },
      promptTools: { content: (snapshot: any, key: string) => snapshot[key]?.content ?? "" }
    };
    const application = createRuntimeAuthoringWorkerApplication({ repository: repository as never, providers: providers as never, sha256: () => "a".repeat(64), dispatch: vi.fn(async () => null as never) });

    await application.runNext({ workerId: "worker", leaseSeconds: 30 });
    expect(providers.resolution.resolveDirect).toHaveBeenCalledWith({ ownerUserId: "owner", providerRole: "text" });
    expect(providers.prompts.loadWorldGenerationPromptSnapshot).toHaveBeenCalledWith({ ownerUserId: "owner", worldId: "job" });
    expect(repository.initializeExecutionSnapshot).toHaveBeenCalledWith(claim, expect.objectContaining({
      providerProfileId: "text-profile",
      model: "model-a",
      prompts: expect.objectContaining({ world_generation: "effective world", character_generation: "standalone" }),
      protocols: expect.objectContaining({ world: expect.any(String), character: expect.any(String) })
    }));
  });

  it("does not claim after runtime shutdown has started", async () => {
    const controller = new AbortController();
    controller.abort();
    const repository = { claim: vi.fn(), heartbeat: vi.fn(), checkpoint: vi.fn(), fail: vi.fn() };
    const application = createRuntimeAuthoringWorkerApplication({
      repository: repository as never, signal: controller.signal, sha256: () => "a".repeat(64),
      providers: {} as never
    });
    await expect(application.runNext({ workerId: "worker", leaseSeconds: 30 })).resolves.toBe(false);
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it.each([false, new Error("heartbeat failed")])("stops guarded work when heartbeat returns or throws %p", async (heartbeatResult) => {
    const claim = { jobId: "job", stageId: "stage", ownerUserId: "owner", jobGeneration: 1, stageGeneration: 1, leaseToken: "token", leaseExpiresAt: "2026-09-06T00:00:30.000Z" };
    const loaded = { input: { kind: "character", prompt: "prompt", target: { kind: "new_world" }, content: {} }, snapshot: { providerProfileId: "p", model: "m", configurationHash: "a".repeat(64), contextWindowTokens: 1, maxOutputTokens: 1, requestTimeoutMs: 1, prompts: {}, protocols: {} }, stageKey: "character:hero", parentOutputs: [] };
    const repository = { claim: vi.fn(async () => claim), heartbeat: vi.fn(async () => { if (heartbeatResult instanceof Error) throw heartbeatResult; return heartbeatResult; }), checkpoint: vi.fn(async () => true), fail: vi.fn(async () => true), loadClaim: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(loaded), readClaimInput: vi.fn(async () => loaded.input), initializeExecutionSnapshot: vi.fn(async () => loaded.snapshot) };
    const application = createRuntimeAuthoringWorkerApplication({ repository: repository as never, providers: { resolution: { resolveDirect: vi.fn(async () => ({ status: "resolved", providerProfileId: "p", model: "m" })) }, execution: { text: vi.fn(async () => ({ id: "p", model: "m", contextWindowTokens: 1, maxOutputTokens: 1, requestTimeoutMs: 1, temperature: 0, configuration: {} })) }, prompts: { loadWorldGenerationPromptSnapshot: vi.fn(async () => ({ snapshot: {} })) }, promptTools: { content: () => "" } } as never, sha256: () => "a".repeat(64), heartbeatMilliseconds: 1, dispatch: async (stage) => { await new Promise((resolve) => setTimeout(resolve, 5)); if (!await stage.currentClaim!()) throw { authoringFailure: { code: "authoring_cancelled", stage: "character", retryable: false, issues: [] } }; throw new Error("guard did not stop"); } });
    await expect(application.runNext({ workerId: "worker", leaseSeconds: 1 })).resolves.toBe(false);
    expect(repository.heartbeat).toHaveBeenCalledWith(claim, 1);
    expect(repository.checkpoint).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("disposes its heartbeat timer and abort listener after a completed execution", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const claim = { jobId: "job", stageId: "stage", ownerUserId: "owner", jobGeneration: 1, stageGeneration: 1, leaseToken: "token", leaseExpiresAt: "2026-09-06T00:00:30.000Z" };
    const output = { kind: "character", character: { id: "hero", name: "Hero" } } as never;
    const repository = { claim: vi.fn(async () => claim), heartbeat: vi.fn(async () => true), checkpoint: vi.fn(async () => true), fail: vi.fn(async () => true), loadClaim: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ input: { kind: "character" }, snapshot: {}, stageKey: "character:hero", parentOutputs: [] }), readClaimInput: vi.fn(async () => ({ kind: "character" })), initializeExecutionSnapshot: vi.fn(async () => ({})) };
    const application = createRuntimeAuthoringWorkerApplication({ repository: repository as never, providers: { resolution: { resolveDirect: vi.fn(async () => ({ status: "resolved", providerProfileId: "p", model: "m" })) }, execution: { text: vi.fn(async () => ({ id: "p", model: "m", contextWindowTokens: 1, maxOutputTokens: 1, requestTimeoutMs: 1, temperature: 0, configuration: {} })) }, prompts: { loadWorldGenerationPromptSnapshot: vi.fn(async () => ({ snapshot: {} })) }, promptTools: { content: () => "" } } as never, signal: controller.signal, sha256: () => "a".repeat(64), heartbeatMilliseconds: 1, dispatch: vi.fn(async () => output) });
    await expect(application.runNext({ workerId: "worker", leaseSeconds: 1 })).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
