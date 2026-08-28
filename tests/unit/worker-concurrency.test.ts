import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
// @ts-expect-error Repository runner scripts intentionally have no declaration files.
import { tsxCommand } from "../../scripts/node-tool-command.mjs";
import type {
  ClaimedGeneration,
  GenerationWorkerApplication
} from "../../packages/application/src/index.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";

const log = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const productionCompositions = vi.hoisted(() => ({
  createMaintenance: vi.fn(),
  createIllustrationPublication: vi.fn(),
  createSystemArchive: vi.fn()
}));
vi.mock("../../packages/logger/src/index.js", () => ({ logger: log }));
vi.mock("../../services/runtime/src/private-asset-maintenance-composition.js", () => ({
  createPrivateAssetMaintenanceComposition: productionCompositions.createMaintenance
}));
vi.mock("../../services/runtime/src/illustration-asset-publication-composition.js", () => ({
  createPrivateIllustrationAssetPublicationComposition:
    productionCompositions.createIllustrationPublication
}));
vi.mock("../../services/worker/src/system-archive-worker.js", () => ({
  createProductionSystemArchiveWorkerLane: productionCompositions.createSystemArchive
}));

import {
  runWorker,
  type WorkerOptionalLanes
} from "../../services/worker/src/worker.js";
import { inertWorkerIllustration, inertWorkerMemory } from "../helpers/memory-applications.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function claim(jobId: string, campaignSuffix = jobId): ClaimedGeneration {
  return {
    jobId,
    ownerUserId: "00000000-0000-4000-8000-000000000001",
    campaignId: `00000000-0000-4000-8000-${campaignSuffix.padStart(12, "0").slice(-12)}`,
    providerProfileId: "00000000-0000-4000-8000-000000000003",
    expectedTurnNumber: 0,
    operationKind: "append",
    replacementTurnId: null,
    attempts: 1
  };
}

function workerConfig(concurrency: number): RuntimeConfig {
  return {
    workerGenerationConcurrency: concurrency,
    workerLeaseSeconds: 45,
    workerPollIntervalMs: 5,
    credentialEncryptionKey: "test-secret",
    assetStorageRoot: "/tmp/infinite-quest-worker-test"
  } as RuntimeConfig;
}

function idleOptionalLanes(): WorkerOptionalLanes {
  return {
    illustration: vi.fn(async () => false),
    chronicle: vi.fn(async () => false),
    asset: vi.fn(async () => false)
  };
}

const pool = {} as DatabasePool;

