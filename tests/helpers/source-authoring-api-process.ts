import { createHash } from "node:crypto";
import Fastify from "fastify";
import { createAuthoringApplication } from "../../packages/application/src/authoring/use-cases.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { createDatabasePool } from "../../packages/database/src/pool.js";
import { registerAuthoringRoutes } from "../../services/api/src/authoring-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerUserId = process.env.AUTHORING_PROCESS_OWNER_USER_ID;

if (!databaseUrl || !ownerUserId) throw new Error("Source API process test configuration is invalid.");

const pool = createDatabasePool(databaseUrl, 4);
const repository = createPostgresAuthoringRepository(pool);
const application = createAuthoringApplication({
  repository,
  targets: { assertCurrent: async () => undefined },
  worlds: { applyInTransaction: async () => { throw new Error("World application is not available in the source API process fixture."); } },
  sha256: (value) => createHash("sha256").update(value).digest("hex")
});
const app = Fastify({ logger: false });

await registerAuthoringRoutes(app, {
  application,
  enabled: true,
  sourceEnabled: process.env.AUTHORING_PROCESS_SOURCE_ENABLED !== "false",
  resolveOwner: async () => ({ ownerUserId }),
  acquireAdmission: async () => ({ allowed: true })
});

const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`${JSON.stringify({ address })}\n`);

async function close(): Promise<void> {
  await app.close();
  await pool.end();
}

process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
