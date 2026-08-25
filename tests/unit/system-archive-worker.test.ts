import { describe, expect, it, vi } from "vitest";
import { createPostgresSystemArchiveJobRepository } from "../../packages/database/src/system-archive-job-repository.js";
import { createSystemArchiveWorkerLane } from "../../services/worker/src/system-archive-worker.js";

const job = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  stagedInputId: null,
  leaseOwner: "worker",
  leaseExpiresAt: "2026-08-25T12:01:00.000Z",
  kind: "export" as const,
  status: "capturing" as const,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
  report: null,
});

describe("System Archive worker lane", () => {
  it("claims at most one job and dispatches by durable kind", async () => {
    const jobs = {
      claimNext: vi.fn(async () => job),
      heartbeat: vi.fn(async () => true),
      markCancelled: vi.fn(),
      markFailed: vi.fn(),
    };
    const runSystemExport = vi.fn(async () => ({ status: "published" as const, artifact: {}, report: {} }));
    const lane = createSystemArchiveWorkerLane({
      workerId: "worker",
      leaseSeconds: 60,
      jobs: jobs as never,
      exports: { runSystemExport } as never,
      imports: { runSystemImport: vi.fn() } as never,
    });

    await expect(lane.runNext()).resolves.toBe(true);
    expect(jobs.claimNext).toHaveBeenCalledOnce();
    expect(runSystemExport).toHaveBeenCalledWith(job);
  });

  it("finishes pre-boundary cancellation without executing import authority", async () => {
    const cancelling = { ...job, kind: "import" as const, status: "cancelling" as const, stagedInputId: "staged" };
    const jobs = {
      claimNext: vi.fn(async () => cancelling),
      heartbeat: vi.fn(async () => true),
      markCancelled: vi.fn(async () => undefined),
      markFailed: vi.fn(),
    };
    const runSystemImport = vi.fn();
    const lane = createSystemArchiveWorkerLane({
      workerId: "worker",
      leaseSeconds: 60,
      jobs: jobs as never,
      exports: { runSystemExport: vi.fn() } as never,
      imports: { runSystemImport } as never,
    });

    await expect(lane.runNext()).resolves.toBe(true);
    expect(jobs.markCancelled).toHaveBeenCalledWith(cancelling.id, "worker");
    expect(runSystemImport).not.toHaveBeenCalled();
  });

  it("backs off after an import durably transitions to waiting for the mutation gate", async () => {
    const importing = {
      ...job,
      kind: "import" as const,
      stagedInputId: "staged",
      status: "revalidating" as const,
    };
    const jobs = {
      claimNext: vi.fn(async () => importing),
      heartbeat: vi.fn(async () => true),
      getJob: vi.fn(async () => ({
        id: importing.id,
        kind: "import" as const,
        status: "waiting_for_gate" as const,
        createdAt: importing.createdAt,
        updatedAt: importing.updatedAt,
        report: null,
      })),
      markCancelled: vi.fn(),
      markFailed: vi.fn(),
    };
    const runSystemImport = vi.fn(async () => undefined);
    const lane = createSystemArchiveWorkerLane({
      workerId: "worker",
      leaseSeconds: 60,
      jobs: jobs as never,
      exports: { runSystemExport: vi.fn() } as never,
      imports: { runSystemImport } as never,
    });

    await expect(lane.runNext()).resolves.toBe(false);
    expect(runSystemImport).toHaveBeenCalledWith(importing);
    expect(jobs.getJob).toHaveBeenCalledWith(
      { ownerUserId: importing.ownerUserId },
      importing.id,
    );
  });

  it("heartbeats long work and records only a safe terminal failure code", async () => {
    vi.useFakeTimers();
    const jobs = {
      claimNext: vi.fn(async () => ({ ...job, kind: "import" as const, stagedInputId: "staged", status: "revalidating" as const })),
      heartbeat: vi.fn(async () => true),
      markCancelled: vi.fn(async () => { throw new Error("not cancelling"); }),
      markFailed: vi.fn(async () => undefined),
    };
    let rejectImport!: (error: unknown) => void;
    const runningImport = new Promise<void>((_resolve, reject) => { rejectImport = reject; });
    const lane = createSystemArchiveWorkerLane({
      workerId: "worker",
      leaseSeconds: 3,
      jobs: jobs as never,
      exports: { runSystemExport: vi.fn() } as never,
      imports: { runSystemImport: vi.fn(() => runningImport) } as never,
    });
    try {
      const running = lane.runNext();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(jobs.heartbeat).toHaveBeenCalled();
      const marker = "C:\\private\\story-secret-token.txt";
      rejectImport(Object.assign(new Error(marker), { code: "archive-checksum-mismatch" }));
      const failure = await running.catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "SystemArchiveWorkerError",
        message: "System Archive worker operation failed.",
        code: "archive-checksum-mismatch",
      });
      expect(JSON.stringify(failure)).not.toContain(marker);
      expect(jobs.markFailed).toHaveBeenCalledWith(
        job.id,
        "worker",
        "archive-checksum-mismatch",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces untrusted story-like failure codes before persistence or propagation", async () => {
    const importing = {
      ...job,
      kind: "import" as const,
      stagedInputId: "staged",
      status: "revalidating" as const,
    };
    const marker = "story-secret-token";
    const jobs = {
      claimNext: vi.fn(async () => importing),
      heartbeat: vi.fn(async () => true),
      markCancelled: vi.fn(async () => { throw new Error("not cancelling"); }),
      markFailed: vi.fn(async () => undefined),
    };
    const lane = createSystemArchiveWorkerLane({
      workerId: "worker",
      leaseSeconds: 60,
      jobs: jobs as never,
      exports: { runSystemExport: vi.fn() } as never,
      imports: {
        runSystemImport: vi.fn(async () => {
          throw Object.assign(new Error(`C:\\private\\${marker}.txt`), { code: marker });
        }),
      } as never,
    });

    const failure = await lane.runNext().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "SystemArchiveWorkerError",
      message: "System Archive worker operation failed.",
      code: "archive-operation-failed",
    });
    expect(JSON.stringify(failure)).not.toContain(marker);
    expect(jobs.markFailed).toHaveBeenCalledWith(
      importing.id,
      "worker",
      "archive-operation-failed",
    );
  });

  it("honors a cancellation requested while a pre-boundary import is running", async () => {
    const importing = {
      ...job,
      kind: "import" as const,
      stagedInputId: "staged",
      status: "revalidating" as const,
    };
    const jobs = {
      claimNext: vi.fn(async () => importing),
      heartbeat: vi.fn(async () => true),
      markCancelled: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const lane = createSystemArchiveWorkerLane({
      workerId: "worker",
      leaseSeconds: 60,
      jobs: jobs as never,
      exports: { runSystemExport: vi.fn() } as never,
      imports: {
        runSystemImport: vi.fn(async () => {
          throw Object.assign(new Error("cancelled"), { code: "system-archive-cancelled" });
        }),
      } as never,
    });

    await expect(lane.runNext()).resolves.toBe(true);
    expect(jobs.markCancelled).toHaveBeenCalledWith(importing.id, "worker");
    expect(jobs.markFailed).not.toHaveBeenCalled();
  });

  it.each(["authoritative_committed", "rebuilding"] as const)(
    "never demotes post-commit import status %s to a generic failure",
    async (postCommitStatus) => {
      let visibleStatus: string = postCommitStatus;
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE system_archive_jobs")) {
          if (sql.includes(`'${postCommitStatus}'`)) {
            visibleStatus = "failed";
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ status: visibleStatus }], rowCount: 1 };
      });
      const jobs = createPostgresSystemArchiveJobRepository({ query } as never);

      await expect(jobs.markFailed(job.id, "worker", "archive-operation-failed"))
        .resolves.toBeUndefined();
      expect(visibleStatus).toBe(postCommitStatus);
    },
  );

  it("projects a published export as expired when its private artifact authority expires", async () => {
    const expired = {
      id: job.id,
      owner_user_id: job.ownerUserId,
      kind: "export" as const,
      status: "expired" as const,
      idempotency_key_hash: "a".repeat(64),
      staged_input_id: null,
      report: null,
      lease_owner: null,
      lease_expires_at: null,
      created_at: new Date(job.createdAt),
      updated_at: new Date(job.updatedAt),
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [expired], rowCount: 1 });
    const jobs = createPostgresSystemArchiveJobRepository({ query } as never);

    await expect(jobs.getJob(
      { ownerUserId: job.ownerUserId },
      job.id,
    )).resolves.toMatchObject({ id: job.id, status: "expired" });

    expect(query.mock.calls[0]?.[0]).toContain("artifact.expires_at<=clock_timestamp()");
    expect(query.mock.calls.every((call) => call[1][1] === job.ownerUserId)).toBe(true);
  });
});
