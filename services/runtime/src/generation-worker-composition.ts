import {
  createGenerationWorkerApplication,
  type GenerationClaimRepository,
  type GenerationExecutor,
  type GenerationWorkerApplication,
  type IllustrationApplication,
  type MemoryApplication
} from "../../../packages/application/src/index.js";
import {
  createPostgresGenerationExecutionRepository,
  type GenerationExecutionRepository
} from "../../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { withTransaction } from "../../../packages/database/src/pool.js";
import { getProviderOutputSchema } from "../../../packages/story-engine/src/provider-output-schema.js";
import { getProviderOutputSchemaV2 } from "../../../packages/contracts/src/provider-output-schema.js";
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";
import type { ModelParameterAdvertisement } from "../../../packages/contracts/src/text-response-format.js";
import { capabilityRouteConfigHash } from "./provider-capability-cache.js";
import {
  assertQueuedResponseContractProfile,
  assertResponseContractAdapter,
  ResponseContractPreflightError,
  resolveGenerationResponseContracts,
  resolveGenerationResponseContractsV2
} from "./generation-response-contract.js";
import type { QueuedResponsePolicyVersioned, FrozenResponseContractsVersioned } from "../../../packages/contracts/src/generation-response-contract.js";
import type { WorkerGenerationProviderCollaborators } from "./provider-application-composition.js";
import {
  createGenerationExecutor,
  type GenerationExecutionCollaborators,
  type GenerationExecutorDependencies
} from "./generation-executor-adapter.js";
import { loadConfig, prepareIllustrationTextExecution } from "./illustration-segment-job-adapter.js";

type WorkerGenerationRepository = GenerationClaimRepository & GenerationExecutionRepository;

function boundedAdvertisement(value: unknown): ModelParameterAdvertisement | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Readonly<{ supportedParameters?: unknown; discoveredAt?: unknown }>;
  if (typeof record.discoveredAt !== "string" || record.discoveredAt.length > 64) return null;
  if (record.supportedParameters === null) return { supportedParameters: null, discoveredAt: record.discoveredAt };
  if (!Array.isArray(record.supportedParameters) || record.supportedParameters.length > 64
    || !record.supportedParameters.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128)) return null;
  return { supportedParameters: [...new Set(record.supportedParameters)].sort(), discoveredAt: record.discoveredAt };
}

export type WorkerGenerationCompositionFactories = Readonly<{
  createRepository(pool: DatabasePool): WorkerGenerationRepository;
  createCollaborators(
    pool: DatabasePool,
    illustration: IllustrationApplication,
    memory: MemoryApplication,
    providers: WorkerGenerationProviderCollaborators,
  ): GenerationExecutionCollaborators;
  createExecutor(dependencies: GenerationExecutorDependencies): GenerationExecutor;
  createApplication(dependencies: Readonly<{
    claims: GenerationClaimRepository;
    executor: GenerationExecutor;
  }>): GenerationWorkerApplication;
}>;

