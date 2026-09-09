import { afterEach, describe, expect, it } from "vitest";
import {
  assertStoryOnlyRuntimeTarget,
  assertOwnedStoryOnlyDatabase,
  pollStoryOnlyRuntime,
  safeStoryOnlyRuntimeSummary,
  waitForStoryOnlyRuntimeReady,
  createStoryOnlyRuntimeLifecycle,
  createStoryOnlyRuntimeCleanup,
  closeStoryOnlyRuntimeInput,
  storyOnlyDockerCleanupNames,
  resolveStoryOnlyRuntimeRenderer,
  storyOnlyRuntimeDockerBuildArgs,
} from "../helpers/story-only-runtime-fixture.js";
import {
  createStoryOnlySyntheticProvider,
  storyOnlyNarrativeResponse,
} from "../helpers/story-only-synthetic-provider.js";

describe("story-only disposable runtime harness", () => {
  const providers: Array<Awaited<ReturnType<typeof createStoryOnlySyntheticProvider>>> = [];

  afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.close()));
  });

  it("accepts only the dedicated local base database target", () => {
    expect(assertStoryOnlyRuntimeTarget("postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test"))
      .toMatchObject({ host: "127.0.0.1", port: "15439", database: "infinitequest_storyonly_test" });
    expect(() => assertStoryOnlyRuntimeTarget("postgresql://test:secret@127.0.0.1:55432/infinitequest_test"))
      .toThrow("dedicated");
    expect(() => assertStoryOnlyRuntimeTarget("postgresql://test:secret@provider.example:15439/infinitequest_storyonly_test"))
      .toThrow("dedicated");
  });

  it("queues a validated control scenario and reports its observed completion request", async () => {
    const provider = await createStoryOnlySyntheticProvider();
    providers.push(provider);
    const queued = {
      content: "The bell rings twice from the sealed platform.",
      finishReason: "length" as const
    };
    const scenario = await fetch(`${provider.baseUrl}/__scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(queued)
    });
    expect(scenario.status).toBe(202);
    const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "story-only-test", messages: [{ role: "user", content: "private prompt must not be retained" }] })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: queued.content }, finish_reason: queued.finishReason }]
    });
    await expect(provider.summary()).resolves.toEqual({ operations: { "chat.completions": 1 }, total: 1 });
    expect(JSON.stringify(await provider.summary())).not.toContain("private prompt");
  });

  it("transports a queued provider failure and still counts the completion request", async () => {
    const provider = await createStoryOnlySyntheticProvider();
    providers.push(provider);
    const scenario = await fetch(`${provider.baseUrl}/__scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "unavailable", statusCode: 503 })
    });
    expect(scenario.status).toBe(202);

    const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, { method: "POST" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { message: "synthetic provider failure" } });
    await expect(provider.summary()).resolves.toEqual({ operations: { "chat.completions": 1 }, total: 1 });
  });

  it("rejects an empty or unsupported scenario without queuing a default response", async () => {
    const provider = await createStoryOnlySyntheticProvider();
    providers.push(provider);
    await expect(fetch(`${provider.baseUrl}/__scenario`, { method: "POST" })).resolves.toMatchObject({ status: 400 });
    await expect(fetch(`${provider.baseUrl}/__scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "not a provider error", statusCode: 200 })
    })).resolves.toMatchObject({ status: 400 });
    await expect(provider.summary()).resolves.toEqual({ operations: {}, total: 0 });
  });

  it("polls until a terminal status without relying on a fixed sleep", async () => {
    let calls = 0;
    const result = await pollStoryOnlyRuntime(async () => {
      calls += 1;
      return calls < 3 ? { status: "generating" } : { status: "completed", campaignId: "campaign-1" };
    }, { timeoutMs: 200, pollIntervalMs: 1 });
    expect(result).toEqual({ status: "completed", campaignId: "campaign-1" });
    expect(calls).toBe(3);
  });

  it("fails polling when no terminal state arrives before the bounded timeout", async () => {
    await expect(pollStoryOnlyRuntime(async () => ({ status: "generating" }), { timeoutMs: 3, pollIntervalMs: 1 }))
      .rejects.toThrow("terminal state");
  });

  it("polls a Docker-owned runtime when no local ChildProcess handle exists", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: "ready" }), { status: calls === 2 ? 200 : 503 });
    };
    try {
      await expect(waitForStoryOnlyRuntimeReady("http://127.0.0.1:18081", undefined, 250)).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("redacts database targets and provider details from operation summaries", () => {
    expect(safeStoryOnlyRuntimeSummary({
      databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_abc",
      provider: { operations: { "chat.completions": 2 }, total: 2 },
      runtimeBaseUrl: "http://127.0.0.1:18081",
      renderer: "native"
    })).toEqual({ database: "infinitequest_storyonly_abc", providerOperations: { "chat.completions": 2 }, providerRequestCount: 2, renderer: "native", runtimeBaseUrl: "http://127.0.0.1:18081" });
  });

  it("defaults the disposable Docker build to the native renderer and identifies it in the safe summary", () => {
    expect(resolveStoryOnlyRuntimeRenderer(undefined)).toBe("native");
    expect(storyOnlyRuntimeDockerBuildArgs("native", "infinitequest-story-only-runtime:test")).toEqual([
      "build", "--build-arg", "VITE_UI_COMPONENTS=native", "--file", "tests/helpers/story-only-runtime.Dockerfile", "--tag", "infinitequest-story-only-runtime:test", "."
    ]);
    expect(safeStoryOnlyRuntimeSummary({
      databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_abc",
      provider: { operations: {}, total: 0 },
      runtimeBaseUrl: "http://127.0.0.1:18081",
      renderer: "native"
    })).toMatchObject({ renderer: "native" });
  });

  it("uses web-awesome only when explicitly selected and rejects unsupported renderer values before Docker can build", () => {
    expect(resolveStoryOnlyRuntimeRenderer("web-awesome")).toBe("web-awesome");
    expect(storyOnlyRuntimeDockerBuildArgs("web-awesome", "infinitequest-story-only-runtime:test"))
      .toContain("VITE_UI_COMPONENTS=web-awesome");
    expect(() => resolveStoryOnlyRuntimeRenderer("experimental")).toThrow("Unsupported story-only runtime renderer");
  });

  it("refuses cleanup names outside this harness ownership", () => {
    expect(assertOwnedStoryOnlyDatabase("infinitequest_storyonly_run1")).toBe("infinitequest_storyonly_run1");
    expect(() => assertOwnedStoryOnlyDatabase("infinitequest_storyonly_test")).toThrow("uniquely owned");
    expect(() => assertOwnedStoryOnlyDatabase("infinitequest_test")).toThrow("uniquely owned");
  });

  it("memoizes concurrent shutdown and disposes a startup result after cancellation", async () => {
    let release: (() => void) | undefined;
    let aborted = false;
    let disposed = 0;
    const lifecycle = createStoryOnlyRuntimeLifecycle(async (signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      await new Promise<void>((resolve) => { release = resolve; });
      return "owned";
    }, async (value) => { expect(value).toBe("owned"); disposed += 1; });
    const first = lifecycle.close();
    const second = lifecycle.close();
    expect(first).toBe(second);
    expect(aborted).toBe(true);
    release?.();
    await Promise.all([first, second]);
    expect(disposed).toBe(1);
  });

  it("surfaces a disposal failure instead of treating cancellation as success", async () => {
    const lifecycle = createStoryOnlyRuntimeLifecycle(async () => "owned", async () => { throw new Error("cleanup failed"); });
    await expect(lifecycle.close()).rejects.toThrow("cleanup failed");
  });

  it("quiesces deferred initialization before shutdown disposes the started fixture", async () => {
    let releaseSummary: (() => void) | undefined;
    const publications: string[] = [];
    let disposed = 0;
    const lifecycle = createStoryOnlyRuntimeLifecycle(async () => "fixture", async () => { disposed += 1; });
    const initialization = lifecycle.initialize(async (_fixture, isRunning) => {
      await new Promise<void>((resolve) => { releaseSummary = resolve; });
      if (!isRunning()) return;
      publications.push("state");
      if (isRunning()) publications.push("timer");
    });

    const shutdown = lifecycle.close();
    releaseSummary?.();

    await expect(initialization).resolves.toBe(false);
    await shutdown;
    expect(publications).toEqual([]);
    expect(disposed).toBe(1);
  });

  it("registers shutdown before a deferred runtime start allocates a fixture", async () => {
    let starts = 0;
    const lifecycle = createStoryOnlyRuntimeLifecycle(async () => { starts += 1; return "fixture"; }, async () => undefined, { deferStart: true });

    await lifecycle.close();

    expect(starts).toBe(0);
  });

  it("attempts every owned cleanup step after the first failure and surfaces all failures", async () => {
    const attempts: string[] = [];
    const close = createStoryOnlyRuntimeCleanup([
      async () => { attempts.push("child"); throw new Error("child cleanup failed"); },
      async () => { attempts.push("database"); },
      async () => { attempts.push("files"); throw new Error("file cleanup failed"); }
    ]);

    const first = close();
    expect(first).toBe(close());
    await expect(first).rejects.toMatchObject({ name: "AggregateError", errors: expect.arrayContaining([expect.objectContaining({ message: "child cleanup failed" }), expect.objectContaining({ message: "file cleanup failed" })]) });
    expect(attempts).toEqual(["child", "database", "files"]);
  });

  it("wraps a single cleanup failure as an AggregateError", async () => {
    const close = createStoryOnlyRuntimeCleanup([async () => { throw new Error("docker network cleanup failed"); }]);

    await expect(close()).rejects.toMatchObject({ name: "AggregateError", errors: [expect.objectContaining({ message: "docker network cleanup failed" })] });
  });

  it("waits for each cleanup step to settle before attempting the next owned resource", async () => {
    let releaseFirst: (() => void) | undefined;
    const attempts: string[] = [];
    const close = createStoryOnlyRuntimeCleanup([
      async () => {
        attempts.push("child");
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        throw new Error("child cleanup failed");
      },
      async () => { attempts.push("database"); }
    ]);

    const closing = close();
    await Promise.resolve();
    expect(attempts).toEqual(["child"]);
    releaseFirst?.();
    await expect(closing).rejects.toMatchObject({ name: "AggregateError" });
    expect(attempts).toEqual(["child", "database"]);
  });

  it("closes the runtime stdin handle after pausing stop input", () => {
    const calls: string[] = [];

    closeStoryOnlyRuntimeInput({
      pause: () => { calls.push("pause"); },
      destroy: () => { calls.push("destroy"); }
    });

    expect(calls).toEqual(["pause", "destroy"]);
  });

  it("selects only allocated Docker resources for early startup cleanup", () => {
    expect(storyOnlyDockerCleanupNames({ runtime: false, provider: false, postgresConnection: false, network: false, image: false })).toEqual([]);
    expect(storyOnlyDockerCleanupNames({ runtime: false, provider: true, postgresConnection: true, network: true, image: true })).toEqual(["provider", "postgresConnection", "network", "image"]);
  });
});
