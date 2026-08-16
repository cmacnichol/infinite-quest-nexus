import {
  acceptedTurnCorrectionRequestSchema,
  acceptedTurnCorrectionViewSchema
} from "@infinite-quest/contracts";
import { TurnCorrectionApplicationError, mapTurnCorrectionFailure } from "./errors.js";
import type {
  TurnCorrectionApplication,
  TurnCorrectionApplicationDependencies
} from "./ports.js";
import type { TurnCorrectionScope } from "./types.js";

function requireScope(scope: TurnCorrectionScope): void {
  if (!scope.ownerUserId.trim() || !scope.campaignId.trim()) {
    throw new TurnCorrectionApplicationError("invalid_request", "owner_scope_required");
  }
}

export function createTurnCorrectionApplication(
  dependencies: TurnCorrectionApplicationDependencies,
): TurnCorrectionApplication {
  return {
    async correctNarration(scope, request) {
      requireScope(scope);
      const parsed = acceptedTurnCorrectionRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new TurnCorrectionApplicationError("invalid_request", "invalid_request");
      }
      const result = await dependencies.corrections.correctNarration(scope, parsed.data);
      if (!result.ok) throw mapTurnCorrectionFailure(result.failure);
      return acceptedTurnCorrectionViewSchema.parse(result.value);
    },
    async getEffectiveNarration(scope, turnId) {
      requireScope(scope);
      const parsedTurnId = acceptedTurnCorrectionRequestSchema.shape.turnId.safeParse(turnId);
      if (!parsedTurnId.success) {
        throw new TurnCorrectionApplicationError("invalid_request", "invalid_request");
      }
      const value = await dependencies.corrections.getEffectiveNarration(scope, parsedTurnId.data);
      return value === null ? null : acceptedTurnCorrectionViewSchema.parse(value);
    }
  };
}
