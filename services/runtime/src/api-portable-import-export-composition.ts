import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { createPostgresWorldRepositoryAdapters } from "../../../packages/database/src/world-repository.js";
import { createPostgresImportProgressRepository } from "../../../packages/database/src/import-progress-repository.js";
import type { MemoryGenerationTransactionPort } from "../../../packages/application/src/memory/index.js";
import type { WorldRepositoryPort } from "../../../packages/application/src/world-campaign/ports.js";
import type { ImportProgressStorePort } from "../../../packages/application/src/imports/progress.js";
import type {
  PortableImportExportComposition,
  PrivatePortableExportBuilderPort,
} from "../../../packages/application/src/imports/private-portable-composition.js";
import { worldContentSchema } from "../../../packages/contracts/src/world-library.js";
import { removeArchivePath, type CompletedArchiveArtifact } from "../../api/src/archive-io.js";
import type { InfiniteWorldsImportProviderCollaborators } from "./infinite-worlds-provider-collaborators.js";
import { bindPrivateBoundedStreamLimits } from "../../../packages/application/src/assets/private-secure-storage.js";
import type { ApiAssetComposition } from "./api-asset-composition.js";
import {
  buildCampaignArchiveArtifact,
  type CampaignArchiveExportAssetReader,
} from "./campaign-archive-export-composition.js";
import { extractJsonObject } from "../../../packages/story-engine/src/index.js";
import {
  createPortableImportExportComposition,
  type PortableImportExportCompositionOptions,
  type PortableTargetWorldReaderPort,
} from "./portable-import-export-composition.js";

export type ApiPortableImportExportComposition = Readonly<{
  portable: PortableImportExportComposition;
  progress: ImportProgressStorePort;
  close(): Promise<void>;
}>;

export type ApiPortableImportExportCompositionOptions = Readonly<{
  pool: DatabasePool;
  config: RuntimeConfig;
  memory: MemoryGenerationTransactionPort;
  providers: InfiniteWorldsImportProviderCollaborators;
  leaseOwner: string;
  assetReader?: CampaignArchiveExportAssetReader;
}>;

export type ApiPortableImportExportCompositionFactories = Readonly<{
  createWorlds(pool: DatabasePool, memory: MemoryGenerationTransactionPort): WorldRepositoryPort;
  createTargets(pool: DatabasePool): PortableTargetWorldReaderPort;
  createExports(
    pool: DatabasePool,
    config: RuntimeConfig,
    assetReader?: CampaignArchiveExportAssetReader,
  ): PrivatePortableExportBuilderPort;
  createProgress(pool: DatabasePool): ImportProgressStorePort;
  createComposition(options: PortableImportExportCompositionOptions): Promise<PortableImportExportComposition>;
}>;

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404, expose: true });
}

async function* archiveSource(
  archiveRoot: string,
  artifact: CompletedArchiveArtifact,
): AsyncGenerator<Uint8Array> {
  const source = createReadStream(artifact.absolutePath);
  try {
    for await (const chunk of source) yield new Uint8Array(chunk);
  } finally {
    if (!source.destroyed) source.destroy();
    await removeArchivePath(archiveRoot, artifact.relativePath).catch(() => undefined);
  }
}

