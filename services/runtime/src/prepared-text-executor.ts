import {
  readTextExecutionRouteBasis,
  readTextExecutionPlan,
  type ResponseContractOperationV2,
  type ResponseInvocationKeyV2,
  type TextExecutionRouteBasis
} from "@infinite-quest/contracts";
import type { PhysicalAttemptRepository } from "../../../packages/story-engine/src/preset-route-execution.js";
import { executePresetRoutes, PreparedRouteTerminalError } from "../../../packages/story-engine/src/preset-route-execution.js";
import {
  estimatedInputSafetyAllowanceTokens,
  serializeCheckedBoundFrozenPresetProviderRequest,
  validateCompleteRejectedDraft,
  type BoundFrozenPresetProviderRequestBinding,
  type CanonicalProviderRequest
} from "../../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../../packages/story-engine/src/token-estimate.js";
import type { ProviderRequest, ProviderResult, TextProviderProfile } from "../../../packages/story-engine/src/providers.js";
import type { FrozenResponseContractsV2 } from "../../../packages/contracts/src/generation-response-contract.js";
import type { PreparedAuthoringTextExecutor } from "./authoring-text-execution-preparation.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";

function canonicalRequest(request: ProviderRequest): CanonicalProviderRequest {
  const completeRejectedDraft = validateCompleteRejectedDraft(request.rejectedResponse);
  return {
    systemPrompt: request.systemPrompt,
    input: request.input,
    ...(request.recoveryInput ? { recoveryInput: request.recoveryInput } : {}),
    ...(completeRejectedDraft ? { completeRejectedDraft } : {}),
    ...(request.onChunk ? { onChunk: request.onChunk } : {})
  };
}

function binding(input: Parameters<PreparedAuthoringTextExecutor["execute"]>[0], routeBasis: TextExecutionRouteBasis, candidateOrdinal: number): BoundFrozenPresetProviderRequestBinding {
  if (!input.frozenResponseContracts || !input.invocationKey || !input.routeBasis || !input.trustedOperationPrompt) {
    throw Object.assign(new Error("The prepared preset route is missing its frozen response-contract binding."), {
      code: "prepared_route_contract_unavailable"
    });
  }
  return {
    frozen: input.frozenResponseContracts as FrozenResponseContractsV2,
    routeBasis,
    plan: input.plan,
    invocationKey: input.invocationKey as ResponseInvocationKeyV2,
    operation: input.operation as ResponseContractOperationV2,
    trustedOperationPrompt: input.trustedOperationPrompt,
    candidateOrdinal
  };
}

function serializationProfile(candidate: TextExecutionRouteBasis["candidates"][number]): TextProviderProfile {
  return {
    providerType: "openrouter",
    baseUrl: "",
    model: candidate.modelId,
    contextWindowTokens: candidate.contextWindowTokens,
    maxOutputTokens: candidate.maxOutputTokens,
    temperature: 0
  };
}

