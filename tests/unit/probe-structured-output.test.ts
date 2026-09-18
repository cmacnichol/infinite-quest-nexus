import { Ajv } from "ajv";
import { expect, it, vi } from "vitest";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
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
  priceObservedAt: "2026-09-18T18:52:22.331Z"
};

it("prepares twelve offline synthetic request shapes without loading live runtime or fetching", async () => {
  const loadLiveRuntime = vi.fn();
  const fetch = vi.fn();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  const plan = prepareStructuredOutputProbe(options);

  await probeCli(["--price-observed-at", options.priceObservedAt], { loadLiveRuntime });
  expect(loadLiveRuntime).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
  expect(plan.requests).toHaveLength(12);
  expect(plan.profileId).toBeNull();
  expect(plan.safePlan).toMatchObject({
    model: "deepseek/deepseek-v3.2-exp",
    route: "novita/fp8",
    requestCount: 12,
    maxInferenceCostUsd: 0.540918
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

  expect(() => prepareStructuredOutputProbe({ ...options, maxCalls: 11 })).toThrow(/12/);
  expect(() => prepareStructuredOutputProbe({ ...options, maxOutputTokens: 2047 })).toThrow(/2048/);
});

it("serializes registered strict schemas for the exact selected full route and derives the conservative cost ceiling", () => {
  const plan = prepareStructuredOutputProbe(options);
  const largest = Math.max(...plan.requests.map((request) => request.bodyByteCount));

  expect(plan.safePlan.largestBodyByteCount).toBe(largest);
  expect(plan.safePlan.routeConfigHash).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.safePlan.maxInferenceCostUsd).toBe(0.540918);
  for (const request of plan.requests) {
    const body = JSON.parse(request.body);
    expect(body.provider).toEqual({ require_parameters: true, only: ["novita/fp8"] });
    expect(body.response_format.json_schema.name).toBe(getProviderOutputSchema(request.operation).name);
    expect(request.schemaHash).toBe(getProviderOutputSchema(request.operation).schemaHash);
  }
  expect(JSON.parse(plan.requests[0]!.body).messages[1].content).toContain("tracker_updates");
});

it("keeps both synthetic nested tracker values through production parsing and validates every wire schema", () => {
  const plan = prepareStructuredOutputProbe(options);
  const validator = new Ajv({ strict: false, allErrors: true });
  for (const request of plan.requests) {
    const wire = request.syntheticResponse;
    expect(validator.compile(getProviderOutputSchema(request.operation).schema)(wire)).toBe(true);
    expect(request.validate(wire)).toEqual({ ok: true });
  }
  const stories = plan.requests.filter((request) => request.operation === "story");
  expect(stories).toHaveLength(4);
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
  expect(result.observations).toEqual([{ call: 1, operation: "story", streaming: false, status: "failed", returnedModel: "DeepSeek V3.2 Exp", returnedProviderRoute: "Novita" }]);
});

it("qualifies all twelve synthetic calls and produces only complete proposed verification records", async () => {
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
  expect(result.proposedRecords).toHaveLength(12);
  expect(result.proposedRecords.every((record) => record.endpointIdentity === plan.endpointIdentity
    && record.routeConfigHash === plan.routeConfigHash
    && record.providerRoutingSlugs[0] === "novita/fp8")).toBe(true);
  expect(result.currentWorkerInvocationCoverage).toEqual(["story:stream", "story:nonstream", "choices:nonstream", "continuity_review:nonstream"]);
});

it("rejects stale price evidence and refuses execution before runtime loading when no private report is reserved", async () => {
  expect(() => validateExecutionPriceObservation(options.priceObservedAt, "2026-09-19T18:52:22.332Z")).toThrow(/current/);
  await expect(probeCli([
    "--execute", "--model", options.model, "--route", options.route,
    "--input-usd-per-token", String(options.inputUsdPerToken), "--output-usd-per-token", String(options.outputUsdPerToken),
    "--price-observed-at", options.priceObservedAt, "--context-tokens", String(options.contextTokens),
    "--max-calls", "12", "--max-output-tokens", "2048", "--max-input-tokens", "163840",
    "--max-cost-usd", "0.540918", "--accept-max-cost-usd", "0.540918",
    "--profile-id", "11111111-1111-4111-8111-111111111111", "--execution-authorization", "approved"
  ])).rejects.toThrow(/private --report/);
});
