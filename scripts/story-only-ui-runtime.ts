import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeStoryOnlyRuntimeInput, createStoryOnlyRuntimeLifecycle, startStoryOnlyRuntime } from "../tests/helpers/story-only-runtime-fixture.js";

const root = process.cwd();
const statePath = resolve(root, "tmp/story-only-test/runtime.json");
const databasePath = resolve(root, "tmp/story-only-test/database.json");
const database = JSON.parse(await readFile(databasePath, "utf8")) as { url?: unknown };
if (typeof database.url !== "string") throw new Error("Story-only runtime database configuration is missing its URL.");

await rm(statePath, { force: true });
const lifecycle = createStoryOnlyRuntimeLifecycle(
  (signal) => startStoryOnlyRuntime({ databaseUrl: database.url as string, root, signal }),
  async (fixture) => { await fixture.close(); await rm(statePath, { force: true }); },
  { deferStart: true }
);
let keepAlive: NodeJS.Timeout | undefined;
let shutdown: Promise<void> | undefined;
const stop = () => shutdown ??= (async () => {
  if (keepAlive) clearInterval(keepAlive);
  closeStoryOnlyRuntimeInput(process.stdin);
  try {
    await lifecycle.close();
  } finally {
    await rm(statePath, { force: true });
  }
  process.exitCode = 0;
})();
const reportShutdownFailure = (_error: unknown) => {
  process.exitCode = 1;
  process.stderr.write("Story-only runtime shutdown failed.\n");
};
const requestStop = () => { void stop().catch(reportShutdownFailure); };
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { if (chunk.toString().trim().toLowerCase() === "stop") requestStop(); });
lifecycle.start();
try {
  await lifecycle.initialize(async (fixture, isRunning) => {
    const summary = await fixture.summary();
    if (!isRunning()) return;
    await mkdir(resolve(root, "tmp/story-only-test"), { recursive: true });
    if (!isRunning()) return;
    await writeFile(statePath, `${JSON.stringify({ baseUrl: fixture.baseUrl, campaignId: fixture.campaignId, databaseName: fixture.databaseName })}\n`, "utf8");
    if (!isRunning()) { await rm(statePath, { force: true }); return; }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    keepAlive = setInterval(() => undefined, 60_000);
  });
} catch (error) {
  await stop();
  throw error;
}
