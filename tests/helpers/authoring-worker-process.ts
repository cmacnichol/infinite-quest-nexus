import { createHash } from "node:crypto";
import { createDatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";
import { createProviderTransport } from "../../packages/story-engine/src/provider-transport.js";
import { createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import { createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const credentialSecret = process.env.AUTHORING_PROCESS_CREDENTIAL_SECRET;
const limit = Number.parseInt(process.env.AUTHORING_PROCESS_LIMIT ?? "1", 10);
const crashAfterCheckpoint = process.env.AUTHORING_PROCESS_CRASH_AFTER_CHECKPOINT === "true";

if (!databaseUrl || !credentialSecret || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
  throw new Error("Authoring worker process test configuration is invalid.");
}

const pool = createDatabasePool(databaseUrl, 4);
const transport = createProviderTransport({
  policy: createProviderNetworkPolicy({ allowlist: ["127.0.0.0/8"] })
});

try {
  const providers = createWorkerProviderApplicationComposition(pool, {
    credentialSecret,
    transport
  });
  const repository = createPostgresAuthoringRepository(pool);
  const authoring = createRuntimeAuthoringWorkerApplication({
    pool,
    ...(process.env.AUTHORING_PROCESS_CRASH_BEFORE_CHECKPOINT === "true" || crashAfterCheckpoint ? { repository: {
      ...repository,
      checkpoint: async (claim, output) => {
        if (process.env.AUTHORING_PROCESS_CRASH_BEFORE_CHECKPOINT === "true") {
          // The real HTTP provider has returned and runtime validation succeeded.
          // Exit without running checkpoint SQL, failure handling, or pool cleanup.
          process.exit(86);
        }
        const committed = await repository.checkpoint(claim, output);
        // The real transaction committed, but the worker's checkpoint call and
        // runNext have not returned. Do not report completion or run cleanup.
        if (committed && crashAfterCheckpoint) process.exit(87);
        return committed;
      }
    } } : {}),
    providers: providers.worldGeneration,
    sha256: (value) => createHash("sha256").update(value).digest("hex")
  });
  let completed = 0;
  const runs: boolean[] = [];
  for (let index = 0; index < limit; index += 1) {
    const ran = await authoring.runNext({ workerId: `authoring-process-${process.pid}`, leaseSeconds: 30 });
    runs.push(ran);
    if (!ran) break;
    completed += 1;
  }
  process.stdout.write(`${JSON.stringify({ completed, runs })}\n`);
} finally {
  await transport.close();
  await pool.end();
}
