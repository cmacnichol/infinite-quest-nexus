import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readerTurnNumberSchema, readerTurnResponseSchema } from "../../../packages/contracts/src/reader-history.js";
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
}
