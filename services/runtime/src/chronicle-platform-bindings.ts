import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { callEmbeddingProvider, logProviderTransportError, type TextProviderProfile } from "../../../packages/story-engine/src/index.js";
import { recordProfileCost } from "./provider-cost-adapter.js";
import { loadEmbeddingProvider, recordProviderHealth } from "./provider-runtime-adapter.js";
import {
  createChronicleEmbeddingProviderPort,
  type ChronicleEmbeddingProvider,
  type ChronicleEmbeddingProviderPort,
  type ChronicleEmbeddingProviderSelectionScope
} from "./chronicle-platform-adapter.js";

type EnabledProfileRow = Readonly<{ id: string; is_default: boolean }>;

/**
 * Dedicated embedding profiles
 * are authoritative whenever any are enabled. Text is considered only when
 * that dedicated inventory is empty; image roles are never queried.
 */
export async function resolveChronicleEmbeddingProviderId(
  database: DatabaseClient | DatabasePool,
  scope: ChronicleEmbeddingProviderSelectionScope,
): Promise<string | null> {
  const embedding = await database.query<EnabledProfileRow>(
    `SELECT id, is_default FROM provider_profiles
      WHERE owner_user_id = $1 AND provider_role = 'embedding' AND enabled = true
      ORDER BY is_default DESC, name, id`,
    [scope.ownerUserId]
  );
  if (embedding.rows.length) {
    const selected = embedding.rows.find((profile) => profile.id === scope.selectedProviderProfileId);
    if (selected) return selected.id;
    if (embedding.rows.length === 1 || embedding.rows[0]?.is_default) return embedding.rows[0]!.id;
    return null;
  }
  if (scope.selectedProviderProfileId) {
    const selectedText = await database.query<{ id: string }>(
      `SELECT id FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'text' AND enabled = true`,
      [scope.selectedProviderProfileId, scope.ownerUserId]
    );
    if (selectedText.rows[0]) return selectedText.rows[0].id;
  }
  const campaign = await database.query<{ text_provider_profile_id: string | null }>(
    `SELECT text_provider_profile_id FROM campaigns
      WHERE id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  const campaignTextId = campaign.rows[0]?.text_provider_profile_id;
  if (campaignTextId) {
    const campaignText = await database.query<{ id: string }>(
      `SELECT id FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'text' AND enabled = true`,
      [campaignTextId, scope.ownerUserId]
    );
    if (campaignText.rows[0]) return campaignText.rows[0].id;
  }
  const text = await database.query<EnabledProfileRow>(
    `SELECT id, is_default FROM provider_profiles
      WHERE owner_user_id = $1 AND provider_role = 'text' AND enabled = true
      ORDER BY is_default DESC, name, id`,
    [scope.ownerUserId]
  );
  if (text.rows.length === 1 || text.rows[0]?.is_default) return text.rows[0]?.id ?? null;
  return null;
}

/**
 * Runtime owns this narrow bridge while Task 14d extracts provider profiles,
 * decrypted credentials, health, and cost attribution. It deliberately binds
 * only the embedding/text-fallback loader; image profiles never enter it.
 */
export function createChroniclePlatformBindings(
): Readonly<{ embeddings: ChronicleEmbeddingProviderPort }> {
  return {
    embeddings: createChronicleEmbeddingProviderPort({
      loadEmbeddingProvider: (database, ownerUserId, providerProfileId, credentialSecret, model) =>
        loadEmbeddingProvider(
          database as DatabasePool,
          ownerUserId,
          providerProfileId,
          credentialSecret,
          model
        ),
      resolveEmbeddingProviderId: (database, ownerUserId, campaignId, selectedProviderProfileId) =>
        resolveChronicleEmbeddingProviderId(database as DatabaseClient | DatabasePool, {
          ownerUserId,
          campaignId,
          ...(selectedProviderProfileId === undefined ? {} : { selectedProviderProfileId })
        }),
      callEmbeddingProvider: async (provider, documents) => callEmbeddingProvider(
        provider as ChronicleEmbeddingProvider & TextProviderProfile,
        [...documents],
      ),
      recordProviderHealth: (database, ownerUserId, providerProfileId, healthy, errorMessage) =>
        recordProviderHealth(
          database as DatabasePool,
          ownerUserId,
          providerProfileId,
          healthy,
          errorMessage
        ),
      recordProfileCost: (database, provider, attribution, result) => recordProfileCost(
        database as never,
        provider as ChronicleEmbeddingProvider & TextProviderProfile & { id: string },
        { ...attribution, category: "memory" },
        result,
      ),
      logProviderTransportError
    })
  };
}
