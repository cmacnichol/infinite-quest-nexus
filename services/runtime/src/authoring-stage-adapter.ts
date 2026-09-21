import type { AuthoringClaim, AuthoringExecutionRepository } from "../../../packages/application/src/authoring/ports.js";
import { authoringExecutionSnapshotSchema, authoringStageOutputSchema, type AuthoringExecutionSnapshot, type AuthoringStageOutput } from "../../../packages/application/src/authoring/types.js";
import {
  authoringResponseContractIdentity,
  authoringTextOperationV2Schema,
  readFrozenResponseContractsV2,
  readTextExecutionPlan,
  readTextExecutionRouteBasis,
  textExecutionPlanSchema,
  type AuthoringTextOperationV2,
  type FrozenResponseContractsV2,
  type TextExecutionPlan,
  type TextExecutionRouteBasis
} from "@infinite-quest/contracts";
import { bindFrozenResponseContractInvocationV2 } from "../../../packages/contracts/src/generation-response-contract.js";
import type { AuthoringTextOperation } from "../../../packages/contracts/src/authoring.js";
import { stableStringify } from "../../../packages/domain/src/text.js";
import type { RuntimeProviderExecutionPort, RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import { AuthoringResponseError } from "./authoring-response-adapter.js";
import {
  allocateOutlineCharacterIds,
  assembleExpandedWorldCharacter,
  expandWorldCharacterSeed,
  generateStandalonePlayableCharacter,
  generateWorldOutline
} from "./provider-world-generation-adapter.js";
import { buildTemplateWorldPrompt } from "../../../packages/domain/src/world-template.js";
import { CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, SOURCE_WORLD_PROMPT_PROTOCOL_VERSION, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../../packages/domain/src/authoring-prompts.js";
import { sourceDocumentFromNormalizedText } from "../../../packages/domain/src/source-authoring.js";
import { planSourceChunks } from "../../../packages/domain/src/source-authoring-budget.js";
import { createRuntimeSourceAuthoringRequestBudget, type NativeSourceAuthoringRequestExecution } from "./source-authoring-budget.js";
import { createSourceAuthoringAdapter, createSourceWorldAuthoringAdapter, renderSourceExtractionProviderRequest } from "./source-authoring-adapter.js";
import type { SourceWorldSelection } from "../../../packages/domain/src/source-world-proposal.js";
import {
  renderPreparedAuthoringRequest,
  serializePreparedAuthoringRequest,
  type PreparedAuthoringResponseContractExecution,
  type PreparedAuthoringTextExecutor,
  type PreparedDirectAuthoringTextExecution
} from "./authoring-text-execution-preparation.js";
import type { PreparedProviderRequest } from "../../../packages/story-engine/src/provider-request.js";
export type { PreparedAuthoringTextExecutor } from "./authoring-text-execution-preparation.js";

export const AUTHORING_EXECUTION_PROTOCOLS = Object.freeze({
  world: WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION,
  character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION
});

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Persistable provider identity: never credentials, endpoint URLs, or arbitrary configuration. */
export function createAuthoringExecutionSnapshot(
  execution: Readonly<{
    id: string;
    model: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    requestTimeoutMs: number;
    temperature: number;
    providerType?: string;
    endpointIdentity?: string;
    configuration: Readonly<Record<string, unknown>>;
  }>,
  prompts: Record<string, string>,
  protocols: Record<string, string>,
  sha256: (value: string) => string,
  prepared?: Readonly<Partial<Record<AuthoringTextOperation, TextExecutionPlan>>> | PreparedAuthoringResponseContractExecution
): AuthoringExecutionSnapshot {
  const textConfiguration = typeof execution.configuration.httpReferer === "string"
    ? { httpReferer: execution.configuration.httpReferer }
    : {};
  const base = {
    providerProfileId: execution.id,
    model: execution.model,
    configurationHash: sha256(stableJson({
      endpointIdentity: execution.endpointIdentity ?? null,
      model: execution.model,
      contextWindowTokens: execution.contextWindowTokens,
      maxOutputTokens: execution.maxOutputTokens,
      requestTimeoutMs: execution.requestTimeoutMs,
      temperature: execution.temperature,
      configuration: textConfiguration
    })),
    contextWindowTokens: execution.contextWindowTokens,
    maxOutputTokens: execution.maxOutputTokens,
    requestTimeoutMs: execution.requestTimeoutMs,
    prompts: { ...prompts },
    protocols: { ...protocols }
  };
  if (prepared && "routeBasis" in prepared) {
    if (execution.configuration.httpReferer !== undefined && typeof execution.configuration.httpReferer !== "string") {
      throw new Error("Authoring HTTP referer must be a string.");
    }
    return {
      ...base,
      version: 3,
      providerType: execution.providerType === "openai_compatible" ? "openai_compatible" : "openrouter",
      requestConfiguration: textConfiguration,
      routeBasis: prepared.routeBasis,
      frozenResponseContracts: prepared.frozenResponseContracts,
      textExecutionPlans: { ...prepared.plans },
      trustedOperationPrompts: { ...prepared.trustedOperationPrompts }
    } as AuthoringExecutionSnapshot;
  }
  return prepared && Object.keys(prepared).length > 0
    ? { ...base, version: 2, textExecutionPlans: { ...prepared } }
    : base;
}

export type LoadedAuthoringStage = Readonly<{
  jobId: string;
  stageId?: string;
  jobGeneration?: number;
  stageGeneration?: number;
  leaseToken?: string;
  input: Awaited<ReturnType<AuthoringExecutionRepository["loadClaim"]>> extends infer Claim
    ? Claim extends { input: infer Input } ? Input : never
    : never;
  snapshot: Awaited<ReturnType<AuthoringExecutionRepository["loadClaim"]>> extends infer Claim
    ? Claim extends { snapshot: infer Snapshot } ? Snapshot : never
    : never;
  stageKey: string;
  parentOutputs: AuthoringStageOutput[];
  sourcePlan?: unknown;
  sourceSelection?: SourceWorldSelection & Readonly<{ reviewGeneration: number }>;
  ownerUserId: string;
  currentClaim?(): Promise<boolean>;
}>;

type AuthoringExecutionSnapshotV2 = AuthoringExecutionSnapshot & Readonly<{
  version: 2;
  textExecutionPlans: Partial<Record<AuthoringTextOperation, TextExecutionPlan>>;
}>;

type BoundAuthoringExecutionSnapshotV3 = AuthoringExecutionSnapshot & Readonly<{
  version: 3;
  providerType: "openrouter" | "openai_compatible";
  requestConfiguration: Readonly<{ httpReferer?: string }>;
  routeBasis: TextExecutionRouteBasis;
  frozenResponseContracts: FrozenResponseContractsV2;
  textExecutionPlans: Partial<Record<AuthoringTextOperationV2, TextExecutionPlan>>;
  trustedOperationPrompts: Partial<Record<AuthoringTextOperationV2, string>>;
}>;

function v2Snapshot(snapshot: AuthoringExecutionSnapshot): snapshot is AuthoringExecutionSnapshotV2 {
  return "version" in snapshot && snapshot.version === 2;
}

function v3Snapshot(snapshot: AuthoringExecutionSnapshot | unknown): snapshot is BoundAuthoringExecutionSnapshotV3 {
  return Boolean(snapshot && typeof snapshot === "object" && "version" in snapshot && snapshot.version === 3);
}

function planMatchesHash(plan: TextExecutionPlan, sha256: (value: string) => string): boolean {
  const { planHash, ...withoutHash } = plan;
  return sha256(stableStringify(withoutHash)) === planHash;
}

function boundOperationFor(stage: LoadedAuthoringStage, repair: boolean): AuthoringTextOperationV2 {
  if (stage.stageKey === "world") return repair ? "worldOutlineRepair" : "worldOutline";
  if (stage.stageKey.startsWith("character:")) {
    return stage.parentOutputs.some((output) => output.kind === "outline")
      ? repair ? "seedCharacterRepair" : "seedCharacter"
      : repair ? "standaloneCharacterRepair" : "standaloneCharacter";
  }
  if (stage.stageKey === "source:synthesis") return repair ? "sourceSynthesisRepair" : "sourceSynthesis";
  if (stage.stageKey.startsWith("source:character:")) return repair ? "sourceCharacterRepair" : "sourceCharacter";
  return repair ? "sourceExtractionRepair" : "sourceExtraction";
}

function legacyV2OperationFor(stage: LoadedAuthoringStage, repair: boolean): AuthoringTextOperation {
  if (stage.stageKey === "world") return repair ? "worldOutlineRepair" : "worldOutline";
  if (stage.stageKey.startsWith("character:")) {
    if (stage.parentOutputs.some((output) => output.kind === "outline")) {
      return repair ? "seedCharacterRepair" : "seedCharacter";
    }
    return "standaloneCharacter";
  }
  if (stage.stageKey === "source:synthesis" || stage.stageKey.startsWith("source:character:")) {
    return repair ? "sourceWorldRepair" : "sourceWorld";
  }
  return repair ? "sourceExtractionRepair" : "sourceExtraction";
}

function sourcePlansFor(stage: LoadedAuthoringStage, sourceWorld: boolean): Readonly<{ initial: TextExecutionPlan; repair: TextExecutionPlan }> | undefined {
  if (v2Snapshot(stage.snapshot)) {
    const initial = stage.snapshot.textExecutionPlans[sourceWorld ? "sourceWorld" : "sourceExtraction"];
    const repair = stage.snapshot.textExecutionPlans[sourceWorld ? "sourceWorldRepair" : "sourceExtractionRepair"];
    return initial && repair ? { initial, repair } : undefined;
  }
  if (!v3Snapshot(stage.snapshot)) return undefined;
  const sourceCharacter = stage.stageKey.startsWith("source:character:");
  const initial = stage.snapshot.textExecutionPlans[
    sourceWorld ? sourceCharacter ? "sourceCharacter" : "sourceSynthesis" : "sourceExtraction"
  ];
  const repair = stage.snapshot.textExecutionPlans[
    sourceWorld ? sourceCharacter ? "sourceCharacterRepair" : "sourceSynthesisRepair" : "sourceExtractionRepair"
  ];
  return initial && repair ? { initial, repair } : undefined;
}

function validateBoundAuthoringOperationClosure(
  frozenResponseContracts: FrozenResponseContractsV2,
  planOperations: readonly string[],
  promptOperations: readonly string[]
): void {
  const frozenInvocationKeys = Object.keys(frozenResponseContracts.contracts).sort();
  const expectedOperations = authoringTextOperationV2Schema.options
    .filter((operation) => frozenInvocationKeys.includes(authoringResponseContractIdentity(operation).invocationKey))
    .sort();
  const plannedInvocationKeys = [...new Set(planOperations.map((operation) =>
    authoringResponseContractIdentity(operation).invocationKey
  ))].sort();
  if (stableStringify(planOperations) !== stableStringify(promptOperations)
    || stableStringify(plannedInvocationKeys) !== stableStringify(frozenInvocationKeys)
    || stableStringify(planOperations) !== stableStringify(expectedOperations)) {
    throw new Error("The saved authoring response contract operation closure is incomplete.");
  }
}

/**
 * Execute one already-claimed durable authoring stage.  The repository is the
 * authority for the claim fence and pinned snapshot; callers provide the
 * runtime-specific provider dispatcher so this boundary stays application-free.
 */
export async function executeAuthoringStage(options: Readonly<{
  claim: AuthoringClaim;
  repository: Pick<AuthoringExecutionRepository, "loadClaim"> & Partial<Pick<AuthoringExecutionRepository, "readClaimInput" | "initializeExecutionSnapshot">>;
  /** Called only for an uninitialized live claim; retries always reload the stored snapshot. */
  resolveSnapshot?(input: LoadedAuthoringStage["input"]): Promise<AuthoringExecutionSnapshot>;
  /** Runtime lease heartbeats may stop paid calls before database expiry. */
  currentClaim?(): Promise<boolean>;
  dispatch(stage: LoadedAuthoringStage): Promise<AuthoringStageOutput>;
}>): Promise<AuthoringStageOutput | null> {
  let loaded = await options.repository.loadClaim(options.claim);
  if (!loaded && options.resolveSnapshot && options.repository.readClaimInput && options.repository.initializeExecutionSnapshot) {
    const input = await options.repository.readClaimInput(options.claim);
    if (!input) return null;
    const snapshot = await options.resolveSnapshot(input);
    if (!await options.repository.initializeExecutionSnapshot(options.claim, snapshot)) return null;
    loaded = await options.repository.loadClaim(options.claim);
  }
  if (!loaded) return null;
  return options.dispatch({ ...loaded, stageId: options.claim.stageId, stageGeneration: options.claim.stageGeneration, jobId: options.claim.jobId, ownerUserId: options.claim.ownerUserId, currentClaim: async () => {
    if (options.currentClaim && !await options.currentClaim()) return false;
    if (!await options.repository.loadClaim(options.claim)) return false;
    // Local shutdown/heartbeat loss can happen while the database read waits.
    return options.currentClaim ? options.currentClaim() : true;
  }, jobGeneration: options.claim.jobGeneration, leaseToken: options.claim.leaseToken });
}

function authoringReservation(stage: LoadedAuthoringStage, repair: boolean) {
  if (!stage.stageId || stage.jobGeneration === undefined || stage.stageGeneration === undefined || !stage.leaseToken) {
    throw Object.assign(new Error("Prepared authoring execution requires the durable stage claim identity."), {
      code: "prepared_route_reservation_required"
    });
  }
  return {
    kind: "authoring" as const,
    ownerUserId: stage.ownerUserId,
    jobId: stage.jobId,
    stageId: stage.stageId,
    jobGeneration: stage.jobGeneration,
    stageGeneration: stage.stageGeneration,
    leaseToken: stage.leaseToken,
    operation: repair ? "repair" as const : "initial" as const
  };
}

function compatibleSnapshot(snapshot: AuthoringExecutionSnapshot, execution: RuntimeTextExecution, sha256: (value: string) => string): boolean {
  const current = createAuthoringExecutionSnapshot(execution, snapshot.prompts, snapshot.protocols, sha256);
  return current.configurationHash === snapshot.configurationHash
    && Object.entries(AUTHORING_EXECUTION_PROTOCOLS).every(([key, version]) => snapshot.protocols[key] === version)
    && current.model === snapshot.model
    && current.contextWindowTokens === snapshot.contextWindowTokens
    && current.maxOutputTokens === snapshot.maxOutputTokens
    && current.requestTimeoutMs === snapshot.requestTimeoutMs;
}

function providerFailureStage(stage: LoadedAuthoringStage): "world" | "character" | "source" {
  if (stage.input.kind === "story_source") return "source";
  return stage.stageKey === "world" ? "world" : "character";
}

/**
 * Provider-bound half of the durable adapter. It reloads credentials by exact
 * pinned profile/model and rejects drift instead of resolving a newer default.
 */
export function createRuntimeAuthoringStageDispatcher(options: Readonly<{
  execution: RuntimeProviderExecutionPort;
  sha256: (value: string) => string;
  /** Task 5 supplies route transport. Bound v3 cannot fall through to legacy execution. */
  preparedExecutor?: PreparedAuthoringTextExecutor;
}>): (stage: LoadedAuthoringStage) => Promise<AuthoringStageOutput> {
  return async (stage) => {
    let provider: RuntimeTextExecution;
    let preparedExecution: PreparedDirectAuthoringTextExecution | undefined;
    let nativeSourceExecution: NativeSourceAuthoringRequestExecution | undefined;
    if (v3Snapshot(stage.snapshot)) {
      const snapshot = authoringExecutionSnapshotSchema.parse(stage.snapshot) as BoundAuthoringExecutionSnapshotV3;
      const routeBasis = readTextExecutionRouteBasis(snapshot.routeBasis);
      const frozenResponseContracts = readFrozenResponseContractsV2(snapshot.frozenResponseContracts);
      const textExecutionPlans = Object.fromEntries(Object.entries(snapshot.textExecutionPlans).map(([operationValue, value]) => {
        const operation = authoringTextOperationV2Schema.parse(operationValue);
        return [operation, readTextExecutionPlan(value)];
      })) as Partial<Record<AuthoringTextOperationV2, TextExecutionPlan>>;
      const trustedOperationPrompts = Object.fromEntries(Object.entries(snapshot.trustedOperationPrompts).map(([operationValue, value]) => {
        const operation = authoringTextOperationV2Schema.parse(operationValue);
        if (typeof value !== "string" || !value.trim()) throw new Error("The saved authoring operation prompt is invalid.");
        return [operation, value];
      })) as Partial<Record<AuthoringTextOperationV2, string>>;
      const planOperations = Object.keys(textExecutionPlans).sort();
      const promptOperations = Object.keys(trustedOperationPrompts).sort();
      validateBoundAuthoringOperationClosure(
        frozenResponseContracts,
        planOperations,
        promptOperations
      );
      for (const [operationValue, trustedOperationPrompt] of Object.entries(trustedOperationPrompts)) {
        const operation = authoringTextOperationV2Schema.parse(operationValue);
        const plan = textExecutionPlans[operation];
        if (!plan) throw new Error("The saved authoring response contract is missing its operation plan.");
        const identity = authoringResponseContractIdentity(operation);
        bindFrozenResponseContractInvocationV2({
          frozen: frozenResponseContracts,
          routeBasis,
          plan,
          invocationKey: identity.invocationKey,
          operation: identity.operation,
          trustedOperationPrompt: trustedOperationPrompt!
        });
      }
      const initialOperation = boundOperationFor(stage, false);
      const repairOperation = boundOperationFor(stage, true);
      if (!textExecutionPlans[initialOperation] || !textExecutionPlans[repairOperation]
        || !trustedOperationPrompts[initialOperation] || !trustedOperationPrompts[repairOperation]
        || !options.preparedExecutor) {
        throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
      }
      const prepared: PreparedAuthoringResponseContractExecution = {
        routeBasis,
        plans: textExecutionPlans as Record<string, TextExecutionPlan>,
        modelAdvertisements: {},
        frozenResponseContracts,
        trustedOperationPrompts
      };
      const candidate = routeBasis.candidates[0]!;
      const prepareOperation = (operation: AuthoringTextOperationV2, request: Parameters<RuntimeTextExecution["execute"]>[0]) =>
        serializePreparedAuthoringRequest({
          execution: {
            providerType: snapshot.providerType,
            configuration: snapshot.requestConfiguration
          },
          prepared,
          operation,
          request
        });
      const executeBound = async (
        request: Parameters<RuntimeTextExecution["execute"]>[0],
        operation: AuthoringTextOperationV2,
        preparedRequest?: PreparedProviderRequest
      ) => {
        const plan = textExecutionPlans[operation]!;
        const trustedOperationPrompt = trustedOperationPrompts[operation]!;
        let authority: RuntimeTextExecution;
        try {
          authority = await options.execution.text({ ownerUserId: stage.ownerUserId }, snapshot.providerProfileId, "text");
        } catch {
          throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
        }
        if (authority.id !== snapshot.providerProfileId || authority.providerRole !== "text"
          || authority.authorityRevision !== routeBasis.authorityRevision
          || (authority.endpointIdentity ?? authority.id) !== routeBasis.endpointReference) {
          throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
        }
        const executorRequest = { ...request, systemPrompt: plan.prompt };
        const checkedRequest = preparedRequest ?? prepareOperation(operation, executorRequest);
        const identity = authoringResponseContractIdentity(operation);
        return options.preparedExecutor!.execute({
          plan,
          operation: identity.operation,
          invocationKey: identity.invocationKey,
          frozenResponseContracts,
          routeBasis,
          trustedOperationPrompt,
          ownerUserId: stage.ownerUserId,
          providerProfileId: snapshot.providerProfileId,
          request: executorRequest,
          preparedRequest: checkedRequest,
          logicalReservation: authoringReservation(stage, operation.endsWith("Repair")),
          ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
        });
      };
      provider = {
        id: snapshot.providerProfileId,
        name: "Frozen authoring contract",
        providerRole: "text",
        providerType: snapshot.providerType,
        model: candidate.modelId,
        contextWindowTokens: candidate.contextWindowTokens,
        maxOutputTokens: candidate.maxOutputTokens,
        temperature: routeBasis.parameters.temperature ?? 1,
        requestTimeoutMs: routeBasis.requestTimeoutMs,
        endpointIdentity: routeBasis.endpointReference,
        configuration: snapshot.requestConfiguration,
        execute: async (request) => executeBound(request, boundOperationFor(stage, request.rejectedResponse !== undefined))
      };
      preparedExecution = { execute: ({ request }) => provider.execute(request) };
      nativeSourceExecution = {
        renderInitial: (request) => renderPreparedAuthoringRequest({
          execution: { providerType: snapshot.providerType, configuration: snapshot.requestConfiguration },
          prepared, operation: boundOperationFor(stage, false), request
        }),
        renderRepair: (request) => renderPreparedAuthoringRequest({
          execution: { providerType: snapshot.providerType, configuration: snapshot.requestConfiguration },
          prepared, operation: boundOperationFor(stage, true), request
        }),
        prepareInitial: (request) => prepareOperation(boundOperationFor(stage, false), request),
        prepareRepair: (request) => prepareOperation(boundOperationFor(stage, true), request),
        executeInitial: (request, preparedRequest) => executeBound(request, boundOperationFor(stage, false), preparedRequest),
        executeRepair: (request, preparedRequest) => executeBound(request, boundOperationFor(stage, true), preparedRequest)
      };
    } else if (v2Snapshot(stage.snapshot)) {
      const snapshot = stage.snapshot;
      const initialOperation = legacyV2OperationFor(stage, false);
      const initialPlan = snapshot.textExecutionPlans[initialOperation as keyof typeof snapshot.textExecutionPlans];
      const plans = Object.values(snapshot.textExecutionPlans);
      if (!initialPlan || !plans.length || !plans.every((plan) => plan !== undefined && plan.authorityRevision !== undefined && plan.profileRevision === initialPlan.profileRevision && plan.authorityRevision === initialPlan.authorityRevision && planMatchesHash(textExecutionPlanSchema.parse(plan), options.sha256)) || !options.preparedExecutor) {
        throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
      }
      let authority: RuntimeTextExecution;
      try {
        authority = await options.execution.text({ ownerUserId: stage.ownerUserId }, snapshot.providerProfileId, "text");
      } catch {
        throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
      }
      if (authority.id !== snapshot.providerProfileId || authority.providerRole !== "text"
        || authority.authorityRevision !== initialPlan.authorityRevision) {
        throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
      }
      const candidate = initialPlan.candidates[0]!;
      provider = {
        id: stage.snapshot.providerProfileId,
        name: "Frozen authoring plan",
        providerRole: "text",
        providerType: "openrouter",
        model: candidate.modelId,
        contextWindowTokens: candidate.contextWindowTokens,
        maxOutputTokens: candidate.maxOutputTokens,
        temperature: initialPlan.parameters.temperature ?? 1,
        requestTimeoutMs: stage.snapshot.requestTimeoutMs,
        configuration: {},
        execute: async (request) => {
          const operation = legacyV2OperationFor(stage, request.rejectedResponse !== undefined);
          const plan = snapshot.textExecutionPlans[operation as keyof typeof snapshot.textExecutionPlans];
          if (!plan || !planMatchesHash(textExecutionPlanSchema.parse(plan), options.sha256)) {
            throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
          }
          return options.preparedExecutor!.execute({
            plan,
            operation,
            ownerUserId: stage.ownerUserId,
            providerProfileId: snapshot.providerProfileId,
            request: { ...request, systemPrompt: plan.prompt },
            logicalReservation: authoringReservation(stage, request.rejectedResponse !== undefined),
            ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
          });
        }
      };
      preparedExecution = { execute: ({ request }) => provider.execute(request) };
    } else {
      try {
        provider = await options.execution.text(
          { ownerUserId: stage.ownerUserId }, stage.snapshot.providerProfileId, "text", stage.snapshot.model,
          stage.snapshot.contextWindowTokens
        );
      } catch {
        throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
      }
      if (!compatibleSnapshot(stage.snapshot, provider, options.sha256)) {
        throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
      }
    }
    if (stage.input.kind === "story_source") {
      const isSourceWorldStage = stage.stageKey === "source:synthesis" || stage.stageKey.startsWith("source:character:");
      const actualSourceProtocol = isSourceWorldStage
        ? stage.snapshot.protocols.sourceWorld
        : stage.snapshot.protocols.source;
      const expectedSourceProtocol = isSourceWorldStage
        ? SOURCE_WORLD_PROMPT_PROTOCOL_VERSION
        : SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION;
      if (actualSourceProtocol !== expectedSourceProtocol) {
        throw new AuthoringResponseError({ code: "source_evidence_invalid", stage: "source", retryable: false, issues: [] });
      }
      const sourceInput = stage.input;
      const sourcePlans = sourcePlansFor(stage, isSourceWorldStage);
      const diagnosticContext = { authoringJobId: stage.jobId, stageKey: stage.stageKey, ...(stage.stageId === undefined ? {} : { stageId: stage.stageId }), ...(stage.stageGeneration === undefined ? {} : { stageGeneration: stage.stageGeneration }) };
      const requestBudget = createRuntimeSourceAuthoringRequestBudget(provider, undefined, diagnosticContext, nativeSourceExecution);
      if (isSourceWorldStage) {
        if (!stage.sourceSelection) {
          throw new AuthoringResponseError({ code: "source_review_conflict", stage: "source", retryable: false, issues: [] });
        }
        const selectedCharacterFactIds = stage.stageKey === "source:synthesis"
          ? []
          : [stage.stageKey.slice("source:character:".length)];
        if (selectedCharacterFactIds.some((id) => !stage.sourceSelection!.selectedCharacterFactIds.includes(id))) {
          throw new AuthoringResponseError({ code: "source_review_conflict", stage: "source", retryable: false, issues: [] });
        }
        const adapter = createSourceWorldAuthoringAdapter({ requestBudget, diagnosticContext, delay: async () => undefined,
          ...(sourcePlans === undefined ? {} : { plans: sourcePlans }) });
        const assembled = await adapter.synthesizeSourceWorld({
          selection: { ...stage.sourceSelection, selectedCharacterFactIds },
          reviewGeneration: stage.sourceSelection.reviewGeneration,
          instructions: sourceInput.instructions
        }, stage.currentClaim);
        return {
          kind: "source_world",
          proposal: assembled.proposal,
          mappings: assembled.mappings.map((mapping) => ({
            ...mapping,
            target: mapping.target === "world" ? "world" : { ...mapping.target },
            supportingFactIds: [...mapping.supportingFactIds]
          })),
          expansionCandidates: assembled.expansionCandidates.map((candidate) => ({
            ...candidate,
            target: candidate.target === "world" ? "world" : { ...candidate.target },
            supportingFactIds: [...candidate.supportingFactIds]
          }))
        };
      }
      const source = sourceDocumentFromNormalizedText(sourceInput.name, sourceInput.text, stage.jobId);
      if (stage.stageKey === "source:plan") {
        const chunks = planSourceChunks({
          source,
          boundaryParagraphId: sourceInput.boundaryParagraphId,
          systemPrompt: "",
          instructions: sourceInput.instructions,
          budget: requestBudget.budget,
          includeChunkCoordinates: true,
          mode: sourceInput.mode,
          renderRequest: (frame) => requestBudget.render(renderSourceExtractionProviderRequest({
            instructions: frame.instructions,
            sourceText: frame.sourceText,
            sourceRange: frame.sourceRange ?? { start: 0, end: 0 },
            paragraphSpans: frame.paragraphSpans ?? [],
            mode: frame.mode ?? sourceInput.mode,
            repair: frame.repair,
            issues: []
          }, sourcePlans?.initial))
        });
        return { kind: "source_plan", chunks: chunks.map((chunk) => ({
          ...chunk,
          sourceRange: { ...chunk.sourceRange },
          spans: chunk.spans.map((span) => ({ ...span }))
        })) };
      }
      if (stage.stageKey.startsWith("source:chunk:")) {
        const parentPlan = stage.parentOutputs.find((output) => output.kind === "source_plan");
        const persistedPlan = typeof stage.sourcePlan === "object" && stage.sourcePlan !== null && !Array.isArray(stage.sourcePlan)
          ? (stage.sourcePlan as { chunks?: unknown }).chunks
          : undefined;
        const plan = Array.isArray(persistedPlan)
          ? authoringStageOutputSchema.parse({ kind: "source_plan", chunks: persistedPlan })
          : parentPlan;
        const chunk = plan?.kind === "source_plan"
          ? plan.chunks.find((candidate) => stage.stageKey === `source:chunk:${candidate.id}`)
          : undefined;
        if (!chunk) throw new Error("Source extraction stage is missing its durable chunk plan.");
        const adapter = createSourceAuthoringAdapter({
          requestBudget,
          diagnosticContext,
          delay: async () => undefined,
          ...(sourcePlans === undefined ? {} : { plans: sourcePlans })
        });
        return { kind: "source_extraction", facts: await adapter.extractSourceChunk({
          source, chunk, boundaryParagraphId: sourceInput.boundaryParagraphId,
          mode: sourceInput.mode, instructions: sourceInput.instructions
        }, stage.currentClaim) };
      }
      throw new AuthoringResponseError({ code: "source_evidence_invalid", stage: "source", retryable: false, issues: [] });
    }
    if (stage.stageKey === "world") {
      if (stage.input.kind !== "world_concept") throw new Error("World stage input is invalid.");
      const input = {
        sourceName: "durable-authoring", sourceKind: "prompt" as const, title: "Untitled World",
        summary: stage.input.prompt, keywords: [], excerpts: [], prompt: stage.input.prompt
      };
      const outline = await generateWorldOutline({
        input,
        provider,
        ...(preparedExecution === undefined ? {} : { preparedExecution }),
        worldPrompt: buildTemplateWorldPrompt(input, stage.snapshot.prompts.world_generation ?? ""),
        prompt: stage.snapshot.prompts.world_generation ?? "",
        repairPrompt: stage.snapshot.prompts.world_generation_recovery ?? "",
        ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
      });
      return { kind: "outline", outline: allocateOutlineCharacterIds(outline) };
    }
    if (!stage.stageKey.startsWith("character:")) throw new Error("Unknown durable authoring stage.");
    const characterId = stage.stageKey.slice("character:".length);
    const outline = stage.parentOutputs.find((output) => output.kind === "outline");
    const seed = outline?.kind === "outline" ? outline.outline.seeds.find((candidate) => candidate.id === characterId) : undefined;
    if (seed && outline?.kind === "outline") {
      const expanded = await expandWorldCharacterSeed({
        provider,
        ...(preparedExecution === undefined ? {} : { preparedExecution }),
        outline: outline.outline,
        seed,
        characterIndex: outline.outline.seeds.findIndex((candidate) => candidate.id === characterId),
        acceptedCharacterNames: [],
        prompt: stage.snapshot.prompts.world_character_generation ?? "",
        repairPrompt: stage.snapshot.prompts.world_character_generation_recovery ?? "",
        ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
      });
      return { kind: "character", character: assembleExpandedWorldCharacter(expanded, characterId, outline.outline.seeds.findIndex((candidate) => candidate.id === characterId)) };
    }
    if (stage.input.kind !== "character") throw new Error("Character stage is missing its validated outline seed.");
    const requestedCharacterId = stage.input.target.kind === "world_draft"
      ? stage.input.target.characterId
      : stage.input.characterId;
    const currentCharacter = requestedCharacterId === undefined
      ? undefined
      : stage.input.content.playableCharacters.find((candidate) => candidate.id === requestedCharacterId);
    if (requestedCharacterId !== undefined && !currentCharacter) {
      throw new AuthoringResponseError({ code: "invalid_authoring_output", stage: "character", retryable: false, issues: [] });
    }
    const generated = await generateStandalonePlayableCharacter({
      provider,
      ...(preparedExecution === undefined ? {} : { preparedExecution }),
      content: stage.input.content,
      promptText: stage.input.prompt,
      currentCharacter,
      characterId,
      promptTemplate: stage.snapshot.prompts.character_generation ?? "",
      ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
    });
    return { kind: "character", character: generated.character };
  };
}
