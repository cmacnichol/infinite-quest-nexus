import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { deriveTextExecutionPlan, textExecutionPlanHash, textExecutionRouteBasisHash, type TextExecutionPlan } from "../../packages/contracts/src/text-execution-plan.js";
import { frozenResponseContractsV2SelectionHash } from "../../packages/contracts/src/generation-response-contract.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { serializeCheckedBoundFrozenPresetProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import type {
  PhysicalAttemptRecord,
  PhysicalAttemptRepository
} from "../../packages/story-engine/src/preset-route-execution.js";
import {
  callTextProvider,
  createProviderTransport,
  type ProviderRequest,
  type ProviderResult
} from "../../packages/story-engine/src/providers.js";
import { createPreparedTextExecutor } from "../../services/runtime/src/prepared-text-executor.js";
import { createSharedTextProviderCapacity } from "../../services/runtime/src/text-provider-capacity.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function plan(): TextExecutionPlan {
  const draft = {
    version: 2 as const,
    selection: { kind: "model" as const, modelId: "model-a" },
    preset: null,
    candidates: [
      { modelId: "model-a", providerPolicy: { only: ["route-a"] }, contextWindowTokens: 8_000, maxOutputTokens: 1_000 },
      { modelId: "model-b", providerPolicy: { only: ["route-b"] }, contextWindowTokens: 8_000, maxOutputTokens: 1_000 }
    ],
    presetSystemPrompt: "",
    parameters: { temperature: 0.2 },
    prompt: "Write the next turn.",
    promptHash: hash("Write the next turn."),
    endpointReference: "endpoint-a",
    credentialReference: "profile-a",
    profileRevision: "profile-v1",
    authorityRevision: "authority-v1",
    requestTimeoutMs: 2_000,
    protocolVersion: "story-v2",
    planHash: "0".repeat(64)
  };
  return { ...draft, planHash: textExecutionPlanHash(draft) };
}

function result(): ProviderResult {
  return {
    content: "accepted", responseId: "response-a", finishReason: "stop", outputLimited: false,
    modelInstanceId: "instance-a", returnedModel: "model-a", returnedProviderRoute: "route-a",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {}
  };
}

function repository(recordOutput: PhysicalAttemptRepository["recordOutput"], summarize?: PhysicalAttemptRepository["summarize"]): PhysicalAttemptRepository {
  let row: PhysicalAttemptRecord | null = null;
  return {
    async summarize(scope) {
      if (summarize) return summarize(scope);
      return { attemptCount: row ? 1 : 0, completedCount: row?.status === "completed" ? 1 : 0,
        observedUsage: { inputTokens: null, outputTokens: null, totalTokens: null },
        usageCoverage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCosts: [] };
    },
    async reserve(input) {
      if (row) return row;
      row = {
        id: `attempt-${input.candidateOrdinal}`, status: "reserved", logicalReservation: input.logicalReservation,
        planProvenance: input.planProvenance, candidateOrdinal: input.candidateOrdinal, candidate: input.candidate,
        request: input.request, emittedOutput: false
      };
      return row;
    },
    async markDispatched() {
      row = row ? { ...row, status: "dispatched" } : null;
      return row;
    },
    async recordResponseStart() { return row; },
    recordOutput,
    async complete(_reservation, _attemptId, completion) {
      row = row ? { ...row, status: "completed", emittedOutput: completion.emittedOutput } : null;
      return row;
    }
  };
}

function executionInput(onChunk: (delta: string, accumulated: string) => void | Promise<void>) {
  const body = JSON.stringify({ model: "model-a" });
  return {
    plan: plan(), operation: "story_generation" as const,
    ownerUserId: "00000000-0000-4000-8000-000000000001", providerProfileId: "profile-a",
    request: { systemPrompt: "System.", input: "Act.", onChunk },
    preparedRequest: { body, payloadHash: hash(body), operation: "story generation" as const, budgetAudit: null },
    logicalReservation: {
      kind: "direct" as const, ownerUserId: "00000000-0000-4000-8000-000000000001",
      requestScopeId: randomUUID(), invocationId: randomUUID(), operation: "initial" as const
    }
  };
}

function authority(execute: (request: ProviderRequest) => Promise<ProviderResult>) {
  return {
    id: "profile-a", name: "Profile", providerRole: "text" as const, providerType: "openrouter" as const,
    model: "model-a", contextWindowTokens: 8_000, maxOutputTokens: 1_000, temperature: 0.2,
    requestTimeoutMs: 2_000, endpointIdentity: "endpoint-a", configuration: {}, authorityRevision: "authority-v1",
    execute
  };
}

