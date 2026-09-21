import { Ajv } from "ajv";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import { loadSchemaVerificationFile } from "../../services/runtime/src/provider-schema-verification.js";
import {
  DEFAULT_STRUCTURED_OUTPUT_PROBE,
  prepareStructuredOutputProbe,
  runStructuredOutputProbe,
  validateExecutionPriceObservation,
  type ProbeExecutor
} from "../../scripts/lib/structured-output-probe.js";
import { main as probeCli } from "../../scripts/probe-structured-output.js";

const options = {
  ...DEFAULT_STRUCTURED_OUTPUT_PROBE,
  route: "novita/fp8",
  priceObservedAt: "2026-09-18T18:52:22.331Z"
};

it("requires configured preset routing as explicit input instead of silently selecting a public route", async () => {
  const loadLiveRuntime = vi.fn();
  await expect(probeCli(["--price-observed-at", options.priceObservedAt], { loadLiveRuntime }))
    .rejects.toThrow(/route/);
  expect(loadLiveRuntime).not.toHaveBeenCalled();
});

it("prepares the complete v2 operation and stream catalog without loading live runtime or fetching", async () => {
  const loadLiveRuntime = vi.fn();
  const fetch = vi.fn();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  const plan = prepareStructuredOutputProbe(options);

  await probeCli(["--route", options.route, "--price-observed-at", options.priceObservedAt], { loadLiveRuntime });
  expect(loadLiveRuntime).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
  expect(plan.requests).toHaveLength(17);
  expect(plan.profileId).toBeNull();
  expect(plan.safePlan).toMatchObject({
    model: "deepseek/deepseek-v3.2-exp",
    route: "novita/fp8",
    configuredCandidateOrder: ["novita/fp8"],
    pricingScope: "hypothetical_explicit_candidate_set",
    targetPreset: "@preset/nexus-nsfw",
    requestCount: 17,
    maxInferenceCostUsd: 0.766301
  });
  expect(JSON.stringify(plan.safePlan)).not.toContain("Synthetic lantern");
  expect(JSON.stringify(plan.safePlan)).not.toContain("secret");
});

it("rejects invalid execution ceilings and non-canonical target metadata before dispatch", () => {
  for (const invalid of [
    { ...options, model: "@preset/nexus-nsfw" },
    { ...options, route: "novita" },
    { ...options, inputUsdPerToken: 0 },
    { ...options, priceObservedAt: "not-a-timestamp" },
    { ...options, contextTokens: 163_839 }
  ]) expect(() => prepareStructuredOutputProbe(invalid)).toThrow();

  expect(() => prepareStructuredOutputProbe({ ...options, maxCalls: 16 })).toThrow(/17/);
  expect(() => prepareStructuredOutputProbe({ ...options, maxOutputTokens: 2047 })).toThrow(/2048/);
});

it("serializes registered strict schemas for the exact selected full route and derives the conservative cost ceiling", () => {
  const plan = prepareStructuredOutputProbe(options);
  const largest = Math.max(...plan.requests.map((request) => request.bodyByteCount));

  expect(plan.safePlan.largestBodyByteCount).toBe(largest);
  expect(plan.safePlan.routeConfigHash).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.safePlan.maxInferenceCostUsd).toBe(0.766301);
  for (const request of plan.requests) {
    const body = JSON.parse(request.body);
    expect(body.provider).toEqual({ require_parameters: true, only: ["novita/fp8"] });
    expect(body.response_format.json_schema.name).toBe(getProviderOutputSchemaV2(request.operation).name);
    expect(request.schemaHash).toBe(getProviderOutputSchemaV2(request.operation).schemaHash);
  }
  expect(JSON.parse(plan.requests[0]!.body).messages[1].content).toContain("tracker_updates");
});

it("keeps synthetic nested tracker values through production parsing and validates every wire schema", () => {
  const plan = prepareStructuredOutputProbe(options);
  const validator = new Ajv({ strict: false, allErrors: true });
  for (const request of plan.requests) {
    const wire = request.syntheticResponse;
    expect(validator.compile(getProviderOutputSchemaV2(request.operation).schema)(wire)).toBe(true);
    expect(request.validate(wire)).toEqual({ ok: true });
  }
  const stories = plan.requests.filter((request) => request.operation === "story");
  expect(stories).toHaveLength(2);
  expect(stories.every((request) => request.validate(request.syntheticResponse).ok)).toBe(true);
});

