import { describe, expect, it, vi } from "vitest";
import { effectiveProviderConfigurationFingerprint } from "../../packages/contracts/src/story-memory-policy.js";
import { createQueuedResponsePolicyResolver } from "../../services/runtime/src/generation-api-composition.js";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";
import { responseContractInvocationClosure } from "../../services/runtime/src/generation-response-contract.js";
import { createApiProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import type { WorkerGenerationProviderCollaborators } from "../../services/runtime/src/provider-application-composition.js";
import { readFrozenResponseContracts, readQueuedResponsePolicy, readQueuedResponsePolicyV2 } from "../../packages/contracts/src/generation-response-contract.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";

const profile = {
  id: "11111111-1111-4111-8111-111111111111", providerType: "openrouter", model: "model-a",
  endpointIdentity: "endpoint-a", contextWindowTokens: 16_384, maxOutputTokens: 1_024,
  temperature: 0.5, requestTimeoutMs: 30_000, configuration: { textResponseFormatPolicy: "auto" }
};
const registryDigest = "b".repeat(64);

function queuedPolicy(contextWindowTokens = profile.contextWindowTokens) {
  return {
    version: 1 as const, policy: "auto" as const, providerProfileId: profile.id, model: profile.model,
    endpointIdentity: profile.endpointIdentity,
    providerConfigurationHash: effectiveProviderConfigurationFingerprint({
      providerId: profile.id, providerType: profile.providerType, model: profile.model,
      endpointIdentity: profile.endpointIdentity, contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens, temperature: profile.temperature,
      requestTimeoutMs: profile.requestTimeoutMs, configuration: profile.configuration,
      effectiveContextWindowTokens: contextWindowTokens, inputSafetyPolicy: "estimated_20_percent_plus_1024"
    }),
    verificationRegistryHash: registryDigest, operationClosureVersion: 1 as const,
    invocationKeys: [...responseContractInvocationClosure({ streamingPrimary: false, storyOnly: false, continuityReview: "off" })]
  };
}

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((next) => { resolve = next; }), resolve };
}

function collaborators(input: Readonly<{ inventory?: () => Promise<unknown>; registryDigest?: string }> = {}) {
  const listModels = vi.fn(async () => input.inventory ? input.inventory() : { models: [] });
  const providers = {
    execution: { text: vi.fn(async () => profile) },
    responseFormatInventory: { listModels },
    responseFormatCapabilities: {
      registryDigest: input.registryDigest ?? registryDigest,
      eligibility: vi.fn(() => ({ status: "unknown", reason: "discovery_unavailable", verification: null }))
    },
    promptTools: { content: vi.fn() }, costs: { recordGenerationCost: vi.fn() },
    costContext: vi.fn(), attributeCosts: { attributeGenerationCostsToTurn: vi.fn() }
  } as unknown as WorkerGenerationProviderCollaborators;
  return { result: createGenerationExecutionCollaborators({} as never, {} as never, { generation: {} } as never, providers), providers, listModels };
}

