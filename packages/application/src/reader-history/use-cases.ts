import {
  readerHistoryRequestSchema,
  readerSceneWindowRequestSchema,
  readerTurnNumberSchema
} from "@infinite-quest/contracts";
import type { ReaderHistoryApplication, ReaderHistoryApplicationDependencies, ReaderHistoryScope } from "./ports.js";

function requireScope(scope: ReaderHistoryScope): void {
  if (!scope.ownerUserId.trim() || !scope.campaignId.trim()) {
    throw Object.assign(new Error("owner_scope_required"), { statusCode: 400 });
  }
}

export function createReaderHistoryApplication(
  dependencies: ReaderHistoryApplicationDependencies
): ReaderHistoryApplication {
  return {
    async getEffectiveTurn(scope, turnNumber) {
      requireScope(scope);
      const parsedTurnNumber = readerTurnNumberSchema.parse(turnNumber);
      return dependencies.turns.getEffectiveTurn(scope, parsedTurnNumber);
    },
    async searchHistory(scope, options) {
      requireScope(scope);
      const parsedOptions = readerHistoryRequestSchema.parse(options);
      return dependencies.turns.searchHistory(scope, parsedOptions);
    },
    async getSceneWindow(scope, request) {
      requireScope(scope);
      const parsedRequest = readerSceneWindowRequestSchema.parse(request);
      return dependencies.turns.getSceneWindow(scope, parsedRequest);
    }
  };
}
