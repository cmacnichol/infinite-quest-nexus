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
} from "../../api/src/character-profile-service.js";
import { turnReportedCosts } from "../../api/src/cost-service.js";
import { resolveEffectiveProviderId } from "../../api/src/provider-service.js";
import {
  generatePlayableCharacterForOwner,
  generatePlayableCharacterPreviewForOwner,
  generateTemplateWorld,
  generateWorldPreviewForOwner
} from "../../api/src/world-generator-service.js";
import { createChroniclePlatformBindings } from "./chronicle-platform-bindings.js";

export type WorldCampaignCompositionDependencies = Readonly<{
  credentialSecret: string;
}>;

/** Temporary 14d-owned provider/prompt binding; remove when Task 14d supplies its application port. */
export function createTask14dCharacterProfileOrganizer(
  pool: DatabasePool,
  credentialSecret: string,
): CharacterProfileOrganizerPort {
  const organizer: CharacterProfileOrganizerPort = {
    organizeCampaignCharacterProfile: (scope, request) => organizeCampaignCharacterProfileForOwner(
      pool,
      scope.ownerUserId,
      scope.campaignId,
      request,
      credentialSecret
    ),
    organizeWorldCharacterProfile: (scope, request) => organizeWorldCharacterProfileForOwner(
      pool,
      scope.ownerUserId,
      scope.worldId,
      request,
      credentialSecret
    )
  };
  return Object.freeze(organizer);
}

async function unwrapTransition<T>(result: WorldCampaignRepositoryResult<T>): Promise<T> {
  if (!result.ok) throw mapWorldCampaignTransitionFailure(result.failure);
  return result.value;
}

/** Temporary 14d-owned provider/prompt binding; provider profiles and credentials never cross the port. */
export function createTask14dWorldGenerationCollaborator(
  pool: DatabasePool,
  credentialSecret: string,
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
    resolveEffectiveProviderId,
    createWorldGenerationProgress: createProgress,
    updateWorldGenerationProgress: updateProgress,
    generateTemplateWorld
  };
  const collaborator: WorldGenerationCollaboratorPort = {
    generateWorldPreview: (scope, request) => generateWorldPreviewForOwner(
      pool,
      scope.ownerUserId,
      request,
      credentialSecret,
      providerDependencies
    ),
    generatePlayableCharacterPreview: (scope, request) => generatePlayableCharacterPreviewForOwner(
      pool,
      scope.ownerUserId,
      request,
      credentialSecret
    ),
    generatePlayableCharacter: (scope, request) => generatePlayableCharacterForOwner(
      pool,
      scope.ownerUserId,
      scope.worldId,
      request,
      credentialSecret
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
    credentialSecret: dependencies.credentialSecret,
    embeddings: createChroniclePlatformBindings().embeddings
  });
  const turnPages = createPostgresBoundedCampaignTurnPageAdapter(pool, { turnReportedCosts });
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
    characterOrganizer: createTask14dCharacterProfileOrganizer(pool, dependencies.credentialSecret),
    transfers: createPostgresCampaignTransferRepository({ memory }),
    dashboard: createPostgresDashboardRepository(),
    sessionProfile: createPostgresSessionProfileRepository(),
    worldGeneration: createTask14dWorldGenerationCollaborator(
      pool,
      dependencies.credentialSecret,
      worldAdapters.transaction,
      progress
    ),
    progress
  });
}
