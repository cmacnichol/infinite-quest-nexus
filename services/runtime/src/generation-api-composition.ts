import {
  createGenerationApplication,
  GenerationApplicationError,
  type GenerationApplication,
  type GenerationCommandRepository
} from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository, resolveTextProviderId } from "../../../packages/database/src/generation-repository.js";
import type { PostgresGenerationCommandRepositoryDependencies, PreparedQueuedTextExecution } from "../../../packages/database/src/generation-repository.js";
import { resolveStoryMemoryPromptSnapshot, resolveStoryPromptSnapshot } from "../../../packages/database/src/prompt-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { resolveStoryMemoryPolicySnapshot, type StoryMemoryOperatorConfig } from "../../../packages/database/src/story-memory-policy-repository.js";
import { effectiveProviderConfigurationFingerprint } from "../../../packages/contracts/src/story-memory-policy.js";
import { resolveEffectiveContextWindowTokens } from "../../../packages/story-engine/src/index.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";
import { queuedResponseContractPolicy, responseContractInvocationClosure } from "./generation-response-contract.js";
import { resolveTextExecutionRouteBasis } from "./provider-preset-resolution.js";
import type { TextExecutionRouteBasis } from "../../../packages/contracts/src/text-execution-plan.js";
import { normalizeTextSelection } from "../../../packages/contracts/src/provider-selection.js";
import { normalizeNewTextResponsePolicy, resolveResponseContractAdmission } from "../../../packages/application/src/providers/response-format.js";
import { getProviderOutputSchemaV2, selectProviderOutputSchemaV2, type ProviderOutputSchemaV2 } from "../../../packages/contracts/src/provider-output-schema.js";
import { capabilityRouteConfigHash } from "./provider-capability-cache.js";
import { responseContractInvocationClosureV2 } from "./generation-response-contract.js";
import { resolveEffectiveTextExecutionOverrides } from "./text-execution-overrides.js";

export type ApiGenerationCompositionFactories = Readonly<{
  createCommandRepository(pool: DatabasePool): GenerationCommandRepository;
  createApplication(repository: GenerationCommandRepository): GenerationApplication;
}>;

const productionFactories: ApiGenerationCompositionFactories = {
  createCommandRepository: () => {
    throw new Error("Provider collaborators are required.");
  },
  createApplication: createGenerationApplication
};

/**
 * Queue metadata is derived from the same transaction-local profile read that
 * selected the campaign provider.  It intentionally keeps the profile's base
 * cap separate from the caller's selected-model cap used in the fingerprint.
 */
