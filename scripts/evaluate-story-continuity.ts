import { privateContinuityArtifactPath } from "./lib/private-continuity-artifact.js";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, open, readFile, unlink, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  createPrivateArtifactManifest,
  validateLiveConfiguration
} from "./lib/story-continuity-evaluator.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value?.trim()) throw new Error(`${name} requires a value.`);
  return value;
}

async function resolvePrivateArtifactPath(directory: string, runId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(runId)) throw new Error("Run ID must be a simple filename identifier.");
  return privateContinuityArtifactPath(directory, `story-continuity-${runId}.json`, root);
}

async function writeSanitizedReport(output: string | undefined, report: unknown): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!output) {
    process.stdout.write(serialized);
    return;
  }
  const target = resolve(root, output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized, "utf8");
  process.stdout.write(`${target}\n`);
}

async function executeDeterministicHarness(environment: Record<string, string | undefined> = {}): Promise<void> {
  const integrationConfig = argument("--integration-config") ?? "vitest.integration.config.ts";
  if (!/^[A-Za-z0-9_./\\:-]+$/u.test(integrationConfig)) throw new Error("Integration config must be a plain local path without shell characters.");
  const command = ["corepack", "pnpm", "vitest", "run", "--config", integrationConfig, "--configLoader", "runner", "tests/integration/story-continuity-evaluator.integration.test.ts", "--reporter=dot"];
  const executable = process.platform === "win32" ? "cmd.exe" : command[0]!;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command.join(" ")] : command.slice(1);
  const result = await new Promise<number>((done, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...environment } });
    child.once("error", reject); child.once("close", (code) => done(code ?? 1));
  });
  if (result !== 0) throw new Error("Deterministic T15 harness did not complete; no evaluation report was emitted.");
}

function liveConfigurationFromArguments() {
  return validateLiveConfiguration({
    explicitLive: process.argv.includes("--live"),
    providerId: argument("--provider"), providerModel: argument("--model"), scenarioVersion: argument("--scenario-version"),
    sourceCampaignId: argument("--source-campaign"), copiedCampaignId: argument("--campaign-copy"),
    maxCalls: Number(argument("--max-calls")), maxInputTokens: Number(argument("--max-input-tokens")),
    maxOutputTokens: Number(argument("--max-output-tokens")), maxCostUsd: Number(argument("--max-cost-usd"))
  });
}