export function createApiPortableTargetReader(pool: DatabasePool): PortableTargetWorldReaderPort {
  return {
    async readTargetWorldVersion(input) {
      const result = await pool.query<{
        owner_user_id: string;
        world_id: string;
        world_version_id: string;
        content: unknown;
      }>(
        `SELECT world_versions.owner_user_id, world_versions.world_id,
                world_versions.id AS world_version_id, world_versions.content
           FROM world_versions
          WHERE world_versions.id = $1
            AND world_versions.world_id = $2
            AND world_versions.owner_user_id = $3`,
        [input.worldVersionId, input.worldId, input.owner.ownerUserId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : Object.freeze({
          ownerUserId: row.owner_user_id,
          worldId: row.world_id,
          worldVersionId: row.world_version_id,
          content: worldContentSchema.parse(row.content),
        });
    },
  };
}

export function createApiPortableExportBuilder(
  pool: DatabasePool,
  config: RuntimeConfig,
  assetReader: CampaignArchiveExportAssetReader,
): PrivatePortableExportBuilderPort {
  return {
    async buildCampaignArchive(input) {
      const scope = await pool.query<{ world_id: string; world_version_id: string }>(
        `SELECT world_versions.world_id, campaigns.world_version_id
           FROM campaigns
           JOIN world_versions
             ON world_versions.id = campaigns.world_version_id
            AND world_versions.owner_user_id = campaigns.owner_user_id
          WHERE campaigns.id = $1 AND campaigns.owner_user_id = $2`,
        [input.campaignId, input.owner.ownerUserId],
      );
      const campaign = scope.rows[0];
      if (campaign === undefined) throw notFound("Campaign not found.");
      const archive = await buildCampaignArchiveArtifact(pool, assetReader, {
        ownerUserId: input.owner.ownerUserId,
        campaignId: input.campaignId,
        archiveRoot: config.archiveStorageRoot,
        limits: config.campaignArchiveLimits,
      });
      return Object.freeze({
        exportScope: {
          ownerUserId: input.owner.ownerUserId,
          exportKind: "campaign_zip" as const,
          campaignId: input.campaignId,
          worldId: campaign.world_id,
          worldVersionId: campaign.world_version_id,
        },
        contentType: "application/zip" as const,
        byteLength: archive.byteLength,
        source: archiveSource(config.archiveStorageRoot, archive),
      });
    },
    async buildWorldJson(input) {
      const result = await pool.query<{ title: string; content: unknown }>(
        `SELECT worlds.title, world_versions.content
           FROM world_versions
           JOIN worlds ON worlds.id = world_versions.world_id
          WHERE world_versions.id = $1
            AND world_versions.world_id = $2
            AND world_versions.owner_user_id = $3`,
        [input.worldVersionId, input.worldId, input.owner.ownerUserId],
      );
      const row = result.rows[0];
      if (row === undefined) throw notFound("World version not found.");
      const source = Buffer.from(JSON.stringify({
        format: "infinite-quest-world",
        formatVersion: 1,
        title: row.title,
        content: worldContentSchema.parse(row.content),
      }), "utf8");
      return Object.freeze({
        exportScope: {
          ownerUserId: input.owner.ownerUserId,
          exportKind: "world_json" as const,
          campaignId: null,
          worldId: input.worldId,
          worldVersionId: input.worldVersionId,
        },
        contentType: "application/json" as const,
        byteLength: source.byteLength,
        source: [source],
      });
    },
  };
}

export function createApiCampaignArchiveAssetReader(
  assets: Pick<ApiAssetComposition, "storage">,
): CampaignArchiveExportAssetReader {
  return Object.freeze({
    async readOriginal(input) {
      const session = await assets.storage.adapter.openAssetSession({
        scope: { ownerUserId: input.ownerUserId, assetId: input.assetId },
        request: { kind: "original" },
        limits: bindPrivateBoundedStreamLimits({
          maximumBytes: input.maximumBytes,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      if (!session) throw Object.assign(new Error("Asset not found."), { statusCode: 404 });
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        for await (const chunk of session.chunks) {
          byteLength += chunk.byteLength;
          if (byteLength > input.maximumBytes) throw new Error("archive_size_limit_exceeded");
          chunks.push(chunk);
        }
        await session.finalize("eof");
      } catch (error) {
        await session.finalize("read_failure").catch(() => undefined);
        throw error;
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength);
    },
  });
}

function providerConfigurationFingerprint(input: Readonly<{ providerProfileId: string; model?: string }>): string {
  return createHash("sha256")
    .update(JSON.stringify({ providerProfileId: input.providerProfileId, model: input.model ?? null }))
    .digest("hex");
}

const defaultFactories: ApiPortableImportExportCompositionFactories = Object.freeze({
  createWorlds: (pool, memory) => createPostgresWorldRepositoryAdapters(pool, { memory }).worlds,
  createTargets: createApiPortableTargetReader,
  createExports(pool, config, assetReader) {
    if (assetReader === undefined) throw new Error("campaign_archive_asset_reader_required");
    return createApiPortableExportBuilder(pool, config, assetReader);
  },
  createProgress: createPostgresImportProgressRepository,
  createComposition: createPortableImportExportComposition,
});

/**
 * e3g's API role binding: Fastify owns transport parsing and response mapping;
 * this factory owns only durable private import/export dependencies.
 */
export async function createApiPortableImportExportComposition(
  input: ApiPortableImportExportCompositionOptions,
  factories: ApiPortableImportExportCompositionFactories = defaultFactories,
): Promise<ApiPortableImportExportComposition> {
  if (factories === defaultFactories && input.assetReader === undefined) {
    throw new Error("campaign_archive_asset_reader_required");
  }
  const progress = factories.createProgress(input.pool);
  const portable = await factories.createComposition({
    pool: input.pool,
    roots: {
      archiveRoot: input.config.archiveStorageRoot,
      assetRoot: input.config.assetStorageRoot,
    },
    worlds: factories.createWorlds(input.pool, input.memory),
    provider: {
      async convertTemplate(command) {
        if (command.providerSelection === undefined) {
          throw Object.assign(new Error("Select a text provider to convert this import."), { statusCode: 400, expose: true });
        }
        const generated = await input.providers.generateCyoaWorld({
          ownerUserId: command.ownerUserId,
          providerProfileId: command.providerSelection.providerProfileId,
          input: command.template,
          worldId: `portable-preview-${randomUUID()}`,
          ...(command.providerSelection.model === undefined ? {} : { model: command.providerSelection.model }),
          ...(command.progress === undefined ? {} : {
            onProgress: (phase, progressPercent, message) => progress.update(command.progress!, {
              phase,
              progressPercent,
              message,
            }),
          }),
        });
        return Object.freeze({
          world: {
            format: "infinite-quest-world" as const,
            formatVersion: 1 as const,
            title: generated.title,
            content: generated.content,
          },
          providerConfigurationFingerprint: providerConfigurationFingerprint(command.providerSelection),
        });
      },
      async enrichStoryFinalTurn(command) {
        const resolution = await input.providers.resolution.resolveDirect({
          ownerUserId: command.ownerUserId,
          providerRole: "text",
          selectedProviderProfileId: command.providerSelection.providerProfileId,
          ...(command.providerSelection.model === undefined ? {} : { model: command.providerSelection.model }),
        });
        if (resolution.status !== "resolved") {
          throw Object.assign(new Error("The selected text provider is unavailable."), {
            statusCode: 409,
            expose: true,
          });
        }
        const provider = await input.providers.execution.text(
          { ownerUserId: command.ownerUserId },
          resolution.providerProfileId,
          "text",
          resolution.model,
        );
        const promptOperationId = `portable-story:${createHash("sha256")
          .update(JSON.stringify({ sourceName: command.sourceName, story: command.story }))
          .digest("hex")}`;
        const snapshot = (await input.providers.prompts.loadInfiniteWorldsPromptSnapshot({
          ownerUserId: command.ownerUserId,
          importId: promptOperationId,
        })).snapshot;
        const result = await provider.execute({
          systemPrompt: input.providers.promptTools.content(snapshot, "infinite_worlds_final_turn"),
          input: JSON.stringify({
            world: command.story.world,
            recentTurns: command.story.turns.slice(-6).map((turn) => ({
              action: turn.action,
              narration: turn.narration ?? turn.story ?? turn.text,
            })),
          }),
        });
        if (result.outputLimited) {
          throw Object.assign(new Error("Final-turn enrichment reached the provider output limit."), {
            statusCode: 409,
            expose: true,
          });
        }
        return Object.freeze({
          metadata: extractJsonObject(result.content),
          providerConfigurationFingerprint: providerConfigurationFingerprint(command.providerSelection),
        });
      },
    },
    targets: factories.createTargets(input.pool),
    exports: factories.createExports(
      input.pool,
      input.config,
      input.assetReader,
    ),
    leaseOwner: input.leaseOwner,
  });
  let closed: Promise<void> | undefined;
  return Object.freeze({
    portable,
    progress,
    close() {
      closed ??= portable.close();
      return closed;
    },
  });
}