export function createGenerationExecutionCollaborators(
  pool: DatabasePool,
  illustration: IllustrationApplication,
  memory: MemoryApplication,
  providers: WorkerGenerationProviderCollaborators,
): GenerationExecutionCollaborators {
  return {
    ...(providers.prepareCastDiscoveryExecution ? { prepareCastDiscoveryExecution: providers.prepareCastDiscoveryExecution } : {}),
    memory: memory.generation,
    illustration: illustration.generation,
    prepareIllustrationTextExecution: async ({ ownerUserId, campaignId, operationPrompt }) => {
      let config;
      try {
        config = await loadConfig(pool, ownerUserId, campaignId);
      } catch {
        // Illustrations are optional; disabled/missing configuration has no
        // refinement job to prepare and cannot block the accepted Story turn.
        return undefined;
      }
      return prepareIllustrationTextExecution(ownerUserId, campaignId, config, operationPrompt, providers);
    },
    loadTextExecution: (ownerUserId, providerProfileId, model) => providers.execution.text(
      { ownerUserId },
      providerProfileId,
      "text",
      model
    ),
    preparedTextExecutor: providers.preparedTextExecutor,
    verifyTextExecutionRouteAuthority: async (ownerUserId, routeBasis) => {
      // Route choices and prompt policy are frozen with the queued job.  A
      // resumed native job may read only the current credential authority;
      // ordinary execution settings must not replace the frozen basis.
      if (!routeBasis.authorityRevision || !routeBasis.credentialReference) return false;
      const current = await providers.execution.text(
        { ownerUserId },
        routeBasis.credentialReference,
        "text",
        routeBasis.candidates[0]?.modelId
      );
      return current.id === routeBasis.credentialReference
        && current.providerRole === "text"
        && current.authorityRevision === routeBasis.authorityRevision
        && (current.endpointIdentity ?? current.id) === routeBasis.endpointReference;
    },
    resolveResponseContracts: async (ownerUserId, profile, queuedPolicy, runtimeProfile): Promise<FrozenResponseContractsVersioned> => {
      if (queuedPolicy.version === 2) {
        if (queuedPolicy.authority.kind === "preset_trusted") {
          return resolveGenerationResponseContractsV2({
            queuedPolicy,
            capabilityEvidenceHash: sha256(stableStringify({ routeBasisHash: queuedPolicy.authority.routeBasisHash }))
          });
        }
        if (queuedPolicy.authority.providerProfileId !== profile.id
          || queuedPolicy.authority.providerType !== profile.providerType
          || queuedPolicy.authority.model !== profile.model
          || queuedPolicy.authority.endpointIdentity !== (profile.endpointIdentity ?? "")
          || queuedPolicy.authority.verificationRegistryHash !== providers.responseFormatCapabilities.registryDigest) {
          throw new ResponseContractPreflightError("response_contract_identity_mismatch", "The queued direct-model authority changed before response-contract discovery.");
        }
        const authority = queuedPolicy.authority;
        let advertised: unknown = null;
        try {
          const inventory = await providers.responseFormatInventory.listModels({
            ownerUserId, providerProfileId: profile.id, providerRole: "text"
          });
          const selected = inventory.models.find((model: unknown): model is Readonly<{ id: string; responseFormatAdvertisement?: unknown }> => {
            const candidate = model as Readonly<{ id?: unknown }> | null;
            return candidate !== null && typeof candidate === "object" && candidate.id === profile.model;
          });
          advertised = boundedAdvertisement(selected?.responseFormatAdvertisement);
        } catch {
          // Required v2 direct work has no JSON fallback; the exact tuple
          // resolver below records a finite preflight failure before transport.
        }
        const verificationEvidence: unknown[] = [];
        return resolveGenerationResponseContractsV2({
          queuedPolicy,
          capabilityEvidenceHash: () => sha256(stableStringify({ advertisement: advertised, verificationEvidence })),
          eligible: (operation, streaming) => {
            const schema = getProviderOutputSchemaV2(operation);
            const result = providers.responseFormatCapabilities.eligibilityV2({
              advertisement: advertised as never,
              providerType: profile.providerType as "openrouter" | "openai_compatible",
              endpointIdentity: profile.endpointIdentity ?? "",
              model: profile.model,
              routeConfigHash: authority.routeConfigHash,
              adapterProtocol: "text-schema-adapter-v2",
              operation,
              schemaHash: schema.schemaHash,
              streaming,
              now: providers.responseFormatCapabilities.now()
            });
            verificationEvidence.push({ operation, streaming, status: result.status, reason: result.reason, verification: result.verification ?? null });
            return result;
          }
        });
      }
      // Identity and adapter validation must fail before discovery.  Discovery
      // can be unavailable or malformed, but must never make an old queue
      // policy silently bind a new provider configuration.
      assertQueuedResponseContractProfile(queuedPolicy, runtimeProfile, providers.responseFormatCapabilities.registryDigest);
      assertResponseContractAdapter(runtimeProfile);
      let advertised: unknown = null;
      try {
        const inventory = await providers.responseFormatInventory.listModels({
          ownerUserId, providerProfileId: profile.id, providerRole: "text"
        });
        if (inventory && Array.isArray(inventory.models)) {
          const selected = inventory.models.find((model: unknown): model is Readonly<{ id: string; responseFormatAdvertisement?: unknown }> => {
            const candidate = model as Readonly<{ id?: unknown; responseFormatAdvertisement?: unknown }> | null;
            return candidate !== null && typeof candidate === "object" && typeof candidate.id === "string" && candidate.id === profile.model;
          });
          advertised = boundedAdvertisement(selected?.responseFormatAdvertisement);
        }
      } catch {
        // Auto policy may use json_object when discovery is unavailable.  The
        // required branch below converts the same bounded evidence into its
        // finite preflight error without issuing a text request.
      }
      // Discovery is asynchronous.  Re-read the profile at the selection
      // boundary and fail closed if the captured execution snapshot became
      // stale; never adopt the newer profile for this leased job.
      const current = await providers.execution.text({ ownerUserId }, profile.id, "text", profile.model);
      if (current.id !== profile.id || current.providerType !== profile.providerType || current.model !== profile.model
        || current.endpointIdentity !== profile.endpointIdentity || current.contextWindowTokens !== profile.contextWindowTokens
        || current.maxOutputTokens !== profile.maxOutputTokens || current.temperature !== profile.temperature
        || current.requestTimeoutMs !== profile.requestTimeoutMs || stableStringify(current.configuration) !== stableStringify(profile.configuration)) {
        throw new ResponseContractPreflightError("response_contract_identity_mismatch", "The provider profile changed during response-contract discovery.");
      }
      const verificationEvidence: unknown[] = [];
      const responseProfile = { ...profile, providerType: profile.providerType as "openrouter" | "openai_compatible" };
      const eligibility = (operation: Parameters<typeof getProviderOutputSchema>[0], streaming: boolean) => {
        const schema = getProviderOutputSchema(operation);
        const result = providers.responseFormatCapabilities.eligibility({
          advertisement: advertised as never,
          providerType: responseProfile.providerType,
          endpointIdentity: profile.endpointIdentity ?? "",
          model: profile.model,
          routeConfigHash: capabilityRouteConfigHash(profile.configuration),
          adapterProtocol: "text-schema-adapter-v1",
          operation,
          schemaHash: schema.schemaHash,
          streaming,
          now: new Date().toISOString(),
          nativeOpenTrackerObjects: schema.requiresOpenTrackerObjects
        });
        verificationEvidence.push({ operation, streaming, status: result.status, reason: result.reason, verification: result.verification ?? null });
        return result;
      };
      return resolveGenerationResponseContracts({
        queuedPolicy,
        profile: runtimeProfile,
        registryDigest: providers.responseFormatCapabilities.registryDigest,
        eligible: eligibility,
        capabilityEvidenceHash: () => sha256(stableStringify({ advertisement: advertised, verificationEvidence }))
      });
    },
    promptFromSnapshot: providers.promptTools.content,
    recordProfileCost: (_database, profile, attribution, result) => withTransaction(pool, (client) =>
      providers.costs.recordGenerationCost(providers.costContext(client), {
        ...attribution,
        providerProfileId: profile.id,
        providerType: profile.providerType,
        requestedModel: profile.model,
        resolvedModel: result.modelInstanceId || profile.model,
        providerResponseId: result.responseId,
        usage: result.usage,
        reportedCost: result.reportedCost
      })
    ),
    attributeGenerationCostsToTurn: (client, ownerUserId, campaignId, generationJobId, turnId) =>
      providers.attributeCosts.attributeGenerationCostsToTurn(providers.costContext(client), {
        ownerUserId,
        campaignId,
        generationJobId,
        turnId
      })
  };
}

const productionFactories: WorkerGenerationCompositionFactories = {
  createRepository: createPostgresGenerationExecutionRepository,
  createCollaborators: createGenerationExecutionCollaborators,
  createExecutor: createGenerationExecutor,
  createApplication: createGenerationWorkerApplication
};

export function createWorkerGenerationApplication(
  pool: DatabasePool,
  illustration: IllustrationApplication,
  memory: MemoryApplication,
  providers: WorkerGenerationProviderCollaborators,
  factories: WorkerGenerationCompositionFactories = productionFactories,
): GenerationWorkerApplication {
  const repository = factories.createRepository(pool);
  const collaborators = factories.createCollaborators(pool, illustration, memory, providers);
  const executor = factories.createExecutor({
    pool,
    repository,
    collaborators
  });
  return factories.createApplication({ claims: repository, executor });
}
