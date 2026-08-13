import {
  createWorldCampaignApplication,
  mapWorldCampaignTransitionFailure,
  type CharacterProfileOrganizerPort,
  type WorldCampaignApplication,
  type WorldCampaignRepositoryResult,
  type WorldGenerationCollaboratorPort,
  type WorldGenerationProgressRepositoryPort
} from "../../../packages/application/src/world-campaign/index.js";
import { createPostgresChronicleGenerationTransactionPort } from "../../../packages/database/src/chronicle-repository.js";
import {
  createPostgresBoundedCampaignTurnPageAdapter,
  createPostgresCampaignAuthorityAdapters
} from "../../../packages/database/src/campaign-state-repository.js";
import {
  createPostgresCampaignTransferRepository,
  createPostgresCharacterProfileRepository
} from "../../../packages/database/src/campaign-transfer-character-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import {
  createPostgresDashboardRepository,
  createPostgresSessionProfileRepository,
  createPostgresWorldGenerationProgressRepository
} from "../../../packages/database/src/world-generation-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../../packages/database/src/world-repository.js";
import {
  organizeCampaignCharacterProfileForOwner,
  organizeWorldCharacterProfileForOwner
} from "./provider-character-organization-adapter.js";
import {
  generatePlayableCharacterForOwner,
  generatePlayableCharacterPreviewForOwner,
  generateWorldPreviewForOwner
} from "./provider-world-generation-adapter.js";
import { createChroniclePlatformBindings } from "./chronicle-platform-bindings.js";
import type {
  ApiGenerationProviderCollaborators,
  CharacterOrganizationProviderCollaborators,
  ChronicleProviderCollaborators,
  WorldGenerationProviderCollaborators
} from "./provider-application-composition.js";

export type WorldCampaignCompositionDependencies = Readonly<{
  worldGeneration: WorldGenerationProviderCollaborators;
  characterOrganization: CharacterOrganizationProviderCollaborators;
  chronicle: ChronicleProviderCollaborators;
  generation: Pick<ApiGenerationProviderCollaborators, "reads">;
}>;

/** Binds owner-scoped provider and prompt collaborators to character organization. */
export function createProviderCharacterProfileOrganizer(
  pool: DatabasePool,
  providers: CharacterOrganizationProviderCollaborators,
): CharacterProfileOrganizerPort {
  const organizer: CharacterProfileOrganizerPort = {
    organizeCampaignCharacterProfile: (scope, request) => organizeCampaignCharacterProfileForOwner(
      pool,
      scope.ownerUserId,
      scope.campaignId,
      request,
      providers,
    ),
    organizeWorldCharacterProfile: (scope, request) => organizeWorldCharacterProfileForOwner(
      pool,
      scope.ownerUserId,
      scope.worldId,
      request,
      providers,
    )
  };
  return Object.freeze(organizer);
}

async function unwrapTransition<T>(result: WorldCampaignRepositoryResult<T>): Promise<T> {
  if (!result.ok) throw mapWorldCampaignTransitionFailure(result.failure);
  return result.value;
}

/** Binds owner-scoped provider and prompt collaborators to world generation. */
export function createProviderWorldGenerationCollaborator(
  pool: DatabasePool,
  providers: WorldGenerationProviderCollaborators,
  transaction: ReturnType<typeof createPostgresWorldRepositoryAdapters>["transaction"],
  progress: WorldGenerationProgressRepositoryPort,
): WorldGenerationCollaboratorPort {
  const createProgress = async (
    _pool: DatabasePool,
    ownerUserId: string,
    progressKey: string,
  ): Promise<void> => unwrapTransition(await transaction.command((database) => (
    progress.createWorldGenerationProgress(database, { ownerUserId, progressKey })
  )));
  const updateProgress = async (
    _pool: DatabasePool,
    ownerUserId: string,
    progressKey: string,
    update: Parameters<WorldGenerationProgressRepositoryPort["updateWorldGenerationProgress"]>[2],
  ): Promise<void> => unwrapTransition(await transaction.command((database) => (
    progress.updateWorldGenerationProgress(database, { ownerUserId, progressKey }, update)
  )));
  const providerDependencies = {
    createWorldGenerationProgress: createProgress,
    updateWorldGenerationProgress: updateProgress,
  };
  const collaborator: WorldGenerationCollaboratorPort = {
    generateWorldPreview: (scope, request) => generateWorldPreviewForOwner(
      pool,
      scope.ownerUserId,
      request,
      providers,
      providerDependencies
    ),
    generatePlayableCharacterPreview: (scope, request) => generatePlayableCharacterPreviewForOwner(
      pool,
      scope.ownerUserId,
      request,
      providers,
    ),
    generatePlayableCharacter: (scope, request) => generatePlayableCharacterForOwner(
      pool,
      scope.ownerUserId,
      scope.worldId,
      request,
      providers,
    )
  };
  return Object.freeze(collaborator);
}

/** Composes Task 14c's sole API world/campaign application over owner-scoped PostgreSQL ports. */
export function createApiWorldCampaignApplication(
  pool: DatabasePool,
  dependencies: WorldCampaignCompositionDependencies,
): WorldCampaignApplication {
  const memory = createPostgresChronicleGenerationTransactionPort({
    embeddings: createChroniclePlatformBindings(dependencies.chronicle).embeddings
  });
  const turnPages = createPostgresBoundedCampaignTurnPageAdapter(pool, {
    turnReportedCosts: async (_database, ownerUserId, campaignId, turnIds) =>
      new Map(await dependencies.generation.reads.getTurnCosts({ ownerUserId, campaignId, turnIds }))
  });
  const worldAdapters = createPostgresWorldRepositoryAdapters(pool, { memory });
  const authorityAdapters = createPostgresCampaignAuthorityAdapters(pool, { memory, turnPages });
  const progress = createPostgresWorldGenerationProgressRepository();
  return createWorldCampaignApplication({
    transaction: worldAdapters.transaction,
    worlds: worldAdapters.worlds,
    campaigns: Object.freeze({
      ...worldAdapters.campaigns,
      ...authorityAdapters.campaigns
    }),
    state: authorityAdapters.state,
    sync: authorityAdapters.sync,
    turnPages,
    characters: createPostgresCharacterProfileRepository(),
    characterOrganizer: createProviderCharacterProfileOrganizer(pool, dependencies.characterOrganization),
    transfers: createPostgresCampaignTransferRepository({ memory }),
    dashboard: createPostgresDashboardRepository(),
    sessionProfile: createPostgresSessionProfileRepository(),
    worldGeneration: createProviderWorldGenerationCollaborator(
      pool,
      dependencies.worldGeneration,
      worldAdapters.transaction,
      progress
    ),
    progress
  });
}