describe("generation response-contract production preflight collaborators", () => {
  it("queues a required v2 direct-model policy without a preset route basis", async () => {
    const apiProviders = {
      loadQueuedTextProfile: vi.fn(async () => ({
        ...profile,
        textSelection: { kind: "model" as const, modelId: profile.model },
        executionRevision: "execution",
        authorityRevision: "authority",
        configuration: {}
      })),
      responseFormatCapabilities: {
        registryDigest,
        now: () => "2026-09-19T00:00:00.000Z",
        eligibilityV2: vi.fn((input) => ({
          status: "verified",
          verification: {
            version: 2, providerType: "openrouter", endpointIdentity: profile.endpointIdentity,
            model: profile.model, routeConfigHash: capabilityRouteConfigHash({}), adapterProtocol: "text-schema-adapter-v2",
            operation: input.operation, schemaHash: getProviderOutputSchemaV2(input.operation).schemaHash, streaming: input.streaming,
            verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z",
            providerRoutingSlugs: [], nativeOpenTrackerObjects: true
          }
        }))
      }
    } as never;

    const queued = await createQueuedResponsePolicyResolver(apiProviders, true)({} as never, {
      ownerUserId: "owner", campaignId: "campaign", providerProfileId: profile.id, requestedModel: profile.model,
      operationKind: "append", generationPolicy: { playMode: "legacy" }, storyMemoryPolicy: null,
      preparedTextExecution: {
        providerProfileId: profile.id, selection: { kind: "model", modelId: profile.model },
        executionRevision: "execution", authorityRevision: "authority", endpointIdentity: profile.endpointIdentity,
        advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-19T00:00:00.000Z" }
      }
    } as never);

    expect(readQueuedResponsePolicyV2(queued)).toMatchObject({
      version: 2,
      policy: "required",
      providerProfileId: profile.id,
      admission: { basis: "model_verified" },
      authority: { kind: "model_verified", model: profile.model },
      invocationKeys: expect.arrayContaining([
        "story:nonstream", "rpg_assessment:nonstream", "event_trigger_before:nonstream",
        "event_trigger_after:nonstream", "scene_coverage:nonstream", "event_coverage:nonstream"
      ])
    });
  });

  it("checks only current owner-scoped authority for a resumed frozen route", async () => {
    const { result, providers } = collaborators();
    const basis = {
      authorityRevision: "frozen-authority", credentialReference: profile.id, endpointReference: profile.endpointIdentity,
      candidates: [{ modelId: "frozen-model" }]
    };
    (providers.execution.text as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...profile, providerRole: "text", model: "ordinary-profile-edit", temperature: 1.2, requestTimeoutMs: 5_000,
      configuration: { textResponseFormatPolicy: "legacy" }, authorityRevision: "frozen-authority"
    });

    await expect(result.verifyTextExecutionRouteAuthority!("owner", basis as never)).resolves.toBe(true);
    expect(providers.execution.text).toHaveBeenCalledWith({ ownerUserId: "owner" }, profile.id, "text", "frozen-model");

    (providers.execution.text as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...profile, providerRole: "text", authorityRevision: "rotated-authority"
    });
    await expect(result.verifyTextExecutionRouteAuthority!("owner", basis as never)).resolves.toBe(false);
  });

  it.each([
    ["append action non-streaming without review", "append", "legacy", false, "off", ["story:nonstream"]],
    ["replacement action streaming with observe review", "replacement", "legacy", true, "observe", ["story:nonstream", "story:stream", "continuity_review:nonstream"]],
    ["append story-only non-streaming without review", "append", "story_only", false, "off", ["story:nonstream", "choices:nonstream"]],
    ["replacement story-only streaming with enforce review", "replacement", "story_only", true, "enforce", ["story:nonstream", "story:stream", "choices:nonstream", "continuity_review:nonstream"]],
    ["append story-only non-streaming with observe review", "append", "story_only", false, "observe", ["story:nonstream", "choices:nonstream", "continuity_review:nonstream"]],
    ["replacement action non-streaming with enforce review", "replacement", "legacy", false, "enforce", ["story:nonstream", "continuity_review:nonstream"]]
  ] as const)("round-trips exact queue and frozen closures for %s", async (_name, operationKind, playMode, streaming, continuityReview, expectedKeys) => {
    const queueProfile = { ...profile, configuration: { textResponseFormatPolicy: "auto", ...(streaming ? { streaming: true } : {}) } };
    const apiProviders = {
      loadQueuedTextProfile: vi.fn(async () => queueProfile), responseFormatCapabilities: { registryDigest }
    } as never;
    const queued = await createQueuedResponsePolicyResolver(apiProviders)({} as never, {
      ownerUserId: "owner", campaignId: "campaign", providerProfileId: profile.id, requestedModel: profile.model,
      operationKind, generationPolicy: { playMode }, storyMemoryPolicy: continuityReview === "off" ? null : { policy: { continuityReview } }
    } as never);
    const policy = readQueuedResponsePolicy(JSON.parse(JSON.stringify(queued)));
    expect(policy?.invocationKeys).toEqual(expectedKeys);
    const workerProviders = {
      execution: { text: vi.fn(async () => queueProfile) }, responseFormatInventory: { listModels: vi.fn(async () => ({ models: [] })) },
      responseFormatCapabilities: { registryDigest, eligibility: vi.fn(() => ({ status: "unknown", reason: "discovery_unavailable", verification: null })) },
      promptTools: { content: vi.fn() }, costs: { recordGenerationCost: vi.fn() }, costContext: vi.fn(), attributeCosts: { attributeGenerationCostsToTurn: vi.fn() }
    } as unknown as WorkerGenerationProviderCollaborators;
    const worker = createGenerationExecutionCollaborators({} as never, {} as never, { generation: {} } as never, workerProviders);
    const frozen = await worker.resolveResponseContracts!("owner", queueProfile as never, policy!, {
      id: policy!.providerProfileId, providerType: queueProfile.providerType, model: policy!.model,
      endpointIdentity: queueProfile.endpointIdentity, configurationHash: policy!.providerConfigurationHash
    });
    const parsed = readFrozenResponseContracts(JSON.parse(JSON.stringify(frozen)));
    expect(Object.keys(parsed!.contracts)).toEqual(expectedKeys);
    expect(parsed!.queuedPolicy.invocationKeys).toEqual(expectedKeys);
  });

  it("keeps legacy policy physically absent across the queue callback", async () => {
    const apiProviders = {
      loadQueuedTextProfile: vi.fn(async () => ({ ...profile, configuration: { textResponseFormatPolicy: "legacy" } })),
      responseFormatCapabilities: { registryDigest }
    } as never;
    await expect(createQueuedResponsePolicyResolver(apiProviders)({} as never, {
      ownerUserId: "owner", campaignId: "campaign", providerProfileId: profile.id, requestedModel: profile.model,
      operationKind: "append", generationPolicy: { playMode: "legacy" }, storyMemoryPolicy: null
    } as never)).resolves.toBeUndefined();
  });

  it("rejects newly queued presets while native admission is disabled, then captures its trusted v2 closure when enabled", async () => {
    const presetProfile = {
      ...profile,
      model: "@preset/keep",
      textSelection: { kind: "openrouter_preset" as const, slug: "keep" },
      executionRevision: "preset-execution",
      authorityRevision: "preset-authority",
      configuration: { textResponseFormatPolicy: "legacy" as const }
    };
    const apiProviders = {
      loadQueuedTextProfile: vi.fn(async () => presetProfile),
      responseFormatCapabilities: { registryDigest, now: () => "2026-09-19T00:00:00.000Z" }
    } as never;
    const scope = {
      ownerUserId: "owner", campaignId: "campaign", providerProfileId: profile.id, requestedModel: "@preset/keep",
      operationKind: "append", generationPolicy: { playMode: "legacy" }, storyMemoryPolicy: null,
      preparedTextExecution: {
        providerProfileId: profile.id, selection: presetProfile.textSelection,
        executionRevision: "preset-execution", authorityRevision: "preset-authority", endpointIdentity: profile.endpointIdentity,
        advertisement: null,
        routeBasis: {
          routeBasisHash: "a".repeat(64), selection: presetProfile.textSelection,
          authorityRevision: "preset-authority", profileRevision: "preset-execution",
          endpointReference: profile.endpointIdentity, credentialReference: profile.id
        }
      }
    } as never;

    await expect(createQueuedResponsePolicyResolver(apiProviders)({} as never, scope)).rejects.toMatchObject({
      kind: "conflict", details: { reason: "native_text_execution_unavailable" }
    });
    await expect(createQueuedResponsePolicyResolver(apiProviders, true)({} as never, scope)).resolves.toMatchObject({
      version: 2,
      policy: "required",
      admission: { basis: "preset_trusted" },
      authority: { kind: "preset_trusted", selection: presetProfile.textSelection }
    });
  });

  it("captures a required policy when the queued profile carries the new-work default", async () => {
    const apiProviders = {
      loadQueuedTextProfile: vi.fn(async () => ({ ...profile, configuration: { textResponseFormatPolicy: "required" } })),
      responseFormatCapabilities: { registryDigest }
    } as never;
    const queued = await createQueuedResponsePolicyResolver(apiProviders)({} as never, {
      ownerUserId: "owner", campaignId: "campaign", providerProfileId: profile.id, requestedModel: profile.model,
      operationKind: "append", generationPolicy: { playMode: "legacy" }, storyMemoryPolicy: null
    } as never);
    expect(readQueuedResponsePolicy(queued)?.policy).toBe("required");
  });

  it("uses the supplied composition client for queue-time profile loading without borrowing from the pool", async () => {
    const row = {
      id: profile.id, name: "Text", provider_type: "openrouter", provider_role: "text", base_url: "https://provider.example/v1",
      default_model: profile.model, context_window_tokens: profile.contextWindowTokens, max_output_tokens: profile.maxOutputTokens,
      temperature: profile.temperature, request_timeout_ms: profile.requestTimeoutMs, configuration: profile.configuration,
      encrypted_api_key: null, credential_nonce: null, credential_auth_tag: null, credential_key_version: null,
      enabled: true, is_default: true, health_status: "unknown", consecutive_failures: 0, last_health_check_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z")
    };
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM provider_profiles")) return { rows: [row], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    }) };
    const pool = { connect: vi.fn(async () => { throw new Error("unexpected pool borrow"); }), query: vi.fn() };
    const composition = createApiProviderApplicationComposition(pool as never, {
      credentialSecret: "test-secret", transport: { fetch: vi.fn(), validateSdkEndpoint: vi.fn(), close: vi.fn() }
    });
    await expect(composition.generation.loadQueuedTextProfile(client as never, "owner", profile.id, profile.model))
      .resolves.toMatchObject({ id: profile.id, model: profile.model, contextWindowTokens: profile.contextWindowTokens });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalled();
  });

  it("reads the queue-time profile through the provided transaction client without using the pool-bound execution", async () => {
    const transactionClient = {} as never;
    const localProfile = vi.fn(async () => profile);
    const executionText = vi.fn();
    const providers = {
      execution: { text: executionText }, loadQueuedTextProfile: localProfile,
      responseFormatCapabilities: { registryDigest }
    } as never;
    const resolve = createQueuedResponsePolicyResolver(providers);
    const result = await resolve(transactionClient, {
      ownerUserId: "owner", campaignId: "campaign", providerProfileId: profile.id, requestedModel: profile.model,
      modelContextWindowTokens: 4_096, operationKind: "append", generationPolicy: { playMode: "rpg" }, storyMemoryPolicy: null
    } as never);
    expect(localProfile).toHaveBeenCalledWith(transactionClient, "owner", profile.id, profile.model);
    expect(executionText).not.toHaveBeenCalled();
    expect(result?.version).toBe(1);
    expect(result?.version === 1 && result.providerConfigurationHash).toBe(queuedPolicy(4_096).providerConfigurationHash);
  });

  it("does not discover inventory before rejecting a queued registry mismatch", async () => {
    const { result, listModels } = collaborators({ registryDigest: "c".repeat(64) });
    await expect(result.resolveResponseContracts!("owner", profile as never, queuedPolicy(), {
      id: profile.id, providerType: profile.providerType, model: profile.model, endpointIdentity: profile.endpointIdentity,
      configurationHash: queuedPolicy().providerConfigurationHash
    })).rejects.toMatchObject({ code: "response_contract_identity_mismatch" });
    expect(listModels).not.toHaveBeenCalled();
  });

  it("rejects an unsupported native adapter before inventory discovery", async () => {
    const { result, listModels } = collaborators();
    await expect(result.resolveResponseContracts!("owner", { ...profile, providerType: "lmstudio" } as never, queuedPolicy(), {
      id: profile.id, providerType: "lmstudio", model: profile.model, endpointIdentity: profile.endpointIdentity,
      configurationHash: queuedPolicy().providerConfigurationHash
    })).rejects.toMatchObject({ code: "response_contract_unsupported_adapter" });
    expect(listModels).not.toHaveBeenCalled();
  });

  it("turns malformed required inventory into a finite unavailable preflight error", async () => {
    const { result, listModels } = collaborators({ inventory: async () => ({ models: { hostile: true } }) });
    await expect(result.resolveResponseContracts!("owner", profile as never, { ...queuedPolicy(), policy: "required" }, {
      id: profile.id, providerType: profile.providerType, model: profile.model, endpointIdentity: profile.endpointIdentity,
      configurationHash: queuedPolicy().providerConfigurationHash
    })).rejects.toMatchObject({ code: "response_contract_unavailable" });
    expect(listModels).toHaveBeenCalledOnce();
  });

  it("falls back to json-object for auto when inventory discovery fails and records non-registry evidence", async () => {
    const { result, listModels } = collaborators({ inventory: async () => { throw new Error("offline"); } });
    const selection = await result.resolveResponseContracts!("owner", profile as never, queuedPolicy(), {
      id: profile.id, providerType: profile.providerType, model: profile.model, endpointIdentity: profile.endpointIdentity,
      configurationHash: queuedPolicy().providerConfigurationHash
    });
    expect(listModels).toHaveBeenCalledOnce();
    expect(selection.contracts["story:nonstream"]).toMatchObject({ mode: "json_object" });
    expect(selection.capabilityEvidenceHash).not.toBe(registryDigest);
  });

  it("rejects a captured provider execution when the profile changes during discovery", async () => {
    const started = deferred();
    const release = deferred();
    let changed = false;
    const providers = {
      execution: { text: vi.fn(async () => changed ? { ...profile, configuration: { textResponseFormatPolicy: "required" } } : profile) },
      responseFormatInventory: { listModels: vi.fn(async () => { started.resolve(); await release.promise; return { models: [] }; }) },
      responseFormatCapabilities: { registryDigest, eligibility: vi.fn(() => ({ status: "unknown", reason: "discovery_unavailable", verification: null })) },
      promptTools: { content: vi.fn() }, costs: { recordGenerationCost: vi.fn() }, costContext: vi.fn(), attributeCosts: { attributeGenerationCostsToTurn: vi.fn() }
    } as unknown as WorkerGenerationProviderCollaborators;
    const result = createGenerationExecutionCollaborators({} as never, {} as never, { generation: {} } as never, providers);
    const resolving = result.resolveResponseContracts!("owner", profile as never, queuedPolicy(), {
      id: profile.id, providerType: profile.providerType, model: profile.model, endpointIdentity: profile.endpointIdentity,
      configurationHash: queuedPolicy().providerConfigurationHash
    });
    await started.promise;
    changed = true;
    release.resolve();
    await expect(resolving).rejects.toMatchObject({ code: "response_contract_identity_mismatch" });
  });
});
