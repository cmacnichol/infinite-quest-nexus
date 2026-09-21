import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "node:fs/promises";
import { privateContinuityArtifactPath } from "./lib/private-continuity-artifact.js";
import {
  DEFAULT_STRUCTURED_OUTPUT_PROBE,
  prepareStructuredOutputProbe,
  providerRequestForPreparedProbe,
  runStructuredOutputProbe,
  validateExecutionPriceObservation,
  type ProbeInput
} from "./lib/structured-output-probe.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const valueFlags = new Set(["--model", "--route", "--input-usd-per-token", "--output-usd-per-token", "--price-observed-at", "--context-tokens", "--max-calls", "--max-output-tokens", "--max-input-tokens", "--max-cost-usd", "--accept-max-cost-usd", "--profile-id", "--execution-authorization", "--report"]);
const booleanFlags = new Set(["--execute"]);
const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

function argumentsMap(argv: readonly string[]) {
  const values = new Map<string, string>(); let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--") continue;
    if (booleanFlags.has(flag)) { if (execute) throw new Error("Duplicate --execute."); execute = true; continue; }
    if (!valueFlags.has(flag)) throw new Error(`Unknown flag: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (values.has(flag)) throw new Error(`Duplicate ${flag}.`);
    values.set(flag, value); index += 1;
  }
  return { values, execute };
}

function numeric(values: Map<string, string>, name: string, fallback: number) {
  const value = values.has(name) ? Number(values.get(name)) : fallback;
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`); return value;
}

function probeInput(values: Map<string, string>): ProbeInput {
  const priceObservedAt = values.get("--price-observed-at") ?? "";
  return {
    ...DEFAULT_STRUCTURED_OUTPUT_PROBE,
    model: values.get("--model") ?? DEFAULT_STRUCTURED_OUTPUT_PROBE.model,
    route: values.get("--route") ?? "",
    inputUsdPerToken: numeric(values, "--input-usd-per-token", DEFAULT_STRUCTURED_OUTPUT_PROBE.inputUsdPerToken),
    outputUsdPerToken: numeric(values, "--output-usd-per-token", DEFAULT_STRUCTURED_OUTPUT_PROBE.outputUsdPerToken),
    contextTokens: numeric(values, "--context-tokens", DEFAULT_STRUCTURED_OUTPUT_PROBE.contextTokens),
    maxCalls: numeric(values, "--max-calls", DEFAULT_STRUCTURED_OUTPUT_PROBE.maxCalls),
    maxOutputTokens: numeric(values, "--max-output-tokens", DEFAULT_STRUCTURED_OUTPUT_PROBE.maxOutputTokens),
    priceObservedAt
  };
}

async function writePrivateReport(path: string | undefined, report: unknown): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!path) { process.stdout.write(serialized); return; }
  const target = await privateContinuityArtifactPath(dirname(resolve(path)), basename(path), root);
  const handle = await open(target, "wx");
  try { await handle.writeFile(serialized, "utf8"); } finally { await handle.close(); }
  process.stdout.write(`${target}\n`);
}

