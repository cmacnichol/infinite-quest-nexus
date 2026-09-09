import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type StoryOnlyBenchmarkSample = Readonly<{
  setupMs: number;
  durationMs: number;
  operations: readonly string[];
  committed: boolean;
  failures: number;
  requestTokens: number;
  outputTokens: number;
  providerReportedTokens: number | null;
}>;

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

export function summarizeStoryOnlyBenchmark(samples: readonly StoryOnlyBenchmarkSample[]) {
  const operationCounts: Record<string, number> = {};
  const operationGroups: Record<string, number> = {};
  let failureCount = 0;
  let committedSamples = 0;
  let requestTokens = 0;
  let outputTokens = 0;
  let providerReportedTokens = 0;
  let providerTokensKnown = true;
  for (const sample of samples) {
    failureCount += sample.failures;
    if (sample.committed) committedSamples += 1;
    requestTokens += sample.requestTokens;
    outputTokens += sample.outputTokens;
    if (sample.providerReportedTokens === null) providerTokensKnown = false;
    else providerReportedTokens += sample.providerReportedTokens;
    const group = sample.operations.join(" -> ") || "none";
    operationGroups[group] = (operationGroups[group] ?? 0) + 1;
    for (const operation of sample.operations) operationCounts[operation] = (operationCounts[operation] ?? 0) + 1;
  }
  return Object.freeze({
    setupMs: Object.freeze({ p50: percentile(samples.map((sample) => sample.setupMs), 0.5), p95: percentile(samples.map((sample) => sample.setupMs), 0.95) }),
    latencyMs: Object.freeze({ p50: percentile(samples.map((sample) => sample.durationMs), 0.5), p95: percentile(samples.map((sample) => sample.durationMs), 0.95) }),
    operationCounts: Object.freeze(operationCounts),
    operationGroups: Object.freeze(operationGroups),
    failureCount,
    committedSamples,
    uncommittedSamples: samples.length - committedSamples,
    estimatedTokens: Object.freeze({ request: requestTokens, output: outputTokens }),
    providerReportedTokens: providerTokensKnown ? providerReportedTokens : null
  });
}

function option(args: readonly string[], flag: string, fallback: number | string): number | string {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`Missing value for ${flag}.`);
  return typeof fallback === "number" ? Number(value) : value;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const warmups = option(args, "--warmups", 3) as number;
  const samples = option(args, "--samples", 20) as number;
  const seed = option(args, "--seed", "story-only-v1") as string;
  const output = option(args, "--output", "tmp/story-only-benchmark") as string;
  if (!Number.isInteger(warmups) || warmups < 0 || !Number.isInteger(samples) || samples < 1) {
    throw new Error("--warmups must be non-negative and --samples must be positive integers.");
  }
  const { createStoryOnlyFixture, runStoryOnlyFixture } = await import("../tests/helpers/story-only-generation-fixtures.js");
  const modes = ["legacy_action", "legacy_scene", "legacy_events", "story_only"] as const;
  const measurements: Record<string, Record<string, StoryOnlyBenchmarkSample[]>> = {};
  let postgresVersion = "unavailable";
  for (const playMode of modes) {
    measurements[playMode] = { zeroDelay: [], hundredMsDelay: [] };
    for (const delayMs of [0, 100] as const) {
      for (let index = 0; index < warmups + samples; index += 1) {
        const fixture = await createStoryOnlyFixture({ playMode, scenario: "clean", delayMs, seed: `${seed}-${playMode}-${delayMs}-${index}` });
        try {
          const result = await runStoryOnlyFixture(fixture);
          postgresVersion = result.postgresVersion;
          if (index >= warmups) {
            measurements[playMode]![delayMs === 0 ? "zeroDelay" : "hundredMsDelay"]!.push({
              durationMs: result.timingsMs.generation,
              setupMs: result.timingsMs.setup,
              operations: result.operations,
              committed: result.committed,
              failures: result.failures,
              requestTokens: result.tokenEstimates.request,
              outputTokens: result.tokenEstimates.output,
              providerReportedTokens: result.providerReportedTokens
            });
          }
        } finally {
          await fixture.close();
        }
      }
    }
  }
  const results = Object.fromEntries(modes.map((mode) => [mode, Object.freeze({
    zeroDelay: summarizeStoryOnlyBenchmark(measurements[mode]!.zeroDelay!),
    hundredMsDelay: summarizeStoryOnlyBenchmark(measurements[mode]!.hundredMsDelay!)
  })]));
  const report = Object.freeze({
    benchmark: "story-only-generation-v1",
    synthetic: true,
    note: "Synthetic wall time is harness timing and is not model-speed evidence.",
    node: process.version,
    postgresVersion,
    seed,
    warmups,
    samples,
    results: Object.freeze(results)
  });
  const outputDirectory = resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "story-only-generation-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