describe("worker concurrency scheduler", () => {
  beforeEach(() => {
    log.error.mockReset();
    log.info.mockReset();
    productionCompositions.createMaintenance.mockReset();
    productionCompositions.createIllustrationPublication.mockReset();
    productionCompositions.createSystemArchive.mockReset();
  });

  it("closes production resources when the gated System Archive lane fails to start", async () => {
    const maintenanceClose = vi.fn(async () => undefined);
    const publicationClose = vi.fn(async () => undefined);
    productionCompositions.createMaintenance.mockResolvedValue({
      scheduler: { tick: vi.fn() },
      close: maintenanceClose
    });
    productionCompositions.createIllustrationPublication.mockResolvedValue({
      coordinator: {},
      close: publicationClose
    });
    productionCompositions.createSystemArchive.mockRejectedValue(
      new Error("synthetic System Archive startup failure")
    );

    await expect(runWorker(pool, {
      ...workerConfig(1),
      systemArchiveEnabled: true
    }, new AbortController().signal, {
      generation: {
        claimNext: vi.fn(async () => null),
        executeClaimed: vi.fn(async () => false)
      },
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory
    })).rejects.toThrow("synthetic System Archive startup failure");

    expect(publicationClose).toHaveBeenCalledOnce();
    expect(maintenanceClose).toHaveBeenCalledOnce();
  });

  it("attempts every production close when an earlier shutdown close rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    const publicationClose = vi.fn(async () => undefined);
    const maintenanceClose = vi.fn(() => {
      throw new Error("synthetic maintenance close failure");
    });
    const systemArchiveClose = vi.fn(async () => undefined);
    productionCompositions.createMaintenance.mockResolvedValue({
      scheduler: { tick: vi.fn() },
      close: maintenanceClose,
    });
    productionCompositions.createIllustrationPublication.mockResolvedValue({
      coordinator: {},
      close: publicationClose,
    });
    productionCompositions.createSystemArchive.mockResolvedValue({
      runNext: vi.fn(async () => false),
      close: systemArchiveClose,
    });

    await expect(runWorker(pool, {
      ...workerConfig(1),
      systemArchiveEnabled: true,
    }, controller.signal, {
      generation: {
        claimNext: vi.fn(async () => null),
        executeClaimed: vi.fn(async () => false),
      },
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
    })).rejects.toThrow("synthetic maintenance close failure");

    expect(publicationClose).toHaveBeenCalledOnce();
    expect(maintenanceClose).toHaveBeenCalledOnce();
    expect(systemArchiveClose).toHaveBeenCalledOnce();
  });

  it("fills every configured generation slot and refills only the released slot", async () => {
    const controller = new AbortController();
    const executions = new Map<string, ReturnType<typeof deferred<boolean>>>();
    const claims = [claim("1"), claim("2"), claim("3"), claim("4")];
    let active = 0;
    let peak = 0;
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => claims.shift() ?? null),
      executeClaimed: vi.fn(({ claim: claimed }) => {
        const execution = deferred<boolean>();
        executions.set(claimed.jobId, execution);
        active += 1;
        peak = Math.max(peak, active);
        return execution.promise.finally(() => { active -= 1; });
      })
    };

    const running = runWorker(pool, workerConfig(3), controller.signal, {
      generation,
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes: idleOptionalLanes()
    });

    await vi.waitFor(() => expect(generation.executeClaimed).toHaveBeenCalledTimes(3));
    expect(peak).toBe(3);
    expect(generation.claimNext).toHaveBeenCalledTimes(3);

    executions.get("2")!.resolve(true);
    await vi.waitFor(() => expect(generation.executeClaimed).toHaveBeenCalledTimes(4));
    expect(active).toBe(3);
    expect(peak).toBe(3);

    controller.abort();
    executions.get("1")!.resolve(true);
    executions.get("3")!.resolve(true);
    executions.get("4")!.resolve(true);
    await running;
    expect(generation.claimNext).toHaveBeenCalledTimes(4);
  });

  it("completes a full generation-illustration-Chronicle-asset-System-Archive rotation before refilling", async () => {
    const controller = new AbortController();
    const trace: string[] = [];
    const generationExecutions: ReturnType<typeof deferred<boolean>>[] = [];
    let nextJob = 0;
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => {
        nextJob += 1;
        trace.push(`generation:claim:${nextJob}`);
        return claim(String(nextJob));
      }),
      executeClaimed: vi.fn(({ claim: claimed }) => {
        trace.push(`generation:execute:${claimed.jobId}`);
        const execution = deferred<boolean>();
        generationExecutions.push(execution);
        return execution.promise;
      })
    };
    const illustration = deferred<boolean>();
    const illustrationRefill = deferred<boolean>();
    const chronicle = deferred<boolean>();
    const asset = deferred<boolean>();
    const systemArchive = deferred<boolean>();
    let illustrationCalls = 0;
    const optionalLanes: WorkerOptionalLanes = {
      illustration: vi.fn(() => {
        illustrationCalls += 1;
        trace.push("illustration");
        return illustrationCalls === 1
          ? illustration.promise
          : illustrationRefill.promise;
      }),
      chronicle: vi.fn(() => {
        trace.push("chronicle");
        return chronicle.promise;
      }),
      asset: vi.fn(() => {
        trace.push("asset");
        return asset.promise;
      }),
      systemArchive: vi.fn(() => {
        trace.push("system-archive");
        return systemArchive.promise;
      }),
    };

    const running = runWorker(pool, workerConfig(2), controller.signal, {
      generation,
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes
    });

    await vi.waitFor(() => expect(optionalLanes.systemArchive).toHaveBeenCalledOnce());
    expect(trace).toEqual([
      "generation:claim:1",
      "generation:execute:1",
      "generation:claim:2",
      "generation:execute:2",
      "illustration",
      "chronicle",
      "asset",
      "system-archive",
    ]);

    illustration.resolve(true);
    await vi.waitFor(() => expect(optionalLanes.illustration).toHaveBeenCalledTimes(2));
    expect(optionalLanes.chronicle).toHaveBeenCalledOnce();
    expect(optionalLanes.asset).toHaveBeenCalledOnce();
    expect(optionalLanes.systemArchive).toHaveBeenCalledOnce();

    controller.abort();
    illustrationRefill.resolve(true);
    chronicle.resolve(true);
    asset.resolve(true);
    systemArchive.resolve(true);
    generationExecutions.forEach((execution) => execution.resolve(true));
    await running;
  });

  it("yields to the event loop between synchronously successful rotations", async () => {
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const optionalLanes: WorkerOptionalLanes = {
      illustration: vi.fn(async () => true),
      chronicle: vi.fn(async () => true),
      asset: vi.fn(async () => true)
    };
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => null),
      executeClaimed: vi.fn(async () => false)
    };

    const running = runWorker(pool, workerConfig(1), controller.signal, {
      generation,
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes
    });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 0);
    });

    await running;
    expect(optionalLanes.illustration).toHaveBeenCalled();
    expect(optionalLanes.chronicle).toHaveBeenCalled();
    expect(optionalLanes.asset).toHaveBeenCalled();
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("disposes each losing poll wait when active work completes instantly", async () => {
    const controller = new AbortController();
    const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    let illustrationCalls = 0;
    let outstandingPollListeners = -1;
    const optionalLanes: WorkerOptionalLanes = {
      illustration: vi.fn(async () => {
        illustrationCalls += 1;
        if (illustrationCalls === 25) {
          outstandingPollListeners = addAbortListener.mock.calls.length
            - removeAbortListener.mock.calls.length;
          controller.abort();
        }
        return true;
      }),
      chronicle: vi.fn(async () => true),
      asset: vi.fn(async () => true)
    };
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => null),
      executeClaimed: vi.fn(async () => false)
    };

    await runWorker(pool, {
      ...workerConfig(1),
      workerPollIntervalMs: 60_000
    }, controller.signal, {
      generation,
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes
    });

    expect(illustrationCalls).toBe(25);
    expect(outstandingPollListeners).toBeLessThanOrEqual(1);
  });

  it("isolates an optional-lane rejection and continues refilling every other lane", async () => {
    const controller = new AbortController();
    let illustrationCalls = 0;
    const optionalLanes: WorkerOptionalLanes = {
      illustration: vi.fn(async () => {
        illustrationCalls += 1;
        if (illustrationCalls === 1) throw new Error("synthetic illustration failure");
        controller.abort();
        return false;
      }),
      chronicle: vi.fn(async () => true),
      asset: vi.fn(async () => true)
    };
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => null),
      executeClaimed: vi.fn(async () => false)
    };

    await runWorker(pool, workerConfig(1), controller.signal, {
      generation,
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes
    });

    expect(optionalLanes.illustration).toHaveBeenCalledTimes(2);
    expect(optionalLanes.chronicle).toHaveBeenCalled();
    expect(optionalLanes.asset).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "worker_illustration_error",
      message: "synthetic illustration failure"
    }));
  });

  it("never logs a raw System Archive worker failure at the shared scheduler boundary", async () => {
    const controller = new AbortController();
    const marker = "C:\\private\\story-secret-token.txt";
    const untrustedCode = "story-secret-token";
    const optionalLanes: WorkerOptionalLanes = {
      illustration: vi.fn(async () => false),
      chronicle: vi.fn(async () => false),
      asset: vi.fn(async () => false),
      systemArchive: vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error(marker), { code: untrustedCode });
      }),
    };

    await runWorker(pool, workerConfig(1), controller.signal, {
      generation: {
        claimNext: vi.fn(async () => null),
        executeClaimed: vi.fn(async () => false),
      },
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes,
    });

    const systemArchiveLogs = log.error.mock.calls.filter(([fields]) => (
      fields as Record<string, unknown>
    ).event === "worker_system-archive_error");
    expect(systemArchiveLogs).toHaveLength(1);
    expect(systemArchiveLogs[0]?.[0]).toMatchObject({
      event: "worker_system-archive_error",
      errorCode: "archive-operation-failed",
    });
    expect(JSON.stringify(systemArchiveLogs)).not.toContain(marker);
    expect(JSON.stringify(systemArchiveLogs)).not.toContain(untrustedCode);
  });

  it("stops all claims after abort, drains every lane, and never passes the scheduler signal to story execution", async () => {
    const controller = new AbortController();
    const generationExecution = deferred<boolean>();
    const illustration = deferred<boolean>();
    const chronicle = deferred<boolean>();
    const asset = deferred<boolean>();
    const systemArchive = deferred<boolean>();
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => claim("1")),
      executeClaimed: vi.fn(() => generationExecution.promise)
    };
    const optionalLanes: WorkerOptionalLanes = {
      illustration: vi.fn(() => illustration.promise),
      chronicle: vi.fn(() => chronicle.promise),
      asset: vi.fn(() => asset.promise),
      systemArchive: vi.fn(() => systemArchive.promise),
    };
    let settled = false;

    const running = runWorker(pool, workerConfig(1), controller.signal, {
      generation,
      illustration: inertWorkerIllustration,
      memory: inertWorkerMemory,
      optionalLanes
    }).finally(() => { settled = true; });

    await vi.waitFor(() => expect(optionalLanes.systemArchive).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(generation.claimNext).toHaveBeenCalledOnce();
    expect(generation.executeClaimed).toHaveBeenCalledWith({
      workerId: expect.any(String),
      leaseSeconds: 45,
      claim: expect.objectContaining({ jobId: "1" })
    });

    generationExecution.resolve(true);
    illustration.resolve(true);
    chronicle.resolve(true);
    asset.resolve(true);
    systemArchive.resolve(true);
    await running;

    expect(generation.claimNext).toHaveBeenCalledOnce();
    expect(optionalLanes.illustration).toHaveBeenCalledOnce();
    expect(optionalLanes.chronicle).toHaveBeenCalledOnce();
    expect(optionalLanes.asset).toHaveBeenCalledOnce();
    expect(optionalLanes.systemArchive).toHaveBeenCalledOnce();
  });
});

describe("worker concurrency benchmark", () => {
  it("executes its self-test and rejects duplicate campaign turn commits", () => {
    const command = tsxCommand(["scripts/benchmark-worker-concurrency.mjs", "--self-test"]);
    const output = execFileSync(
      command.executable,
      command.arguments,
      { encoding: "utf8" }
    );
    const result = JSON.parse(output) as {
      cgroupMemoryLimitParsing: Record<string, number | null>;
      duplicateGuard: string;
      mode: string;
      summary: Record<string, number>;
    };

    expect(result).toMatchObject({
      mode: "self-test",
      duplicateGuard: "rejected",
      cgroupMemoryLimitParsing: {
        fourGiB: 4,
        unlimited: null,
        invalid: null
      },
      summary: {
        sampleCount: 3,
        throughputMean: 12,
        throughputMedian: 12,
        throughputVarianceRatio: expect.closeTo(0.136083, 5)
      }
    });
  });
});
