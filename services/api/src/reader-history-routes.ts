import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  readerHistoryRequestSchema,
  readerHistoryResponseSchema,
  readerSceneWindowRequestSchema,
  readerSceneWindowResponseSchema,
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
    Querystring: {
      anchorTurnNumber?: string;
      anchorTurnId?: string;
      direction?: string;
      neighborLimit?: string;
      historyToken?: string;
    };
  }>(
    "/api/v1/campaigns/:campaignId/reader/scene-window",
    async (request, reply) => {
      const campaign = z.uuid().safeParse(request.params.campaignId);
      if (!campaign.success) return reply.code(400).send({ error: "Campaign id is invalid." });
      const parsedRequest = readerSceneWindowRequestSchema.safeParse(request.query);
      if (!parsedRequest.success) return reply.code(400).send({ error: "Scene window parameters are invalid." });
      const owner = await options.resolveOwner();
      const scope: ReaderHistoryScope = {
        ownerUserId: owner.ownerUserId,
        campaignId: campaign.data
      };
      try {
        const window = await options.application.getSceneWindow(scope, parsedRequest.data);
        if (!window) return reply.code(404).send({ error: "Reader anchor not found." });
        return readerSceneWindowResponseSchema.parse({ campaignId: scope.campaignId, ...window });
      } catch (error) {
        const statusCode = typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
        const details = typeof error === "object" && error !== null && "details" in error
          ? (error as { details?: unknown }).details
          : undefined;
        const code = typeof details === "object" && details !== null && "code" in details
          ? (details as { code?: unknown }).code
          : undefined;
        if (statusCode === 400) return reply.code(400).send({ error: "Scene window token is invalid.", code: "invalid_history_token" });
        if (statusCode === 404) return reply.code(404).send({ error: "Reader anchor not found." });
        if (statusCode === 409 && (code === "reader_anchor_changed" || code === "reader_history_changed")) {
          return reply.code(409).send({
            error: code === "reader_anchor_changed" ? "Reader anchor changed; reload the scene window." : "Campaign history changed; reload the scene window.",
            code
          });
        }
        throw error;
      }
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
