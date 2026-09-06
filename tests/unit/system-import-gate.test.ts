import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";
import {
  registerSystemImportGate,
  withExclusiveSystemImport,
  withSystemMutationPermit,
} from "../../services/api/src/system-import-gate.js";

function gatePool(available: boolean) {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_lock_shared")) {
        return { rows: [{ acquired: available }] };
      }
      if (sql.includes("pg_advisory_unlock_shared")) {
        return { rows: [{ released: true }] };
      }
      return { rows: [] };
    },
    release: vi.fn(),
  } as unknown as DatabaseClient;
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as DatabasePool,
    client,
    queries,
  };
}

describe("System Import mutation gate", () => {
  it("holds a shared mutation permit until the work completes", async () => {
    const fixture = gatePool(true);
    const observed: string[] = [];

    await expect(withSystemMutationPermit(fixture.pool, async () => {
      observed.push("work");
      expect(fixture.queries.some((sql) => sql.includes("pg_advisory_unlock_shared"))).toBe(false);
      return 42;
    })).resolves.toBe(42);

    expect(observed).toEqual(["work"]);
    expect(fixture.queries.map((sql) => sql.match(/pg_[a-z_]+/u)?.[0])).toEqual([
      "pg_try_advisory_lock_shared",
      "pg_advisory_unlock_shared",
    ]);
    expect(fixture.client.release).toHaveBeenCalledOnce();
  });

  it("returns a stable unavailable error while the exclusive import owns the gate", async () => {
    const fixture = gatePool(false);
    const work = vi.fn();

    await expect(withSystemMutationPermit(fixture.pool, work)).rejects.toMatchObject({
      statusCode: 503,
      code: "system-import-in-progress",
    });

    expect(work).not.toHaveBeenCalled();
    expect(fixture.client.release).toHaveBeenCalledOnce();
  });

  it("takes the exclusive import lock in the caller transaction", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
    } as unknown as DatabaseClient;

    await expect(withExclusiveSystemImport(client, async () => "committed")).resolves.toBe("committed");

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("pg_advisory_xact_lock");
  });

  it("blocks domain mutations but leaves health, status, safe methods, and commit enqueue available", async () => {
    const fixture = gatePool(false);
    const app = Fastify();
    registerSystemImportGate(app, { pool: fixture.pool, enabled: true });
    app.get("/health/ready", async () => ({ status: "ready" }));
    app.get("/api/v1/worlds", async () => ({ worlds: [] }));
    app.post("/api/v1/worlds", async () => ({ created: true }));
    app.get("/api/v1/system-imports/:jobId", async () => ({ status: "importing" }));
    app.post("/api/v1/system-imports", async () => ({ status: "queued" }));

    const [mutation, health, status, read, enqueue] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/worlds" }),
      app.inject({ method: "GET", url: "/health/ready" }),
      app.inject({ method: "GET", url: "/api/v1/system-imports/job-1" }),
      app.inject({ method: "GET", url: "/api/v1/worlds" }),
      app.inject({ method: "POST", url: "/api/v1/system-imports" }),
    ]);

    expect(mutation.statusCode).toBe(503);
    expect(mutation.json()).toMatchObject({ code: "system-import-in-progress" });
    expect(health.statusCode).toBe(200);
    expect(status.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(enqueue.statusCode).toBe(200);
    await app.close();
  });

  it("does not install database gate work while the capability is disabled", async () => {
    const fixture = gatePool(false);
    const app = Fastify();
    registerSystemImportGate(app, { pool: fixture.pool, enabled: false });
    app.post("/api/v1/worlds", async () => ({ created: true }));

    const response = await app.inject({ method: "POST", url: "/api/v1/worlds" });

    expect(response.statusCode).toBe(200);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
    await app.close();
  });
});
