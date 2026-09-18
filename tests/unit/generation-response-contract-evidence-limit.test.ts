import { describe, expect, it, vi } from "vitest";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { PreparedResponseContractError, serializeProviderRequest } from "../../packages/story-engine/src/index.js";
import { callCampaignTextProvider } from "../../services/runtime/src/generation-executor-adapter.js";

const evidenceLimit = 1_000_000;

function jobWithFrozenContract(): GenerationExecutionPayload {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    owner_user_id: "00000000-0000-4000-8000-000000000002",
    campaign_id: "00000000-0000-4000-8000-000000000003",
    world_id: "00000000-0000-4000-8000-000000000004",
    world_version_id: "00000000-0000-4000-8000-000000000005",
    provider_profile_id: "00000000-0000-4000-8000-000000000006",
    expected_turn_number: 2,
    operation_kind: "append",
    replacement_turn_id: null,
    base_turn_number: null,
    base_state_private: {},
    base_scratchpad_safe_for_prompt: false,
    action: "Continue.",
    requested_input_mode: "action",
    resolved_input_mode: "action",
    input_mode_source: "explicit",
    requested_model: "test-model",
    context_options: { budgetTokens: 4_000_000, compression: "auto", query: "Continue.", recentTurns: 4 },
    prompt_protocol_version: "test-protocol",
    prompt_snapshot: {} as never,
    generation_policy: null,
    generation_base_identity: {
      operationKind: "append", expectedTurnNumber: 2, baseTurnNumber: 1, campaignActiveTurnNumber: 1,
      campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null,
      baseTurnId: null, stateFingerprint: "state", narrationFingerprint: null
    },
    attempts: 1,
    orchestration_private: {
      frozenResponseContracts: { selectionHash: "a".repeat(64), contracts: {
        "story:nonstream": { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
      } }
    } as never,
    streaming_segments_state: {},
    orchestration_inputs: {
      useRpgStats: false, rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
      storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] }, suppressEventTriggers: true,
      characterProfile: null, characterSnapshot: null
    }
  };
}

function fixture() {
  const job = jobWithFrozenContract();
  const provider: any = {
    id: job.provider_profile_id, name: "Evidence limit fixture", providerRole: "text", providerType: "openai_compatible",
    model: "test-model", contextWindowTokens: 4_000_000, maxOutputTokens: 2_000,
    temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
  };
  const saveOrchestration = vi.fn(async (_scope: unknown, value: unknown) => {
    job.orchestration_private = value as never;
    return true;
  });
  const reserve = vi.fn(async (_scope: unknown, input: any) => ({ id: "b".repeat(64), status: "reserved", ...input }));
  const dispatch = vi.fn(async (_scope: unknown, id: string) => ({ id, status: "dispatched" }));
  const complete = vi.fn(async (_scope: unknown, id: string, response: unknown) => ({ id, status: "completed", response }));
  const dependencies: any = {
    pool: {} as DatabasePool,
    responseContractScope: { jobId: job.id, ownerUserId: job.owner_user_id, workerId: "evidence-limit" },
    repository: {
      reserveResponseContractInvocation: reserve,
      markResponseContractInvocationDispatched: dispatch,
      completeResponseContractInvocation: complete,
      saveOrchestration
    },
    collaborators: { onProviderDispatch: vi.fn(), recordProfileCost: vi.fn(async () => undefined) }
  };
  return { job, provider, dependencies, saveOrchestration, reserve, dispatch, complete };
}

function requestInputForExactBodyLength(provider: any, targetLength: number): string {
  const bodyFor = (input: string) => serializeProviderRequest({ ...provider, baseUrl: "" }, {
    systemPrompt: "rules", input, responseContract: { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
  }).body;
  const base = bodyFor("");
  return "x".repeat(targetLength - base.length);
}

describe("response-contract evidence request limit", () => {
  it("rejects an uncapturable request before reservation or provider dispatch", async () => {
    const { job, provider, dependencies, reserve, dispatch, complete } = fixture();
    const input = requestInputForExactBodyLength(provider, evidenceLimit + 1);

    await expect(callCampaignTextProvider(dependencies, provider, job, "story_generation", { systemPrompt: "rules", input }))
      .rejects.toMatchObject({
        code: "response_contract_request_evidence_too_large",
        scope: "provider_request",
        requiredCharacters: evidenceLimit + 1,
        availableCharacters: evidenceLimit
      });

    expect(reserve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("retains the exact boundary request body when the provider reports a prepared failure", async () => {
    const { job, provider, dependencies, saveOrchestration, reserve, dispatch, complete } = fixture();
    const input = requestInputForExactBodyLength(provider, evidenceLimit);
    const expectedBody = serializeProviderRequest({ ...provider, baseUrl: "" }, {
      systemPrompt: "rules", input, responseContract: { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
    }).body;
    expect(expectedBody).toHaveLength(evidenceLimit);
    provider.execute = vi.fn(async (request: any) => {
      const prepared = serializeProviderRequest({ ...provider, baseUrl: "" }, request);
      throw new PreparedResponseContractError(new Error("provider rejected request"), prepared, {
        responseId: null, partialContent: "", returnedModel: null, returnedProviderRoute: null, diagnosticCode: null
      });
    });

    await expect(callCampaignTextProvider(dependencies, provider, job, "story_generation", { systemPrompt: "rules", input }))
      .rejects.toBeInstanceOf(PreparedResponseContractError);

    expect(reserve).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(saveOrchestration).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      preparedResponseFailures: [expect.objectContaining({ requestBody: expectedBody, requestPayloadHash: sha256(expectedBody) })]
    }));
    expect(complete).toHaveBeenCalledOnce();
  });
});