it("stops at the first failed synthetic response and fabricates no proposed record", async () => {
  const plan = prepareStructuredOutputProbe(options);
  const execute = vi.fn<ProbeExecutor>(async (request) => ({
    content: JSON.stringify(request.syntheticResponse),
    finishReason: "stop",
    returnedModel: request.model,
    returnedProviderRoute: request.route,
    preparedRequest: { body: request.body, payloadHash: request.payloadHash }
  }));
  execute.mockImplementationOnce(async () => ({
    content: "{",
    finishReason: "stop",
    returnedModel: "DeepSeek V3.2 Exp",
    returnedProviderRoute: "Novita",
    preparedRequest: { body: plan.requests[0]!.body, payloadHash: plan.requests[0]!.payloadHash }
  }));

  const result = await runStructuredOutputProbe(plan, execute);

  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.proposedRecords).toEqual([]);
  expect(result.failure).toMatchObject({ call: 1, reason: "response_identity_or_completion" });
  expect(result.observations).toEqual([{ call: 1, operation: "story", streaming: true, status: "failed", returnedModel: "DeepSeek V3.2 Exp", returnedProviderRoute: "Novita" }]);
});

it.each([
  ["timeout", async () => { throw new Error("timeout"); }, "timeout"],
  ["refusal", async () => { throw new Error("refusal"); }, "refusal"],
  ["partial stream", async (request: any) => ({ content: JSON.stringify(request.syntheticResponse), finishReason: "length", returnedModel: request.model, returnedProviderRoute: request.route, preparedRequest: { body: request.body, payloadHash: request.payloadHash } }), "response_identity_or_completion"],
  ["malformed JSON", async (request: any) => ({ content: "{", finishReason: "stop", returnedModel: request.model, returnedProviderRoute: request.route, preparedRequest: { body: request.body, payloadHash: request.payloadHash } }), "invalid_json"],
  ["wire schema", async (request: any) => ({ content: JSON.stringify({ ...request.syntheticResponse, narration: "" }), finishReason: "stop", returnedModel: request.model, returnedProviderRoute: request.route, preparedRequest: { body: request.body, payloadHash: request.payloadHash } }), "wire_schema"],
  ["tracker data loss", async (request: any) => ({ content: JSON.stringify({ ...request.syntheticResponse, tracker_updates: [] }), finishReason: "stop", returnedModel: request.model, returnedProviderRoute: request.route, preparedRequest: { body: request.body, payloadHash: request.payloadHash } }), "story_parser"]
])("stops after the first %s without a proposed record", async (_label, execute, reason) => {
  const plan = prepareStructuredOutputProbe(options);
  const dispatch = vi.fn(execute as ProbeExecutor);
  const result = await runStructuredOutputProbe(plan, dispatch);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ proposedRecords: [], failure: { call: 1, reason } });
});