async function reservePrivateReport(path: string): Promise<Readonly<{ target: string; write(report: unknown): Promise<void>; close(): Promise<void> }>> {
  const target = await privateContinuityArtifactPath(dirname(resolve(path)), basename(path), root);
  const handle = await open(target, "wx");
  return { target, write: (report) => handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8"), close: () => handle.close() };
}

function executionGuards(values: Map<string, string>, plan: ReturnType<typeof prepareStructuredOutputProbe>, now: Date) {
  for (const required of ["--model", "--route", "--input-usd-per-token", "--output-usd-per-token", "--price-observed-at", "--context-tokens", "--max-calls", "--max-output-tokens"] as const) if (!values.has(required)) throw new Error(`--execute requires ${required}.`);
  const profileId = values.get("--profile-id");
  if (!profileId || !uuid.test(profileId)) throw new Error("--execute requires a UUID --profile-id.");
  const authorization = values.get("--execution-authorization")?.trim();
  if (!authorization) throw new Error("--execute requires a nonempty --execution-authorization.");
  for (const required of ["--max-input-tokens", "--max-cost-usd", "--accept-max-cost-usd"] as const) if (!values.has(required)) throw new Error(`--execute requires ${required}.`);
  const maxInputTokens = numeric(values, "--max-input-tokens", 0);
  const maxCostUsd = numeric(values, "--max-cost-usd", 0);
  const acceptedCost = numeric(values, "--accept-max-cost-usd", 0);
  const ceiling = Number(plan.safePlan.maxInferenceCostUsd);
  if (maxInputTokens < DEFAULT_STRUCTURED_OUTPUT_PROBE.contextTokens || maxCostUsd < ceiling || acceptedCost !== ceiling) throw new Error("Execution ceilings do not cover the prepared conservative bound exactly.");
  validateExecutionPriceObservation(String(plan.safePlan.priceObservedAt), now.toISOString());
  return { profileId, authorization };
}

export type ProbeCliDependencies = Readonly<{ loadLiveRuntime?: () => Promise<any>; now?: () => Date }>;
async function defaultLiveRuntime() {
  const [{ loadRuntimeConfig }, { createDatabasePool, initialOwnerId }, { createWorkerProviderApplicationComposition }, { createProviderTransport }, { createProviderNetworkPolicy }] = await Promise.all([
    import("../packages/database/src/config.js"), import("../packages/database/src/pool.js"), import("../services/runtime/src/provider-application-composition.js"),
    import("../packages/story-engine/src/provider-transport.js"), import("../packages/security/src/provider-network-policy.js")
  ]);
  return { loadRuntimeConfig, createDatabasePool, initialOwnerId, createWorkerProviderApplicationComposition, createProviderTransport, createProviderNetworkPolicy };
}

export async function main(argv = process.argv.slice(2), dependencies: ProbeCliDependencies = {}): Promise<void> {
  const { values, execute } = argumentsMap(argv);
  const input = probeInput(values);
  const plan = prepareStructuredOutputProbe(input);
  if (!execute) { await writePrivateReport(values.get("--report"), { mode: "offline_preparation", ...plan.safePlan }); return; }
  const guarded = executionGuards(values, plan, (dependencies.now ?? (() => new Date()))());
  const reportPath = values.get("--report");
  if (!reportPath) throw new Error("--execute requires a private --report path reserved before dispatch.");
  const report = await reservePrivateReport(reportPath);
  let pool: { end(): Promise<void> } | null = null;
  let transport: { close(): Promise<void> } | null = null;
  try {
    // The shared runtime config historically treats argv[2] as a service role.
    // This standalone CLI owns argv, so flags must never become APP_ROLE values.
    process.env.APP_ROLE ??= "all";
    const { loadRuntimeConfig, createDatabasePool, initialOwnerId, createWorkerProviderApplicationComposition, createProviderTransport, createProviderNetworkPolicy } = await (dependencies.loadLiveRuntime ?? defaultLiveRuntime)();
    const runtime = loadRuntimeConfig();
    pool = createDatabasePool(runtime.databaseUrl, 2);
    transport = createProviderTransport({ policy: createProviderNetworkPolicy({ allowlist: runtime.security.providerNetworkAllowlist }) });
    const owner = await initialOwnerId(pool);
    const providers = createWorkerProviderApplicationComposition(pool, { credentialSecret: runtime.credentialEncryptionKey, transport });
    const provider = await providers.generation.execution.text({ ownerUserId: owner }, guarded.profileId, "text", input.model, input.contextTokens);
    if (provider.providerType !== "openrouter" || provider.model !== input.model || provider.endpointIdentity !== plan.endpointIdentity
      || provider.configuration.textResponseFormatPolicy !== "required" || provider.configuration.streaming !== true
      || provider.configuration.streamingSupport !== true) throw new Error("Selected profile does not match the prepared OpenRouter configuration.");
    const profileHash = (await import("../services/runtime/src/provider-capability-cache.js")).capabilityRouteConfigHash(provider.configuration);
    if (profileHash !== plan.routeConfigHash) throw new Error("Selected profile route configuration changed after preparation.");
    const result = await runStructuredOutputProbe(plan, async (request) => {
      const result = await provider.execute(providerRequestForPreparedProbe(request, plan.routeConfigHash), { maxOutputTokens: input.maxOutputTokens, temperature: input.temperature });
      return { content: result.content, finishReason: result.finishReason, returnedModel: result.returnedModel, returnedProviderRoute: result.returnedProviderRoute, preparedRequest: result.preparedRequest };
    });
    await report.write({ mode: "execute", executionAuthorization: guarded.authorization, safePlan: plan.safePlan, result });
    process.stdout.write(`${report.target}\n`);
  } catch {
    await report.write({ mode: "execute", executionAuthorization: guarded.authorization, safePlan: plan.safePlan, result: { proposedRecords: [], failure: { call: 0, reason: "runtime_preflight_failure" }, observations: [] } }).catch(() => undefined);
    throw new Error("Probe execution failed; the private failure report contains the safe status.");
  } finally {
    const cleanup = await Promise.allSettled([transport?.close(), pool?.end(), report.close()].filter((value): value is Promise<void> => Boolean(value)));
    if (cleanup.some((result) => result.status === "rejected")) process.stderr.write("Probe cleanup encountered a safe close failure.\n");
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