describe("prepared text executor stream durability", () => {
  it("waits for capacity before reserving or charging a physical attempt", async () => {
    const attempts = repository(vi.fn());
    const reserve = vi.spyOn(attempts, "reserve");
    let available = false;
    const leases = { tryAcquire: vi.fn(async () => available ? "lease" : null), release: vi.fn(async () => {}) };
    const capacity = createSharedTextProviderCapacity(leases, 1, 1);
    const dispatch = vi.fn(async () => result());
    const executor = createPreparedTextExecutor({ attempts, capacity,
      loadAuthority: async () => authority((request) => capacity.execute({ timeoutMs: 2000,
        ...(request.abortSignal ? { signal: request.abortSignal } : {}) }, dispatch)) });
    const pending = executor.execute(executionInput(vi.fn()));
    await vi.waitFor(() => expect(leases.tryAcquire).toHaveBeenCalled());
    expect(reserve).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    available = true;
    await pending;
    expect(reserve).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(leases.release).toHaveBeenCalledTimes(1);
  });
  it.each([48_000, 8_000])("keeps the frozen review body and effective output limit with a %i route reserve", async (maxOutputTokens) => {
    const routeDraft = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "review" },
      preset: { slug: "review", versionId: "v1", configHash: hash("preset") },
      candidates: [{ modelId: "model-a", providerPolicy: { only: ["route-a"] }, contextWindowTokens: 65_536, maxOutputTokens }],
      presetSystemPrompt: "Review instructions.", parameters: { temperature: 0.2 }, endpointReference: "endpoint-a",
      credentialReference: "profile-a", profileRevision: "profile-v1", authorityRevision: "authority-v1",
      requestTimeoutMs: 2_000, protocolVersion: "text-schema-adapter-v2"
    };
    const routeBasis = { ...routeDraft, routeBasisHash: textExecutionRouteBasisHash({ ...routeDraft, routeBasisHash: hash("basis") }) };
    const invocationKey = "continuity_review:nonstream" as const;
    const operation = "story_continuity_review" as const;
    const policy = {
      version: 2 as const, policy: "required" as const, providerProfileId: "11111111-1111-4111-8111-111111111111",
      admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
      authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash, selection: routeBasis.selection,
        endpointReference: "endpoint-a", credentialReference: "profile-a", authorityRevision: "authority-v1", profileRevision: "profile-v1" },
      operationClosureVersion: 2 as const, invocationKeys: [invocationKey]
    };
    const schema = getProviderOutputSchemaV2("continuity_review");
    const selected = {
      version: 2 as const, queuedPolicy: policy, selectedAt: "2026-09-22T00:00:00.000Z", capabilityEvidenceHash: hash("capability"),
      contracts: { [invocationKey]: { version: 2 as const, mode: "json_schema" as const, admission: policy.admission,
        operation: "continuity_review" as const, streaming: false, forbidFormatFallback: true as const,
        schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema,
        authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash } } }
    };
    const frozen = { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
    const trustedOperationPrompt = "Check the final story.";
    const reviewPlan = deriveTextExecutionPlan(routeBasis, trustedOperationPrompt);
    const request = { systemPrompt: reviewPlan.prompt, input: "Complete evidence. ".repeat(2_500), budgetOutput: { kind: "continuity_review" as const } };
    const expectedOutputTokens = Math.min(maxOutputTokens, 16_384);
    const preparedRequest = serializeCheckedBoundFrozenPresetProviderRequest({
      providerType: "openrouter", baseUrl: "", model: "model-a", contextWindowTokens: 65_536, maxOutputTokens, temperature: 0.2
    }, request, { frozen, routeBasis, plan: reviewPlan, invocationKey, operation, trustedOperationPrompt }, {
      inputLimit: 65_536 - expectedOutputTokens, count: (value) => Math.ceil(value.length / 3), output: request.budgetOutput
    });
    const execute = vi.fn(async (sent: ProviderRequest) => {
      expect(sent.preparedRequest?.body).toBe(preparedRequest.body);
      expect(sent.preparedRequest?.payloadHash).toBe(preparedRequest.payloadHash);
      expect(JSON.parse(sent.preparedRequest!.body).max_tokens).toBe(expectedOutputTokens);
      return result();
    });
    const executor = createPreparedTextExecutor({ attempts: repository(vi.fn()), loadAuthority: async () => authority(execute) });
    await expect(executor.execute({ ...executionInput(vi.fn()), plan: reviewPlan, operation, request, preparedRequest,
      routeBasis, frozenResponseContracts: frozen, invocationKey, trustedOperationPrompt
    })).resolves.toMatchObject({ content: "accepted" });
    expect(execute).toHaveBeenCalledOnce();
    expect(routeBasis.candidates[0]!.maxOutputTokens).toBe(maxOutputTokens);
  });

  it.each([false, true])("dispatches Story JSON Schema through the preset, including recovery=%s", async (recovery) => {
    const maxOutputTokens = 8_000;
    const routeDraft = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "review" },
      preset: { slug: "review", versionId: "v1", configHash: hash("preset") },
      candidates: [{ modelId: "@preset/review", providerPolicy: {}, contextWindowTokens: 65_536, maxOutputTokens }],
      presetSystemPrompt: "Review instructions.", parameters: { temperature: 0.2 }, endpointReference: "endpoint-a",
      credentialReference: "profile-a", profileRevision: "profile-v1", authorityRevision: "authority-v1",
      requestTimeoutMs: 2_000, protocolVersion: "text-schema-adapter-v2"
    };
    const routeBasis = { ...routeDraft, routeBasisHash: textExecutionRouteBasisHash({ ...routeDraft, routeBasisHash: hash("basis") }) };
    const invocationKey = "story:stream" as const;
    const operation = "story_generation" as const;
    const policy = {
      version: 2 as const, policy: "required" as const, providerProfileId: "11111111-1111-4111-8111-111111111111",
      admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
      authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash, selection: routeBasis.selection,
        endpointReference: "endpoint-a", credentialReference: "profile-a", authorityRevision: "authority-v1", profileRevision: "profile-v1" },
      operationClosureVersion: 2 as const, invocationKeys: [invocationKey]
    };
    const schema = getProviderOutputSchemaV2("story");
    const selected = {
      version: 2 as const, queuedPolicy: policy, selectedAt: "2026-09-22T00:00:00.000Z", capabilityEvidenceHash: hash("capability"),
      contracts: { [invocationKey]: { version: 2 as const, mode: "json_schema" as const, admission: policy.admission,
        operation: "story" as const, streaming: true, forbidFormatFallback: true as const,
        schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema,
        authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash } } }
    };
    const frozen = { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
    const trustedOperationPrompt = "Check the final story.";
    const reviewPlan = deriveTextExecutionPlan(routeBasis, trustedOperationPrompt);
    const request = { systemPrompt: reviewPlan.prompt, input: "A visitor asks to enter.", onChunk: vi.fn(),
      ...(recovery ? { recoveryInput: "Return a complete valid replacement." } : {}), budgetOutput: { kind: "story_append" as const } };
    const expectedOutputTokens = Math.min(maxOutputTokens, 16_384);
    const preparedRequest = serializeCheckedBoundFrozenPresetProviderRequest({
      providerType: "openrouter", baseUrl: "", model: "@preset/review", contextWindowTokens: 65_536, maxOutputTokens, temperature: 0.2
    }, request, { frozen, routeBasis, plan: reviewPlan, invocationKey, operation, trustedOperationPrompt }, {
      inputLimit: 65_536 - expectedOutputTokens, count: (value) => Math.ceil(value.length / 3), output: request.budgetOutput
    });
    const execute = vi.fn(async (sent: ProviderRequest) => {
      expect(sent.preparedRequest?.body).toBe(preparedRequest.body);
      expect(sent.preparedRequest?.payloadHash).toBe(preparedRequest.payloadHash);
      expect(JSON.parse(sent.preparedRequest!.body).max_tokens).toBe(expectedOutputTokens);
      const body = JSON.parse(sent.preparedRequest!.body);
      expect(body.model).toBe("@preset/review");
      expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
      expect(body).not.toHaveProperty("provider");
      expect(body).not.toHaveProperty("models");
      return { ...result(), returnedModel: "fallback-model", returnedProviderRoute: "remote-route" };
    });
    const attempts = repository(vi.fn());
    const complete = vi.spyOn(attempts, "complete");
    const loadAuthority = vi.fn(async () => authority(execute));
    const executor = createPreparedTextExecutor({ attempts, loadAuthority });
    await expect(executor.execute({ ...executionInput(vi.fn()), plan: reviewPlan, operation, request, preparedRequest,
      routeBasis, frozenResponseContracts: frozen, invocationKey, trustedOperationPrompt
    })).resolves.toMatchObject({ content: "accepted" });
    expect(execute).toHaveBeenCalledOnce();
    expect(loadAuthority).toHaveBeenCalledWith(expect.any(String), "profile-a", "@preset/review");
    expect(complete).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      returnedModel: "fallback-model", returnedProviderRoute: "remote-route", outcome: "succeeded"
    }));
    expect(routeBasis.candidates[0]!.maxOutputTokens).toBe(maxOutputTokens);
  });

  it("waits for durable output evidence before exposing a provider chunk", async () => {
    let release!: (value: PhysicalAttemptRecord) => void;
    const persisted = new Promise<PhysicalAttemptRecord>((resolve) => { release = resolve; });
    const recordOutput = vi.fn(() => persisted);
    const externalChunk = vi.fn();
    const provider = authority(async (request) => {
      expect(request.responseFormatFallback).toBe("forbid");
      await request.onChunk?.("delta", "accumulated");
      return result();
    });
    const executor = createPreparedTextExecutor({ attempts: repository(recordOutput), loadAuthority: async () => provider });

    const pending = executor.execute(executionInput(externalChunk));
    await vi.waitFor(() => expect(recordOutput).toHaveBeenCalledOnce());
    expect(externalChunk).not.toHaveBeenCalled();
    release({} as PhysicalAttemptRecord);
    await expect(pending).resolves.toMatchObject({ content: "accepted", physicalAttemptId: "attempt-0",
      physicalAccounting: { attemptCount: 1, completedCount: 1 } });
    expect(externalChunk).toHaveBeenCalledWith("delta", "accumulated");
  });

  it("contains output-persistence rejection before chunk emission and route advancement", async () => {
    const recordOutput = vi.fn(async () => { throw new Error("lease write rejected"); });
    const externalChunk = vi.fn();
    const execute = vi.fn(async (request: ProviderRequest) => {
      await request.onChunk?.("delta", "accumulated");
      return result();
    });
    const loadAuthority = vi.fn(async () => authority(execute));
    const executor = createPreparedTextExecutor({ attempts: repository(recordOutput), loadAuthority });

    await expect(executor.execute(executionInput(externalChunk))).rejects.toMatchObject({
      name: "PreparedRouteTerminalError", reason: "unknown", attemptId: "attempt-0",
      physicalAccounting: { attemptCount: 1, completedCount: 1 }
    });
    expect(externalChunk).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(loadAuthority).toHaveBeenCalledOnce();
  });

  it("keeps successful content when a post-completion accounting read fails and never resends on replay", async () => {
    const execute = vi.fn(async () => result());
    const attempts = repository(vi.fn(), vi.fn(async () => { throw new Error("accounting read unavailable"); }));
    const executor = createPreparedTextExecutor({ attempts, loadAuthority: async () => authority(execute) });
    const input = executionInput(vi.fn());

    await expect(executor.execute(input)).resolves.toMatchObject({ content: "accepted", physicalAttemptId: "attempt-0" });
    expect(execute).toHaveBeenCalledOnce();
    await expect(executor.execute(input)).rejects.toMatchObject({ code: "prepared_route_unknown_outcome" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps a prepared illustration schema request intact after a response-format rejection", async () => {
    const sentBodies: string[] = [];
    const completions: unknown[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(String(init?.body));
      if (sentBodies.length === 1) {
        return new Response(JSON.stringify({ error: { code: "response_format_unsupported", message: "response_format unsupported" } }), {
          status: 400
        });
      }
      return new Response(JSON.stringify({
        id: "must-not-accept", model: "model-a", provider: "route-a",
        choices: [{ message: { content: '{"image_prompt":"must not accept"}' }, finish_reason: "stop" }], usage: {}
      }), { status: 200 });
    });
    const transport = createProviderTransport({
      fetcher: fetcher as typeof fetch,
      dispatcherFactory: () => ({ close: async () => undefined, destroy: () => undefined }) as never,
      policy: {
        async approve(url) {
          return { url, origin: url.origin, address: "127.0.0.1", family: 4, port: 443, servername: url.hostname };
        }
      }
    });
    const originalBody = JSON.stringify({
      model: "model-a",
      messages: [{ role: "system", content: "Frozen illustration instructions." }, { role: "user", content: "Refine the image prompt." }],
      response_format: { type: "json_schema", json_schema: { name: "infinite_quest_illustration_prompt_refinement_v1", strict: true, schema: { type: "object" } } },
      provider: { only: ["route-a"], require_parameters: true }
    });
    const attempts = repository(vi.fn());
    const complete = attempts.complete;
    const trackedAttempts: PhysicalAttemptRepository = {
      ...attempts,
      complete: async (reservation, attemptId, completion) => {
        completions.push(completion);
        return complete(reservation, attemptId, completion);
      }
    };
    const provider = authority((request) => callTextProvider({
      providerType: "openrouter", baseUrl: "https://openrouter.example.test/api/v1", model: "model-a",
      contextWindowTokens: 8_000, maxOutputTokens: 1_000, temperature: 0.2
    }, request, transport));
    const executor = createPreparedTextExecutor({ attempts: trackedAttempts, loadAuthority: async () => provider });
    const input = {
      ...executionInput(vi.fn()),
      preparedRequest: { body: originalBody, payloadHash: hash(originalBody), operation: "story generation" as const, budgetAudit: null }
    };

    await expect(executor.execute(input)).rejects.toMatchObject({ name: "PreparedRouteTerminalError", attemptId: "attempt-0" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(sentBodies[0]!)).toEqual(JSON.parse(originalBody));
    expect(completions).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});