it("qualifies the complete v2 catalog and round-trips proposed records through the production loader and eligibility gate", async () => {
  const plan = prepareStructuredOutputProbe(options);
  const execute: ProbeExecutor = async (request) => ({
    content: JSON.stringify(request.syntheticResponse),
    finishReason: "stop",
    returnedModel: request.model,
    returnedProviderRoute: request.route,
    preparedRequest: { body: request.body, payloadHash: request.payloadHash }
  });

  const result = await runStructuredOutputProbe(plan, execute, { now: "2026-09-18T18:52:22.331Z" });

  expect(result.failure).toBeNull();
  expect(result.proposedRecords).toHaveLength(17);
  expect(result.proposedRecords.every((record) => record.version === 2 && record.adapterProtocol === "text-schema-adapter-v2")).toBe(true);
  expect(result.proposedRecords.every((record) => record.endpointIdentity === plan.endpointIdentity
    && record.routeConfigHash === plan.routeConfigHash
    && record.providerRoutingSlugs[0] === "novita/fp8")).toBe(true);
  expect(result.currentWorkerInvocationCoverage).toHaveLength(17);

  const directory = join(tmpdir(), `iq-probe-records-${Date.now()}-${Math.random()}`);
  const recordsPath = join(directory, "records.json");
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  await mkdir(directory);
  try {
    await writeFile(recordsPath, JSON.stringify(result.proposedRecords));
    const loaded = loadSchemaVerificationFile(recordsPath, { now: () => Date.parse("2026-09-18T18:52:22.331Z") });
    expect(loaded.records).toHaveLength(17);
    const capabilities = createProviderResponseFormatCapabilities({ records: loaded.records, registryDigest: loaded.digest, now: () => Date.parse("2026-09-18T18:52:22.331Z") });
    for (const record of result.proposedRecords) {
      const eligibility = capabilities.eligibilityV2({
        advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-18T18:52:22.331Z" },
        providerType: "openrouter", endpointIdentity: record.endpointIdentity, model: record.model,
        routeConfigHash: record.routeConfigHash, adapterProtocol: "text-schema-adapter-v2",
        operation: record.operation, schemaHash: record.schemaHash, streaming: record.streaming,
        now: "2026-09-18T18:52:22.331Z", nativeOpenTrackerObjects: record.nativeOpenTrackerObjects
      });
      expect(eligibility.status).toBe("verified");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects stale price evidence and refuses execution before runtime loading when no private report is reserved", async () => {
  expect(() => validateExecutionPriceObservation(options.priceObservedAt, "2026-09-19T18:52:22.332Z")).toThrow(/current/);
  const loadLiveRuntime = vi.fn();
  await expect(probeCli([
    "--execute", "--model", options.model, "--route", options.route,
    "--input-usd-per-token", String(options.inputUsdPerToken), "--output-usd-per-token", String(options.outputUsdPerToken),
    "--price-observed-at", options.priceObservedAt, "--context-tokens", String(options.contextTokens),
    "--max-calls", "17", "--max-output-tokens", "2048", "--max-input-tokens", "163840",
    "--max-cost-usd", "0.766301", "--accept-max-cost-usd", "0.766301",
    "--profile-id", "11111111-1111-4111-8111-111111111111", "--execution-authorization", "approved"
  ], { loadLiveRuntime, now: () => new Date(options.priceObservedAt) })).rejects.toThrow(/private --report/);
  expect(loadLiveRuntime).not.toHaveBeenCalled();
});

it("rejects unknown, duplicate, and missing execute guards before loading runtime", async () => {
  const loadLiveRuntime = vi.fn();
  for (const args of [
    ["--unknown"],
    ["--price-observed-at", options.priceObservedAt, "--price-observed-at", options.priceObservedAt],
    ["--execute", "--model", options.model]
  ]) await expect(probeCli(args, { loadLiveRuntime, now: () => new Date(options.priceObservedAt) })).rejects.toThrow();
  expect(loadLiveRuntime).not.toHaveBeenCalled();
});

it.each([
  ["--max-input-tokens", "163839"],
  ["--max-cost-usd", "0.766300"],
  ["--accept-max-cost-usd", "0.766300"]
])("rejects a fully specified below-ceiling %s before loading runtime", async (changedFlag, changedValue) => {
  const report = join(tmpdir(), `iq-probe-guard-${Date.now()}-${Math.random()}.json`);
  const loadLiveRuntime = vi.fn();
  const args = [
    "--execute", "--model", options.model, "--route", options.route,
    "--input-usd-per-token", String(options.inputUsdPerToken), "--output-usd-per-token", String(options.outputUsdPerToken),
    "--price-observed-at", options.priceObservedAt, "--context-tokens", "163840", "--max-calls", "17", "--max-output-tokens", "2048",
    "--max-input-tokens", "163840", "--max-cost-usd", "0.766301", "--accept-max-cost-usd", "0.766301",
    "--profile-id", "11111111-1111-4111-8111-111111111111", "--execution-authorization", "approved", "--report", report
  ];
  args[args.indexOf(changedFlag) + 1] = changedValue;
  await expect(probeCli(args, { loadLiveRuntime, now: () => new Date(options.priceObservedAt) }))
    .rejects.toThrow("Execution ceilings do not cover the prepared conservative bound exactly.");
  expect(loadLiveRuntime).not.toHaveBeenCalled();
});

it("keeps dry-run stdout free of synthetic prompt content", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await probeCli(["--route", options.route, "--price-observed-at", options.priceObservedAt], { loadLiveRuntime: vi.fn() });
    expect(write.mock.calls.join("\n")).not.toContain("tracker_updates");
  } finally { write.mockRestore(); }
});

it("sets the standalone runtime role for documented execute arguments and attempts every cleanup", async () => {
  const report = join(tmpdir(), `iq-probe-${Date.now()}-${Math.random()}.json`);
  const previousRole = process.env.APP_ROLE;
  delete process.env.APP_ROLE;
  const poolEnd = vi.fn(async () => undefined);
  const transportClose = vi.fn(async () => { throw new Error("close"); });
  const loadLiveRuntime = vi.fn(async () => ({
    loadRuntimeConfig: () => ({ databaseUrl: "unused", credentialEncryptionKey: "unused", security: { providerNetworkAllowlist: [] } }),
    createDatabasePool: () => ({ end: poolEnd }),
    initialOwnerId: async () => { expect(process.env.APP_ROLE).toBe("all"); throw new Error("preflight"); },
    createProviderTransport: () => ({ close: transportClose }),
    createProviderNetworkPolicy: () => ({}),
    createWorkerProviderApplicationComposition: vi.fn()
  }));
  try {
    await expect(probeCli([
      "--execute", "--model", options.model, "--route", options.route, "--input-usd-per-token", String(options.inputUsdPerToken), "--output-usd-per-token", String(options.outputUsdPerToken), "--price-observed-at", options.priceObservedAt, "--context-tokens", "163840", "--max-calls", "17", "--max-output-tokens", "2048", "--max-input-tokens", "163840", "--max-cost-usd", "0.766301", "--accept-max-cost-usd", "0.766301", "--profile-id", "11111111-1111-4111-8111-111111111111", "--execution-authorization", "approved", "--report", report
    ], { loadLiveRuntime, now: () => new Date(options.priceObservedAt) })).rejects.toThrow(/Probe execution failed/);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
  } finally {
    if (previousRole === undefined) delete process.env.APP_ROLE; else process.env.APP_ROLE = previousRole;
    await unlink(report).catch(() => undefined);
  }
});
