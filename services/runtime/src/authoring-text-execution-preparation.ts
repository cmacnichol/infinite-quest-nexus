import type { TextModelSelection, TextExecutionPlan } from "@infinite-quest/contracts";
import type { ProviderRequest, ProviderResult } from "../../../packages/story-engine/src/providers.js";
import { resolveTextExecutionPlans, type TextExecutionPlanDiscoveryPorts } from "./provider-preset-resolution.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";

export type PreparedAuthoringTextExecutor = Readonly<{
  execute(input: Readonly<{
    plan: TextExecutionPlan;
    operation: string;
    ownerUserId: string;
    providerProfileId: string;
    request: ProviderRequest;
    currentClaim?: () => Promise<boolean>;
  }>): Promise<ProviderResult>;
}>;

/** Runtime-owned capabilities for optional native direct-consumer execution. */
export type DirectAuthoringTextPlanOptions = Readonly<{
  nativePresetPlansEnabled?: boolean;
  preparedExecutor?: PreparedAuthoringTextExecutor;
  /** Reloads only current owner/profile authority before each paid dispatch. */
  loadAuthority?(input: Readonly<{ ownerUserId: string; providerProfileId: string }>): Promise<Pick<RuntimeTextExecution, "id" | "providerRole" | "authorityRevision" | "endpointIdentity">>;
  ports: TextExecutionPlanDiscoveryPorts;
}>;

export type PreparedDirectAuthoringTextExecution = Readonly<{
  execute(input: Readonly<{ operation: string; request: ProviderRequest }>): Promise<ProviderResult>;
}>;

/** Private one-read preparation seam shared by durable and direct authoring. */
export async function prepareAuthoringTextExecution(input: Readonly<{
  ownerUserId: string;
  execution: RuntimeTextExecution;
  operationPrompts: Readonly<Record<string, string>>;
  ports: TextExecutionPlanDiscoveryPorts;
  selectionOverride?: TextModelSelection;
}>): Promise<Readonly<{ plans: Readonly<Record<string, TextExecutionPlan>> }>> {
  if (!input.execution.authorityRevision || !input.execution.executionRevision) {
    throw new Error("Authoring v2 preparation requires current execution and authority revisions.");
  }
  const selection = input.selectionOverride ?? input.execution.textSelection ?? { kind: "model" as const, modelId: input.execution.model };
  const resolved = await resolveTextExecutionPlans({
    profile: { ownerUserId: input.ownerUserId, providerProfileId: input.execution.id, profileRevision: input.execution.executionRevision, authorityRevision: input.execution.authorityRevision, providerType: input.execution.providerType, selection, contextWindowTokens: input.execution.contextWindowTokens, maxOutputTokens: input.execution.maxOutputTokens, requestTimeoutMs: input.execution.requestTimeoutMs, parameters: { temperature: input.execution.temperature }, endpointReference: input.execution.endpointIdentity ?? input.execution.id, credentialReference: input.execution.id, protocolVersion: "authoring-text-plan-v2" },
    operationPrompts: input.operationPrompts,
    ports: input.ports
  });
  return Object.freeze({ plans: resolved.plans });
}

/**
 * Prepares one direct workflow and carries explicit operation identity to the
 * future route executor. Callers retain their local validators and repair
 * behavior; this seam only replaces native-preset request dispatch.
 */
export async function prepareDirectAuthoringTextExecution(input: Readonly<{
  ownerUserId: string;
  execution: RuntimeTextExecution;
  operationPrompts: Readonly<Record<string, string>>;
  options?: DirectAuthoringTextPlanOptions;
  selectionOverride?: TextModelSelection;
}>): Promise<PreparedDirectAuthoringTextExecution | null> {
  const options = input.options;
  const selection = input.selectionOverride ?? input.execution.textSelection;
  if (options?.nativePresetPlansEnabled !== true || !selection
    || (selection.kind !== "openrouter_preset" && input.selectionOverride === undefined)) return null;
  if (!options.preparedExecutor || !options.loadAuthority) throw new Error("Native authoring execution is unavailable.");
  const prepared = await prepareAuthoringTextExecution({
    ownerUserId: input.ownerUserId,
    execution: input.execution,
    operationPrompts: input.operationPrompts,
    ports: options.ports,
    ...(input.selectionOverride === undefined ? {} : { selectionOverride: input.selectionOverride })
  });
  return Object.freeze({
    execute: async ({ operation, request }) => {
      const plan = prepared.plans[operation];
      if (!plan) throw new Error(`Native authoring plan is missing operation '${operation}'.`);
      const authority = await options.loadAuthority!({ ownerUserId: input.ownerUserId, providerProfileId: input.execution.id });
      if (authority.id !== input.execution.id || authority.providerRole !== "text"
        || authority.authorityRevision !== plan.authorityRevision) {
        throw new Error("Native authoring provider authority is unavailable.");
      }
      return options.preparedExecutor!.execute({
        plan,
        operation,
        ownerUserId: input.ownerUserId,
        providerProfileId: input.execution.id,
        request: { ...request, systemPrompt: plan.prompt }
      });
    }
  });
}