export async function main(): Promise<void> {
  const mode = argument("--mode") ?? "deterministic";
  if (mode === "live") {
    const configuration = liveConfigurationFromArguments();
    const generationJobId = requiredArgument("--generation-job");
    const sourceAuthorization = requiredArgument("--source-authorization");
    const accessPolicy = requiredArgument("--access-policy");
    const runId = requiredArgument("--run-id");
    const directory = requiredArgument("--private-artifact-dir");
    const artifactPath = await resolvePrivateArtifactPath(directory, runId);
    const inputUsdPerMillion = Number(requiredArgument("--input-usd-per-million"));
    const outputUsdPerMillion = Number(requiredArgument("--output-usd-per-million"));
    const [{ loadRuntimeConfig }, { createDatabasePool, initialOwnerId }, { createWorkerProviderApplicationComposition }, { createProviderTransport }, { createProviderNetworkPolicy }, { evaluateLiveCopiedRequest }] = await Promise.all([
      import("../packages/database/src/config.js"), import("../packages/database/src/pool.js"),
      import("../services/runtime/src/provider-application-composition.js"), import("../packages/story-engine/src/provider-transport.js"),
      import("../packages/security/src/provider-network-policy.js"), import("./lib/live-continuity-evaluator.js")
    ]);
    const runtime = loadRuntimeConfig();
    const pool = createDatabasePool(runtime.databaseUrl, 2);
    const transport = createProviderTransport({ policy: createProviderNetworkPolicy({ allowlist: runtime.security.providerNetworkAllowlist }) });
    try {
      const owner = await initialOwnerId(pool);
      const rows = await pool.query<{ orchestration_private: { validatedMainDraft?: { campaignId: string; providerId: string; providerModel: string; requestBody: string; requestPayloadHash: string } } }>(
        `SELECT job.orchestration_private FROM generation_jobs job
         JOIN campaigns copied ON copied.id=job.campaign_id AND copied.owner_user_id=job.owner_user_id
         JOIN campaigns source ON source.id=$3 AND source.owner_user_id=copied.owner_user_id
         WHERE job.id=$1 AND job.campaign_id=$2 AND job.owner_user_id=$4 AND job.status='completed'
           AND copied.id<>source.id AND copied.world_version_id=source.world_version_id`,
        [generationJobId, configuration.copiedCampaignId, configuration.sourceCampaignId, owner]);
      const saved = rows.rows[0]?.orchestration_private.validatedMainDraft;
      if (!saved) throw new Error("A completed, self-contained generation from the authorized copied campaign is required.");
      const providers = createWorkerProviderApplicationComposition(pool, { credentialSecret: runtime.credentialEncryptionKey, transport });
      const provider = await providers.generation.execution.text({ ownerUserId: owner }, configuration.providerId, "text", configuration.providerModel);
      const artifactManifest = createPrivateArtifactManifest({ runId, sourceAuthorization, copiedDestination: configuration.copiedCampaignId,
        privateArtifactDirectory: directory, artifactPaths: [artifactPath], accessPolicy, issuedAt: new Date().toISOString() });
      const artifact = await open(artifactPath, "wx");
      try {
        const result = await evaluateLiveCopiedRequest(configuration, { ...saved, sourceCampaignId: configuration.sourceCampaignId }, provider, { inputUsdPerMillion, outputUsdPerMillion });
        await artifact.writeFile(JSON.stringify({ artifactManifest, report: result.report, outputs: result.outputs }), "utf8");
        await writeSanitizedReport(argument("--output"), { ...result.report, artifactManifest });
      } finally { await artifact.close(); }
    } finally { await transport.close(); await pool.end(); }
    return;
  }
  if (mode !== "deterministic" || process.argv.includes("--live")) {
    throw new Error("Only --mode deterministic is runnable without explicit live authorization; use --mode live --live with an authorized copied request and every required ceiling.");
  }
  if (!process.env.TEST_DATABASE_URL && !process.argv.includes("--allow-local-test-db")) {
    throw new Error("Deterministic execution requires TEST_DATABASE_URL for an isolated database, or --allow-local-test-db to use the configured local integration database.");
  }
  const output = argument("--output");
  const privateArtifactDirectory = argument("--private-artifact-dir");
  const runId = privateArtifactDirectory === undefined ? undefined : requiredArgument("--run-id");
  const privateArtifactPath = privateArtifactDirectory === undefined ? undefined : await resolvePrivateArtifactPath(privateArtifactDirectory, runId!);
  const artifactManifest = privateArtifactDirectory === undefined ? {
    status: "not_created",
    reason: "No raw request or state artifacts were requested. Only measured aggregate scores are emitted."
  } : createPrivateArtifactManifest({
    runId: runId!, sourceAuthorization: argument("--source-authorization") ?? "sanitized fixture corpus",
    copiedDestination: argument("--campaign-copy") ?? "not-applicable-sanitized-fixture", privateArtifactDirectory,
    artifactPaths: [privateArtifactPath!], accessPolicy: argument("--access-policy") ?? "operator/current-owner review team",
    issuedAt: new Date().toISOString(), ...(argument("--retention-days") === undefined ? {} : { retentionDays: Number(argument("--retention-days")) })
  });
  const reportDirectory = await mkdtemp(resolve(tmpdir(), "iq-continuity-report-"));
  const reportPath = resolve(reportDirectory, "aggregate.json");
  let evaluatedReport: Record<string, unknown>;
  try {
    await executeDeterministicHarness({ STORY_CONTINUITY_EVALUATOR_REPORT: reportPath,
      ...(privateArtifactPath ? { STORY_CONTINUITY_EVALUATOR_PRIVATE_ARTIFACT: privateArtifactPath } : {}) });
    const capturedReport = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    const registration = capturedReport.preregistration as { sampleCount?: number } | undefined;
    if (!registration?.sampleCount || registration.sampleCount < 120) throw new Error("Executor evaluation did not produce the required measured sample; skipped tests are not successful evaluation.");
    evaluatedReport = { ...capturedReport, evidenceLayer: { fixtureEvidence: "deterministic", realExecutorIntegration: "completed", liveProvider: "not_run",
      note: "Measured isolated PostgreSQL executor captures. These deterministic fixtures do not establish live narrative quality." } };
  } finally {
    await unlink(reportPath).catch(() => undefined);
    await rmdir(reportDirectory);
  }
  await writeSanitizedReport(output, { ...evaluatedReport as Record<string, unknown>, artifactManifest });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