export function createQueuedResponsePolicyResolver(
  providers: ApiGenerationProviderCollaborators,
  nativeTextExecutionPlanAdmission = false
): NonNullable<PostgresGenerationCommandRepositoryDependencies["resolveQueuedResponsePolicy"]> {
  return async (client, scope) => {
    const profile = await providers.loadQueuedTextProfile(client, scope.ownerUserId, scope.providerProfileId, scope.requestedModel);
    const preparedTextExecution = scope.preparedTextExecution;
    const selection = preparedTextExecution?.selection ?? (scope.requestedModel.trim() ? normalizeTextSelection({
      providerType: profile.providerType,
      providerRole: "text",
      defaultModel: scope.requestedModel
    }) : profile.textSelection) ?? normalizeTextSelection({
      providerType: profile.providerType,
      providerRole: "text",
      defaultModel: scope.requestedModel.trim() || profile.model
    });
    if (!nativeTextExecutionPlanAdmission && selection.kind === "openrouter_preset") {
      throw new GenerationApplicationError("conflict", { reason: "native_text_execution_unavailable" });
    }
    const configuredPolicy = profile.configuration.textResponseFormatPolicy as "legacy" | "auto" | "required" | undefined;
    // Required Model/Preset normalization belongs to the native admission
    // path. Until that gate is enabled, preserve the profile's historical
    // v1/legacy response-format choice rather than making a preset silently
    // enter a partial required-contract workflow.
    const policy = nativeTextExecutionPlanAdmission
      ? normalizeNewTextResponsePolicy(selection, configuredPolicy)
      : configuredPolicy;
    if (nativeTextExecutionPlanAdmission && policy === "required") {
      if (!preparedTextExecution || preparedTextExecution.providerProfileId !== profile.id
        || preparedTextExecution.authorityRevision !== profile.authorityRevision
        || preparedTextExecution.endpointIdentity !== (profile.endpointIdentity ?? profile.id)) {
        throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
      }
      const invocationKeys = responseContractInvocationClosureV2({
        streamingPrimary: profile.configuration.streaming === true || profile.configuration.streamingSupport === true,
        storyOnly: scope.generationPolicy.playMode === "story_only",
        continuityReview: scope.storyMemoryPolicy?.policy.continuityReview ?? "off"
      });
      if (selection.kind === "openrouter_preset") {
        const routeBasis = preparedTextExecution.routeBasis;
        if (!routeBasis || !routeBasis.authorityRevision || !routeBasis.profileRevision || !profile.executionRevision || !profile.authorityRevision) {
          throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
        }
        return {
          version: 2 as const,
          policy: "required" as const,
          providerProfileId: profile.id,
          admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
          authority: {
            kind: "preset_trusted" as const,
            routeBasisHash: routeBasis.routeBasisHash,
            selection: { kind: "openrouter_preset" as const, slug: selection.slug },
            endpointReference: routeBasis.endpointReference,
            credentialReference: routeBasis.credentialReference,
            authorityRevision: routeBasis.authorityRevision,
            profileRevision: routeBasis.profileRevision
          },
          operationClosureVersion: 2 as const,
          invocationKeys: [...invocationKeys]
        };
      }
      const routeConfigHash = capabilityRouteConfigHash(profile.configuration);
      const eligibility = (operation: Parameters<typeof getProviderOutputSchemaV2>[0], streaming: boolean, schema: ProviderOutputSchemaV2) => providers.responseFormatCapabilities.eligibilityV2({
        advertisement: preparedTextExecution.advertisement,
        providerType: profile.providerType as "openrouter" | "openai_compatible",
        endpointIdentity: profile.endpointIdentity ?? "",
        model: selection.modelId,
        routeConfigHash,
        adapterProtocol: "text-schema-adapter-v2",
        operation,
        schemaHash: schema.schemaHash,
        streaming,
        now: providers.responseFormatCapabilities.now()
      });
      const keysByOperation = new Map<Parameters<typeof getProviderOutputSchemaV2>[0], boolean[]>();
      for (const key of invocationKeys) {
        const [operation, delivery] = key.split(":") as [Parameters<typeof getProviderOutputSchemaV2>[0], "stream" | "nonstream"];
        keysByOperation.set(operation, [...(keysByOperation.get(operation) ?? []), delivery === "stream"]);
      }
      // Do not save a partial direct-model closure. Every current operation is
      // checked against its advertised capability and exact file verification
      // before the insert transaction captures its authority. One version is
      // chosen per operation, the same way the resolver chooses one later.
      const chosenSchemas = new Map<Parameters<typeof getProviderOutputSchemaV2>[0], ProviderOutputSchemaV2>();
      for (const [operation, streamings] of keysByOperation) {
        const selected = selectProviderOutputSchemaV2(operation, (schema) => streamings.every((streaming) => {
          const current = eligibility(operation, streaming, schema);
          return current.status === "verified" && Boolean(current.verification);
        }));
        if (!selected) throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
        chosenSchemas.set(operation, selected);
      }
      const admission = resolveResponseContractAdmission({
        selection,
        directEligibility: () => eligibility("story", false, chosenSchemas.get("story")!)
      });
      const routeBasis = preparedTextExecution.routeBasis;
      if (routeBasis && (routeBasis.selection.kind !== "model" || routeBasis.selection.modelId !== selection.modelId)) {
        throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
      }
      return {
        version: 2 as const,
        policy: "required" as const,
        providerProfileId: profile.id,
        admission,
        authority: {
          kind: "model_verified" as const,
          providerProfileId: profile.id,
          providerType: profile.providerType as "openrouter" | "openai_compatible",
          endpointIdentity: profile.endpointIdentity ?? "",
          model: selection.modelId,
          providerConfigurationHash: effectiveProviderConfigurationFingerprint({
            providerId: profile.id, providerType: profile.providerType, endpointIdentity: profile.endpointIdentity ?? "",
            model: selection.modelId, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens,
            temperature: profile.temperature, requestTimeoutMs: profile.requestTimeoutMs, configuration: profile.configuration,
            effectiveContextWindowTokens: resolveEffectiveContextWindowTokens(profile.contextWindowTokens, scope.modelContextWindowTokens),
            inputSafetyPolicy: "estimated_20_percent_plus_1024"
          }),
          routeConfigHash,
          verificationRegistryHash: providers.responseFormatCapabilities.registryDigest,
          authorityRevision: preparedTextExecution.authorityRevision,
          ...(routeBasis ? { routeBasisHash: routeBasis.routeBasisHash } : {})
        },
        operationClosureVersion: 2 as const,
        invocationKeys: [...invocationKeys]
      };
    }
    if (policy === "legacy") return undefined;
    const effectiveContextWindowTokens = resolveEffectiveContextWindowTokens(profile.contextWindowTokens, scope.modelContextWindowTokens);
    const configurationHash = effectiveProviderConfigurationFingerprint({
      providerId: profile.id, providerType: profile.providerType, endpointIdentity: profile.endpointIdentity ?? "",
      model: profile.model, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens,
      temperature: profile.temperature, requestTimeoutMs: profile.requestTimeoutMs, configuration: profile.configuration,
      effectiveContextWindowTokens, inputSafetyPolicy: "estimated_20_percent_plus_1024"
    });
    return queuedResponseContractPolicy({
      policy,
      profile: { id: profile.id, providerType: profile.providerType, model: profile.model,
        endpointIdentity: profile.endpointIdentity ?? "", configurationHash },
      verificationRegistryHash: providers.responseFormatCapabilities.registryDigest,
      invocationKeys: responseContractInvocationClosure({
        streamingPrimary: profile.configuration.streaming === true || profile.configuration.streamingSupport === true,
        storyOnly: scope.generationPolicy.playMode === "story_only",
        continuityReview: scope.storyMemoryPolicy?.policy.continuityReview ?? "off"
      })
    });
  };
}

