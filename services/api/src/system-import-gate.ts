import type { FastifyInstance, FastifyRequest } from "fastify";
import { SYSTEM_IMPORT_LOCK_KEY } from "../../../packages/database/src/system-archive-import-repository.js";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";

export { SYSTEM_IMPORT_LOCK_KEY };

type HeldMutationPermit = Readonly<{
  client: DatabaseClient;
  release(): Promise<void>;
}>;

function importInProgressError(): Error & {
  statusCode: 503;
  code: "system-import-in-progress";
  expose: true;
} {
  return Object.assign(new Error("A System Import currently owns the application mutation gate."), {
    statusCode: 503 as const,
    code: "system-import-in-progress" as const,
    expose: true as const,
  });
}

async function tryMutationPermit(pool: DatabasePool): Promise<HeldMutationPermit | null> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock_shared(hashtextextended($1,0)) AS acquired",
      [SYSTEM_IMPORT_LOCK_KEY],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      client.release();
      return null;
    }
    let released = false;
    return Object.freeze({
      client,
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS released",
            [SYSTEM_IMPORT_LOCK_KEY],
          );
        } finally {
          client.release();
        }
      },
    });
  } catch (error) {
    if (!acquired) client.release();
    throw error;
  }
}

export async function withSystemMutationPermit<T>(
  pool: DatabasePool,
  work: () => Promise<T>,
): Promise<T> {
  const permit = await tryMutationPermit(pool);
  if (!permit) throw importInProgressError();
  try {
    return await work();
  } finally {
    await permit.release();
  }
}

export async function withExclusiveSystemImport<T>(
  client: DatabaseClient,
  work: () => Promise<T>,
): Promise<T> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [SYSTEM_IMPORT_LOCK_KEY],
  );
  return work();
}

function requestPath(request: FastifyRequest): string {
  return request.url.split(/[?#]/u, 1)[0] ?? request.url;
}

function requiresMutationPermit(request: FastifyRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  return !(request.method === "POST" && requestPath(request) === "/api/v1/system-imports");
}

export function registerSystemImportGate(
  app: FastifyInstance,
  options: Readonly<{ pool: DatabasePool; enabled: boolean }>,
): void {
  if (!options.enabled) return;
  const permits = new WeakMap<FastifyRequest, HeldMutationPermit>();
  const release = async (request: FastifyRequest): Promise<void> => {
    const permit = permits.get(request);
    if (!permit) return;
    permits.delete(request);
    await permit.release();
  };

  app.addHook("onRequest", async (request) => {
    if (!requiresMutationPermit(request)) return;
    const permit = await tryMutationPermit(options.pool);
    if (!permit) throw importInProgressError();
    permits.set(request, permit);
  });
  app.addHook("onError", async (request) => {
    await release(request);
  });
  app.addHook("onResponse", async (request) => {
    await release(request);
  });
}