export function createPreparedTextExecutor(input: Readonly<{
  attempts: PhysicalAttemptRepository;
  loadAuthority(ownerUserId: string, providerProfileId: string, model: string): Promise<RuntimeTextExecution>;
}>): PreparedAuthoringTextExecutor {
  return {
    summarize: (scope) => input.attempts.summarize(scope),
    async execute(execution) {
      if (!execution.logicalReservation) {
        throw Object.assign(new Error("Prepared text execution requires an explicit logical reservation."), {
          code: "prepared_route_reservation_required"
        });
      }
      const plan = readTextExecutionPlan(execution.plan);
      const routeBasis = execution.routeBasis ? readTextExecutionRouteBasis(execution.routeBasis) : null;
      if (plan.selection.kind === "openrouter_preset" && !routeBasis) {
        throw Object.assign(new Error("The frozen preset route basis is required."), { code: "prepared_route_contract_unavailable" });
      }
      const canonical = canonicalRequest(execution.request);
      const requestTimeoutMs = plan.requestTimeoutMs ?? 300_000;
      const authorized = new Map<number, RuntimeTextExecution>();
      let result: Awaited<ReturnType<typeof executePresetRoutes<ProviderResult>>>;
      try {
        result = await executePresetRoutes<ProviderResult>({
        candidates: plan.candidates,
        planProvenance: { planHash: plan.planHash, preset: plan.preset },
        logicalReservation: execution.logicalReservation,
        attempts: input.attempts,
        totalDeadlineMs: requestTimeoutMs,
        prepareCandidate(candidate, candidateOrdinal) {
          if (plan.selection.kind === "model") {
            if (candidateOrdinal !== 0 || !execution.preparedRequest) {
              throw Object.assign(new Error("The checked direct-model request is unavailable."), { code: "prepared_route_request_unavailable" });
            }
            return execution.preparedRequest;
          }
          const prepared = serializeCheckedBoundFrozenPresetProviderRequest(
            serializationProfile(candidate), canonical, binding(execution, routeBasis!, candidateOrdinal), {
              inputLimit: candidate.contextWindowTokens - candidate.maxOutputTokens,
              count: estimateStoryTokens,
              countMode: "estimated",
              safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
              contextWindowTokens: candidate.contextWindowTokens,
              output: execution.request.budgetOutput ?? { kind: "story_append" }
            }
          );
          if (candidateOrdinal === 0 && execution.preparedRequest
            && (execution.preparedRequest.body !== prepared.body || execution.preparedRequest.payloadHash !== prepared.payloadHash)) {
            throw Object.assign(new Error("The caller reservation does not match the executor's checked candidate body."), {
              code: "prepared_route_request_mismatch"
            });
          }
          return prepared;
        },
        async beforeDispatch(candidate, candidateOrdinal) {
          let current: RuntimeTextExecution;
          try {
            current = await input.loadAuthority(execution.ownerUserId, execution.providerProfileId, candidate.modelId);
          } catch (error) {
            throw Object.assign(new Error("The provider endpoint or credential authority is unavailable.", { cause: error }), {
              routeFailureReason: "authentication",
              code: "prepared_route_authority_revoked"
            });
          }
          if (current.id !== execution.providerProfileId || current.providerRole !== "text"
            || current.authorityRevision !== plan.authorityRevision
            || (current.endpointIdentity ?? current.id) !== plan.endpointReference) {
            throw Object.assign(new Error("The provider endpoint or credential authority was revoked."), {
              routeFailureReason: "authentication",
              code: "prepared_route_authority_revoked"
            });
          }
          authorized.set(candidateOrdinal, current);
        },
        async invoke(attempt) {
          if (execution.currentClaim && !await execution.currentClaim()) {
            throw Object.assign(new Error("The prepared text claim is no longer current."), { routeFailureReason: "cancelled" });
          }
          const current = authorized.get(attempt.candidateOrdinal);
          if (!current) throw Object.assign(new Error("The prepared route lost its authority preflight."), { routeFailureReason: "authentication" });
          const onChunk = execution.request.onChunk;
          const value = await current.execute({
            ...execution.request,
            // Prepared bodies are frozen authority evidence. A provider must
            // reject the contract rather than retrying a downgraded body.
            responseFormatFallback: "forbid",
            canonicalBudgeting: true,
            preparedRequest: { ...attempt.preparedRequest, operation: "story generation", budgetAudit: null },
            abortSignal: attempt.signal,
            onResponseHeaders: async (headers) => {
              if (headers.statusCode >= 200 && headers.statusCode < 300) {
                await attempt.onResponseStart({ providerResponseId: headers.providerResponseId ?? null });
              }
              await execution.request.onResponseHeaders?.(headers);
            },
            ...(onChunk ? { onChunk: async (delta: string, accumulated: string) => {
              await attempt.onOutput(delta);
              await onChunk(delta, accumulated);
            } } : {})
          }, {
            maxOutputTokens: attempt.candidate.maxOutputTokens,
            ...(plan.parameters.temperature === undefined ? {} : { temperature: execution.request.recoveryInput ? 0.2 : plan.parameters.temperature }),
            requestTimeoutMs: Math.max(1_000, requestTimeoutMs)
          });
          return value;
        }
        });
      } catch (error) {
        if (error instanceof PreparedRouteTerminalError) {
          try {
            error.physicalAccounting = await input.attempts.summarize({ kind: "logical", reservation: execution.logicalReservation });
          } catch {
            // The terminal route error remains authoritative if accounting reads fail.
          }
        }
        throw error;
      }
      let physicalAccounting: Awaited<ReturnType<PhysicalAttemptRepository["summarize"]>> | null = null;
      try {
        physicalAccounting = await input.attempts.summarize({ kind: "logical", reservation: execution.logicalReservation });
      } catch {
        // The provider response and physical attempt already completed. Keep
        // successful content; the durable ledger can be read again later.
      }
      return { ...result.value, physicalAttemptId: result.attemptId,
        ...(physicalAccounting ? { physicalAccounting } : {}) };
    }
  };
}