/**
 * Resolves remote preset/model metadata before the command repository acquires
 * campaign locks. The matching verifier below only performs a local profile
 * read, so an unavailable remote endpoint can never extend a DB transaction.
 */
function createQueuedTextExecutionPreparation(
  pool: DatabasePool,
  providers: ApiGenerationProviderCollaborators,
): Pick<PostgresGenerationCommandRepositoryDependencies, "prepareQueuedTextExecution" | "verifyQueuedTextExecution"> {
  return {
    prepareQueuedTextExecution: async (scope): Promise<PreparedQueuedTextExecution | undefined> => {
      const campaign = await pool.query<{ textProviderProfileId: string | null }>(
        `SELECT text_provider_profile_id AS "textProviderProfileId" FROM campaigns WHERE id=$1 AND owner_user_id=$2`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (!campaign.rows[0]) throw new GenerationApplicationError("not_found", { campaignId: scope.campaignId });
      const providerProfileId = await resolveTextProviderId(
        pool,
        scope.ownerUserId,
        scope.requestedProviderProfileId ?? campaign.rows[0]?.textProviderProfileId,
      );
      if (!providerProfileId) return undefined;
      const defaultProfile = await providers.execution.text({ ownerUserId: scope.ownerUserId }, providerProfileId, "text", undefined);
      // Typed request selections win. The legacy model field is normalized
      // only through its exact compatibility alias, so @preset/slug remains a
      // preset and is never mistaken for a model ID.
      const selection = scope.requestedTextSelection ?? (scope.requestedModel.trim()
        ? normalizeTextSelection({ providerType: defaultProfile.providerType, providerRole: "text", defaultModel: scope.requestedModel })
        : defaultProfile.textSelection ?? normalizeTextSelection({ providerType: defaultProfile.providerType, providerRole: "text", defaultModel: defaultProfile.model }));
      // Loading the selected direct model is part of the capture.  In
      // particular, a request-level selection must not inherit the profile's
      // default-model settings while the queue persists a different model.
      const profile = selection.kind === "model"
        ? await providers.execution.text({ ownerUserId: scope.ownerUserId }, providerProfileId, "text", selection.modelId)
        : defaultProfile;
      if (!profile.executionRevision || !profile.authorityRevision) {
        throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
      }
      const overrides = resolveEffectiveTextExecutionOverrides({
        execution: defaultProfile,
        selection,
        ...(scope.requestedTextExecutionOverrides === undefined
          ? {}
          : { requestOverrides: scope.requestedTextExecutionOverrides })
      });
      if (selection.kind === "model") {
        const inventory = await providers.responseFormatInventory.listModels({
          ownerUserId: scope.ownerUserId, providerProfileId, providerRole: "text"
        });
        const selected = inventory.models.find((candidate) => candidate.id === selection.modelId);
        // A direct Model has no preset provenance, but it still needs the
        // same immutable execution snapshot as a preset.  This canonical
        // single-candidate basis freezes the selected model, budgets and
        // ordinary parameters; it is not a preset route basis and does not
        // participate in capability admission.
        const routeBasis = await resolveTextExecutionRouteBasis({
          profile: {
            ownerUserId: scope.ownerUserId, providerProfileId, profileRevision: profile.executionRevision,
            authorityRevision: profile.authorityRevision, providerType: profile.providerType, selection,
            contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens,
            endpointReference: profile.endpointIdentity ?? profile.id, credentialReference: profile.id,
            requestTimeoutMs: profile.requestTimeoutMs, parameters: { temperature: profile.temperature },
            protocolVersion: "text-execution-route-basis-v2"
          },
          ports: {
            resolvePreset: async () => { throw new Error("A direct Model must not resolve a preset."); },
            discoverModels: async ({ ownerUserId, providerProfileId: id, modelIds }) => {
              const discovered = await providers.responseFormatInventory.listModels({ ownerUserId, providerProfileId: id, providerRole: "text" });
              return discovered.models.filter((candidate) => modelIds.includes(candidate.id)).map((candidate) => ({ id: candidate.id,
                ...(candidate.contextWindowTokens === undefined ? {} : { contextWindowTokens: candidate.contextWindowTokens }) }));
            }
          },
          // Catalog advertisements need not include capacity. The selected
          // profile cap remains the conservative, queue-frozen limit.
          overrides: {
            ...(profile.contextWindowTokens === undefined ? {} : { conservativeContextWindowTokens: profile.contextWindowTokens }),
            ...(overrides ?? {})
          }
        });
        return {
          providerProfileId,
          selection,
          executionRevision: profile.executionRevision,
          authorityRevision: profile.authorityRevision,
          endpointIdentity: profile.endpointIdentity ?? profile.id,
          advertisement: selected?.responseFormatAdvertisement ?? null,
          routeBasis
        };
      }
      const routeBasis = await resolveTextExecutionRouteBasis({
        profile: {
          ownerUserId: scope.ownerUserId, providerProfileId, profileRevision: profile.executionRevision,
          authorityRevision: profile.authorityRevision,
          providerType: profile.providerType, selection, contextWindowTokens: profile.contextWindowTokens,
          maxOutputTokens: profile.maxOutputTokens, endpointReference: profile.endpointIdentity ?? profile.id,
          credentialReference: profile.id, requestTimeoutMs: profile.requestTimeoutMs,
          parameters: { temperature: profile.temperature }, presetRouting: "openrouter",
          protocolVersion: "story-openrouter-preset-v1"
        },
        ports: {
          resolvePreset: async ({ ownerUserId, providerProfileId: id, slug }) =>
            (await providers.responseFormatInventory.getPreset({ ownerUserId, providerProfileId: id, slug })).preset,
          discoverModels: async ({ ownerUserId, providerProfileId: id, modelIds }) => {
            const inventory = await providers.responseFormatInventory.listModels({ ownerUserId, providerProfileId: id, providerRole: "text" });
            return inventory.models.filter((model) => modelIds.includes(model.id)).map((model) => ({ id: model.id,
              ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }) }));
          }
        },
        ...(overrides === undefined ? {} : { overrides })
      });
      return {
        providerProfileId,
        selection,
        executionRevision: profile.executionRevision,
        authorityRevision: profile.authorityRevision,
        endpointIdentity: profile.endpointIdentity ?? profile.id,
        advertisement: null,
        routeBasis
      };
    },
    verifyQueuedTextExecution: async (client, scope) => {
      const prepared = scope.preparedTextExecution;
      const profile = await providers.loadQueuedTextProfile(client, scope.ownerUserId, scope.providerProfileId,
        prepared.selection.kind === "model" ? prepared.selection.modelId : undefined);
      if (profile.id !== scope.providerProfileId || profile.id !== prepared.providerProfileId
        || profile.authorityRevision !== prepared.authorityRevision
        || (profile.endpointIdentity ?? profile.id) !== prepared.endpointIdentity) return false;
      if (!prepared.routeBasis) return false;
      return prepared.routeBasis.profileRevision === prepared.executionRevision
        && prepared.routeBasis.authorityRevision === prepared.authorityRevision
        && prepared.routeBasis.endpointReference === prepared.endpointIdentity
        && prepared.routeBasis.credentialReference === profile.id
        && prepared.routeBasis.selection.kind === prepared.selection.kind
        && (prepared.selection.kind !== "model" || (prepared.routeBasis.selection.kind === "model"
          && prepared.routeBasis.selection.modelId === prepared.selection.modelId));
    }
  };
}

