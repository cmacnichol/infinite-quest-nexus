import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  readerHistoryRequestSchema,
  readerHistoryResponseSchema,
  readerTurnNumberSchema,
  readerTurnResponseSchema
} from "../../../packages/contracts/src/reader-history.js";
import type { ReaderHistoryApplication, ReaderHistoryScope } from "../../../packages/application/src/reader-history/index.js";

export type ReaderHistoryRoutesOptions = Readonly<{
  application: ReaderHistoryApplication;
  resolveOwner: () => Promise<Readonly<{ ownerUserId: string }>>;
}>;

export async function registerReaderHistoryRoutes(
  app: FastifyInstance,
  options: ReaderHistoryRoutesOptions
): Promise<void> {
  app.get<{ Params: { campaignId: string; turnNumber: string } }>(
    "/api/v1/campaigns/:campaignId/reader/turns/:turnNumber",
    async (request, reply) => {
      const campaign = z.uuid().safeParse(request.params.campaignId);
      if (!campaign.success) return reply.code(400).send({ error: "Campaign id is invalid." });
      const parsedTurnNumber = readerTurnNumberSchema.safeParse(request.params.turnNumber);
      if (!parsedTurnNumber.success) return reply.code(400).send({ error: "Turn number must be a positive integer." });
      const owner = await options.resolveOwner();
      const scope: ReaderHistoryScope = {
        ownerUserId: owner.ownerUserId,
        campaignId: campaign.data
      };
      const turn = await options.application.getEffectiveTurn(scope, parsedTurnNumber.data);
      if (!turn) return reply.code(404).send({ error: "Turn not found." });
      return readerTurnResponseSchema.parse({ campaignId: scope.campaignId, turn });
    }
  );

  app.get<{
    Params: { campaignId: string };
    Querystring: { q?: string; before?: string; limit?: string };
  }>(
    "/api/v1/campaigns/:campaignId/reader/history",
    async (request, reply) => {
      const campaign = z.uuid().safeParse(request.params.campaignId);
      if (!campaign.success) return reply.code(400).send({ error: "Campaign id is invalid." });
      const parsedRequest = readerHistoryRequestSchema.safeParse(request.query);
      if (!parsedRequest.success) return reply.code(400).send({ error: "History search parameters are invalid." });
      const owner = await options.resolveOwner();
      const scope: ReaderHistoryScope = {
        ownerUserId: owner.ownerUserId,
        campaignId: campaign.data
      };
      try {
        const page = await options.application.searchHistory(scope, parsedRequest.data);
        return readerHistoryResponseSchema.parse({ campaignId: scope.campaignId, ...page });
      } catch (error) {
        const statusCode = typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
        if (statusCode === 400) return reply.code(400).send({ error: "History cursor is invalid." });
        if (statusCode === 409) return reply.code(409).send({ error: "Campaign history changed; reload history." });
        throw error;
      }
    }
  );
}
