import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { textExecutionPlanHash, type TextExecutionPlan } from "../../packages/contracts/src/text-execution-plan.js";
import type {
  PhysicalAttemptRecord,
  PhysicalAttemptRepository
} from "../../packages/story-engine/src/preset-route-execution.js";
import type { ProviderRequest, ProviderResult } from "../../packages/story-engine/src/providers.js";
import { createPreparedTextExecutor } from "../../services/runtime/src/prepared-text-executor.js";

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

function repository(recordOutput: PhysicalAttemptRepository["recordOutput"]): PhysicalAttemptRepository {
  let row: PhysicalAttemptRecord | null = null;
  return {
    async reserve(input) {
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
      requestScopeId: randomUUID(), operation: "initial" as const
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
  it("waits for durable output evidence before exposing a provider chunk", async () => {
    let release!: (value: PhysicalAttemptRecord) => void;
    const persisted = new Promise<PhysicalAttemptRecord>((resolve) => { release = resolve; });
    const recordOutput = vi.fn(() => persisted);
    const externalChunk = vi.fn();
    const provider = authority(async (request) => {
      await request.onChunk?.("delta", "accumulated");
      return result();
    });
    const executor = createPreparedTextExecutor({ attempts: repository(recordOutput), loadAuthority: async () => provider });

    const pending = executor.execute(executionInput(externalChunk));
    await vi.waitFor(() => expect(recordOutput).toHaveBeenCalledOnce());
    expect(externalChunk).not.toHaveBeenCalled();
    release({} as PhysicalAttemptRecord);
    await expect(pending).resolves.toMatchObject({ content: "accepted", physicalAttemptId: "attempt-0" });
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
      name: "PreparedRouteTerminalError", reason: "unknown", attemptId: "attempt-0"
    });
    expect(externalChunk).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(loadAuthority).toHaveBeenCalledOnce();
  });
});
