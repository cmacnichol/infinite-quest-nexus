import type { TextModelSelection, TextExecutionPlan } from "@infinite-quest/contracts";
import { resolveTextExecutionPlans, type TextExecutionPlanDiscoveryPorts } from "./provider-preset-resolution.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";

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
    profile: { ownerUserId: input.ownerUserId, providerProfileId: input.execution.id, profileRevision: input.execution.executionRevision, authorityRevision: input.execution.authorityRevision, providerType: input.execution.providerType, selection, contextWindowTokens: input.execution.contextWindowTokens, maxOutputTokens: input.execution.maxOutputTokens, parameters: { temperature: input.execution.temperature }, endpointReference: input.execution.endpointIdentity ?? input.execution.id, credentialReference: input.execution.id, protocolVersion: "authoring-text-plan-v2" },
    operationPrompts: input.operationPrompts,
    ports: input.ports
  });
  return Object.freeze({ plans: resolved.plans });
}