export function createApiGenerationApplication(
  pool: DatabasePool,
  providers: ApiGenerationProviderCollaborators,
  factories: ApiGenerationCompositionFactories = productionFactories,
  operatorConfig?: StoryMemoryOperatorConfig,
  /** Task 4/5 owns the production admission gate. Tests may opt in to exercise persistence. */
  nativeTextExecutionPlanAdmission = false
): GenerationApplication {
  // Callers may pass already-resolved operator settings. The safe legacy
  // default keeps isolated factory composition from reading process env.
  const resolvedOperatorConfig = operatorConfig ?? { installedCapability: null, enforceEnabled: false };
  const repository = factories === productionFactories
    ? createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: async (client, ownerUserId, campaignId, storyMemoryPolicy) => storyMemoryPolicy
        ? resolveStoryMemoryPromptSnapshot(client, { ownerUserId, scope: "campaign", campaignId }, storyMemoryPolicy.policy.continuityReview, storyMemoryPolicy.castContext === true)
        : resolveStoryPromptSnapshot(client, { ownerUserId, scope: "campaign", campaignId }),
      promptProtocolVersion: providers.promptTools.protocolVersion,
      resolveStoryMemoryPolicySnapshot: (client, scope) => resolveStoryMemoryPolicySnapshot(client, scope, {
         installedCapability: resolvedOperatorConfig.installedCapability,
         enforceEnabled: resolvedOperatorConfig.enforceEnabled,
         castContextEnabled: resolvedOperatorConfig.castContextEnabled === true
      }),
      resolveQueuedResponsePolicy: createQueuedResponsePolicyResolver(providers, nativeTextExecutionPlanAdmission),
      ...(nativeTextExecutionPlanAdmission ? createQueuedTextExecutionPreparation(pool, providers) : {}),
      readTurnReportedCosts: (ownerUserId, campaignId, turnIds) => providers.reads.getTurnCosts({
        ownerUserId,
        campaignId,
        turnIds
      })
    })
    : factories.createCommandRepository(pool);
  return factories.createApplication(repository);
}
