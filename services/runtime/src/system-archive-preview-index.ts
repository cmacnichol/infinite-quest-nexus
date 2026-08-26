import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  canonicalArchiveJson,
  parseSystemCampaignHistoryDetails,
  type ArchiveAssetRecord,
  type SystemArchiveDomain,
  type SystemRecordEnvelope,
} from "../../../packages/contracts/src/index.js";
import { ArchiveError } from "../../api/src/archive-io.js";

type WorldContent = Extract<
  SystemRecordEnvelope,
  { domain: "world-versions" }
>["record"]["content"];

function relationshipFailure(): ArchiveError {
  return new ArchiveError(
    "archive-world-mismatch",
    "System Archive logical relationships are inconsistent.",
  );
}

function jsonFailure(): ArchiveError {
  return new ArchiveError(
    "archive-json-invalid",
    "System Archive contains a duplicate logical record identifier.",
  );
}

const DEFAULT_MAXIMUM_INDEXED_BYTES = 512 * 1024 * 1024;
const CONSERVATIVE_INDEX_ROW_OVERHEAD_BYTES = 256;
const CONSERVATIVE_INDEX_TEXT_MULTIPLIER = 4;

function canonicalValueHash(value: unknown): string {
  return createHash("sha256").update(canonicalArchiveJson(value)).digest("hex");
}

function validateWorldContent(content: WorldContent, assetIds: ReadonlySet<string>): void {
  const entityIds = new Set(content.entities.map((entity) => entity.id));
  const characterIds = new Set(content.playableCharacters.map((character) => character.id));
  for (const relationship of content.relationships) {
    if (!entityIds.has(relationship.fromEntityId) || !entityIds.has(relationship.toEntityId)) {
      throw relationshipFailure();
    }
  }
  if (content.defaults.selectedCharacterId !== null
    && !characterIds.has(content.defaults.selectedCharacterId)) {
    throw relationshipFailure();
  }
  for (const binding of content.assets) {
    if (!assetIds.has(binding.assetId)) throw relationshipFailure();
  }
}

export class SystemArchivePreviewIndex {
  readonly #database: DatabaseSync;
  readonly #maximumRecords: number;
  readonly #maximumRelationships: number;
  readonly #maximumIndexedBytes: number;
  readonly #counts = Object.fromEntries(
    SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]),
  ) as Record<SystemArchiveDomain, number>;
  #recordCount = 0;
  #relationshipCount = 0;
  #indexedBytes = 0;
  #closed = false;

  private constructor(
    database: DatabaseSync,
    maximumRecords: number,
    maximumRelationships: number,
    maximumIndexedBytes: number,
  ) {
    this.#database = database;
    this.#maximumRecords = maximumRecords;
    this.#maximumRelationships = maximumRelationships;
    this.#maximumIndexedBytes = maximumIndexedBytes;
    database.exec(`
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=MEMORY;
      PRAGMA locking_mode=EXCLUSIVE;
      CREATE TABLE records (
        domain TEXT NOT NULL,
        source_id TEXT NOT NULL,
        parent_id TEXT,
        secondary_id TEXT,
        restore_key TEXT,
        numeric_value INTEGER,
        PRIMARY KEY (domain,source_id)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX records_restore_key
        ON records(domain,parent_id,restore_key)
        WHERE restore_key IS NOT NULL;
      CREATE TABLE required_references (
        target_domain TEXT NOT NULL,
        target_id TEXT NOT NULL,
        expected_parent_id TEXT,
        expected_secondary_id TEXT,
        expected_numeric_value INTEGER
      );
      CREATE INDEX required_reference_target
        ON required_references(target_domain,target_id);
      CREATE TABLE actual_world_covers (
        world_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE actual_asset_bindings (
        asset_id TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        PRIMARY KEY (asset_id,binding_hash)
      ) WITHOUT ROWID;
      CREATE TABLE expected_world_version_assets (
        world_id TEXT NOT NULL,
        world_version_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (world_id,world_version_id,asset_id)
      ) WITHOUT ROWID;
      CREATE TABLE actual_world_version_assets (
        world_id TEXT NOT NULL,
        world_version_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (world_id,world_version_id,asset_id)
      ) WITHOUT ROWID;
      CREATE TABLE campaign_profiles (
        campaign_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        profile_hash TEXT
      ) WITHOUT ROWID;
      CREATE TABLE campaign_states (
        campaign_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE character_profile_edits (
        campaign_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        profile_hash TEXT NOT NULL,
        PRIMARY KEY (campaign_id,revision)
      ) WITHOUT ROWID;
      CREATE TABLE campaign_state_edits (
        campaign_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (campaign_id,revision)
      ) WITHOUT ROWID;
      CREATE TABLE world_migrations (
        history_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        from_version_id TEXT NOT NULL,
        to_version_id TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE world_transfers (
        history_id TEXT PRIMARY KEY,
        envelope_campaign_id TEXT NOT NULL,
        source_campaign_id TEXT,
        target_campaign_id TEXT,
        from_version_id TEXT NOT NULL,
        to_version_id TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  }

  static async create(options: Readonly<{
    maximumRecords?: number;
    maximumRelationships?: number;
    maximumIndexedBytes?: number;
  }> = {}): Promise<SystemArchivePreviewIndex> {
    const maximumRecords = options.maximumRecords ?? 2_000_000;
    const maximumRelationships = options.maximumRelationships ?? 2_000_000;
    const maximumIndexedBytes = options.maximumIndexedBytes ?? DEFAULT_MAXIMUM_INDEXED_BYTES;
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
      throw new RangeError("System Archive preview maximumRecords must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maximumRelationships) || maximumRelationships < 1) {
      throw new RangeError("System Archive preview maximumRelationships must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maximumIndexedBytes) || maximumIndexedBytes < 1) {
      throw new RangeError("System Archive preview maximumIndexedBytes must be a positive safe integer.");
    }
    return new SystemArchivePreviewIndex(
      new DatabaseSync(":memory:"),
      maximumRecords,
      maximumRelationships,
      maximumIndexedBytes,
    );
  }

  #insertRetainedValues(
    sql: string,
    values: readonly (string | number | null)[],
    onFailure: () => ArchiveError,
  ): void {
    const retainedTextBytes = values.reduce<number>((total, value) => (
      total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0)
    ), 0);
    const indexedBytes = CONSERVATIVE_INDEX_ROW_OVERHEAD_BYTES
      + retainedTextBytes * CONSERVATIVE_INDEX_TEXT_MULTIPLIER;
    if (indexedBytes > this.#maximumIndexedBytes - this.#indexedBytes) {
      throw new ArchiveError(
        "archive-limit-exceeded",
        "System Archive relationship index exceeds its bounded indexed-byte allowance.",
      );
    }
    try {
      this.#database.prepare(sql).run(...values);
    } catch {
      throw onFailure();
    }
    this.#indexedBytes += indexedBytes;
  }

  #reserveRelationship(): void {
    if (this.#relationshipCount >= this.#maximumRelationships) {
      throw new ArchiveError(
        "archive-limit-exceeded",
        "System Archive relationship index exceeds its bounded relationship allowance.",
      );
    }
    this.#relationshipCount += 1;
  }

  #insertRecord(
    domain: SystemArchiveDomain,
    sourceId: string,
    parentId: string | null = null,
    secondaryId: string | null = null,
    restoreKey: string | null = null,
    numericValue: number | null = null,
  ): void {
    if (this.#recordCount >= this.#maximumRecords) {
      throw new ArchiveError(
        "archive-limit-exceeded",
        "System Archive relationship index exceeds its bounded record allowance.",
      );
    }
    this.#insertRetainedValues(
      "INSERT INTO records (domain,source_id,parent_id,secondary_id,restore_key,numeric_value) VALUES (?,?,?,?,?,?)",
      [domain, sourceId, parentId, secondaryId, restoreKey, numericValue],
      jsonFailure,
    );
    this.#recordCount += 1;
    this.#counts[domain] += 1;
  }

  #require(
    targetDomain: SystemArchiveDomain,
    targetId: string,
    expectedParentId: string | null = null,
    expectedSecondaryId: string | null = null,
    expectedNumericValue: number | null = null,
  ): void {
    this.#reserveRelationship();
    this.#insertRetainedValues(
      `INSERT INTO required_references
         (target_domain,target_id,expected_parent_id,expected_secondary_id,expected_numeric_value)
       VALUES (?,?,?,?,?)`,
      [targetDomain, targetId, expectedParentId, expectedSecondaryId, expectedNumericValue],
      relationshipFailure,
    );
  }

  add(envelope: SystemRecordEnvelope, assetIds: ReadonlySet<string>): void {
    switch (envelope.domain) {
      case "providers":
        this.#insertRecord(envelope.domain, envelope.sourceId, null, envelope.record.kind);
        break;
      case "worlds":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.forkedFromWorldId ?? null,
          envelope.record.forkedFromWorldVersionId ?? null,
        );
        if ((envelope.record.forkedFromWorldId ?? null) !== null
          || (envelope.record.forkedFromWorldVersionId ?? null) !== null) {
          if (!envelope.record.forkedFromWorldId || !envelope.record.forkedFromWorldVersionId) {
            throw relationshipFailure();
          }
          this.#require("worlds", envelope.record.forkedFromWorldId);
          this.#require(
            "world-versions",
            envelope.record.forkedFromWorldVersionId,
            envelope.record.forkedFromWorldId,
          );
        }
        break;
      case "imports":
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.campaignId ?? null);
        if (envelope.record.campaignId) this.#require("campaigns", envelope.record.campaignId);
        break;
      case "prompts":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId ?? "",
          null,
          envelope.record.templateKey,
        );
        if (envelope.record.campaignId !== null) {
          this.#require("campaigns", envelope.record.campaignId);
        }
        break;
      case "world-versions":
        validateWorldContent(envelope.record.content, assetIds);
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.worldId,
          null,
          String(envelope.record.versionNumber),
        );
        for (const binding of envelope.record.content.assets) {
          this.#reserveRelationship();
          this.#insertRetainedValues(
            `
              INSERT INTO expected_world_version_assets
                (world_id,world_version_id,asset_id) VALUES (?,?,?)
            `,
            [envelope.record.worldId, envelope.sourceId, binding.assetId],
            relationshipFailure,
          );
        }
        this.#require("worlds", envelope.record.worldId);
        break;
      case "world-drafts":
        validateWorldContent(envelope.record.content, assetIds);
        if (envelope.sourceId !== envelope.record.worldId) throw relationshipFailure();
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.worldId,
          envelope.record.basedOnWorldVersionId,
          envelope.record.worldId,
        );
        this.#require("worlds", envelope.record.worldId);
        if (envelope.record.basedOnWorldVersionId !== null) {
          this.#require("world-versions", envelope.record.basedOnWorldVersionId, envelope.record.worldId);
        }
        break;
      case "campaigns":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.worldVersionId,
          null,
          null,
          envelope.record.activeTurnNumber,
        );
        this.#require("world-versions", envelope.record.worldVersionId);
        if (envelope.record.selectedCharacterId !== null) {
          if (envelope.record.characterSnapshot?.id !== envelope.record.selectedCharacterId) {
            throw relationshipFailure();
          }
        } else if (envelope.record.characterSnapshot !== null
          || envelope.record.characterProfile !== null
          || envelope.record.characterProfileRevision !== 0) {
          throw relationshipFailure();
        }
        this.#reserveRelationship();
        this.#insertRetainedValues(
          "INSERT INTO campaign_profiles (campaign_id,revision,profile_hash) VALUES (?,?,?)",
          [
            envelope.sourceId,
            envelope.record.characterProfileRevision,
            envelope.record.characterProfile === null
              ? null : canonicalValueHash(envelope.record.characterProfile),
          ],
          relationshipFailure,
        );
        break;
      case "turns":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId,
          null,
          String(envelope.record.turnNumber),
          envelope.record.turnNumber,
        );
        this.#require("campaigns", envelope.record.campaignId);
        break;
      case "turn-corrections":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.turnId,
          null,
          String(envelope.record.revision),
        );
        this.#require("turns", envelope.record.turnId);
        break;
      case "campaign-state":
        if (envelope.sourceId !== envelope.record.campaignId) throw relationshipFailure();
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.campaignId);
        this.#reserveRelationship();
        this.#insertRetainedValues(
          "INSERT INTO campaign_states (campaign_id,revision) VALUES (?,?)",
          [
            envelope.record.campaignId,
            envelope.record.revision,
          ],
          relationshipFailure,
        );
        this.#require("campaigns", envelope.record.campaignId);
        break;
      case "campaign-history": {
        let history;
        try {
          history = parseSystemCampaignHistoryDetails(envelope.record.eventType, envelope.record.content);
        } catch {
          throw relationshipFailure();
        }
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId,
          envelope.record.eventType,
          null,
          history.eventType === "campaign-state-edit"
            ? history.details.effectiveTurnNumber
            : history.eventType === "character-profile-edit" ? history.details.revision : null,
        );
        this.#require("campaigns", envelope.record.campaignId);
        switch (history.eventType) {
          case "world-migration":
            if (history.details.fromWorldVersionId === history.details.toWorldVersionId) {
              throw relationshipFailure();
            }
            this.#require("world-versions", history.details.fromWorldVersionId);
            this.#require("world-versions", history.details.toWorldVersionId);
            this.#reserveRelationship();
            this.#insertRetainedValues(
              `INSERT INTO world_migrations
                 (history_id,campaign_id,from_version_id,to_version_id) VALUES (?,?,?,?)`,
              [
                envelope.sourceId,
                envelope.record.campaignId,
                history.details.fromWorldVersionId,
                history.details.toWorldVersionId,
              ],
              relationshipFailure,
            );
            break;
          case "world-transfer": {
            const sourceCampaignId = history.details.sourceCampaignId;
            const targetCampaignId = history.details.targetCampaignId;
            const envelopeCampaignId = targetCampaignId ?? sourceCampaignId;
            if (envelopeCampaignId === null
              || envelope.record.campaignId !== envelopeCampaignId
              || history.details.fromWorldVersionId === history.details.toWorldVersionId
              || (sourceCampaignId !== null && sourceCampaignId === targetCampaignId)) {
              throw relationshipFailure();
            }
            if (sourceCampaignId) {
              this.#require("campaigns", sourceCampaignId);
            }
            if (targetCampaignId) {
              this.#require("campaigns", targetCampaignId);
            }
            this.#require("world-versions", history.details.fromWorldVersionId);
            this.#require("world-versions", history.details.toWorldVersionId);
            this.#reserveRelationship();
            this.#insertRetainedValues(
              `INSERT INTO world_transfers (
                 history_id,envelope_campaign_id,source_campaign_id,target_campaign_id,
                 from_version_id,to_version_id
               ) VALUES (?,?,?,?,?,?)`,
              [
                envelope.sourceId,
                envelope.record.campaignId,
                sourceCampaignId,
                targetCampaignId,
                history.details.fromWorldVersionId,
                history.details.toWorldVersionId,
              ],
              relationshipFailure,
            );
            break;
          }
          case "memory-config":
            if (history.details.embeddingProviderProfileId !== null) {
              this.#require("providers", history.details.embeddingProviderProfileId, null, "embedding");
            }
            break;
          case "illustration-config":
            if (history.details.providerProfileId !== null) {
              this.#require("providers", history.details.providerProfileId, null, "image");
            }
            break;
          case "accepted-turn-mode":
          case "illustration-set":
            this.#require("turns", history.details.turnId, envelope.record.campaignId);
            break;
          case "illustration-segment":
            this.#require("turns", history.details.turnId, envelope.record.campaignId);
            this.#require(
              "campaign-history",
              history.details.illustrationSetId,
              envelope.record.campaignId,
              "illustration-set",
            );
            break;
          case "character-profile-edit":
            this.#reserveRelationship();
            this.#insertRetainedValues(
              `INSERT INTO character_profile_edits
                 (campaign_id,revision,profile_hash) VALUES (?,?,?)`,
              [
                envelope.record.campaignId,
                history.details.revision,
                canonicalValueHash(history.details.nextProfile),
              ],
              relationshipFailure,
            );
            break;
          case "campaign-state-edit":
            this.#reserveRelationship();
            this.#insertRetainedValues(
              "INSERT INTO campaign_state_edits (campaign_id,revision) VALUES (?,?)",
              [
                envelope.record.campaignId,
                history.details.revision,
              ],
              relationshipFailure,
            );
            break;
        }
        break;
      }
      case "canonical-facts":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId,
          envelope.record.worldVersionId,
          null,
          envelope.record.sourceTurnNumber,
        );
        this.#require("campaigns", envelope.record.campaignId);
        this.#require("world-versions", envelope.record.worldVersionId);
        if (envelope.record.sourceTurnId !== null) {
          this.#require(
            "turns",
            envelope.record.sourceTurnId,
            envelope.record.campaignId,
            null,
            envelope.record.sourceTurnNumber,
          );
        }
        if (envelope.record.sourceStateEditId !== null) {
          this.#require(
            "campaign-history",
            envelope.record.sourceStateEditId,
            envelope.record.campaignId,
            "campaign-state-edit",
            envelope.record.sourceTurnNumber,
          );
        }
        if (envelope.record.supersededByFactId !== null) {
          this.#require("canonical-facts", envelope.record.supersededByFactId, envelope.record.campaignId);
        }
        break;
      case "chronicle":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId,
          envelope.record.kind === "memory" ? envelope.record.turnId : null,
          envelope.record.kind === "memory"
            ? `${envelope.record.turnId ?? ""}:${envelope.record.memoryKind}`
            : null,
          envelope.record.kind === "summary-checkpoint" ? envelope.record.throughTurn : null,
        );
        this.#require("campaigns", envelope.record.campaignId);
        if (envelope.record.kind === "memory" && envelope.record.turnId !== null) {
          this.#require("turns", envelope.record.turnId, envelope.record.campaignId);
        }
        break;
      case "illustrations":
        if (!assetIds.has(envelope.record.assetId)) throw relationshipFailure();
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId,
          envelope.record.turnId,
        );
        this.#require("campaigns", envelope.record.campaignId);
        if (envelope.record.turnId !== null) {
          this.#require("turns", envelope.record.turnId, envelope.record.campaignId);
        }
        break;
      case "cost-events":
      case "activity-events":
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.campaignId);
        if (envelope.record.campaignId !== null) {
          this.#require("campaigns", envelope.record.campaignId);
        }
        break;
    }
  }

  #recordExists(domain: SystemArchiveDomain, sourceId: string): boolean {
    return this.#database.prepare(
      "SELECT 1 AS present FROM records WHERE domain=? AND source_id=?",
    ).get(domain, sourceId) !== undefined;
  }

  #parentMatches(domain: SystemArchiveDomain, sourceId: string, parentId: string): boolean {
    return this.#database.prepare(
      "SELECT 1 AS present FROM records WHERE domain=? AND source_id=? AND parent_id=?",
    ).get(domain, sourceId, parentId) !== undefined;
  }

  #campaignBelongsToWorld(campaignId: string, worldId: string): boolean {
    return this.#database.prepare(`
      SELECT 1 AS present
        FROM records campaign
        JOIN records version
          ON version.domain='world-versions'
         AND version.source_id=campaign.parent_id
       WHERE campaign.domain='campaigns'
         AND campaign.source_id=?
         AND version.parent_id=?
    `).get(campaignId, worldId) !== undefined;
  }

  validate(assets: readonly ArchiveAssetRecord[]): void {
    const brokenReference = this.#database.prepare(`
      SELECT 1 AS broken
        FROM required_references reference
        LEFT JOIN records target
          ON target.domain=reference.target_domain
         AND target.source_id=reference.target_id
       WHERE target.source_id IS NULL
          OR (reference.expected_parent_id IS NOT NULL
              AND target.parent_id IS NOT reference.expected_parent_id)
          OR (reference.expected_secondary_id IS NOT NULL
              AND target.secondary_id IS NOT reference.expected_secondary_id)
          OR (reference.expected_numeric_value IS NOT NULL
              AND target.numeric_value IS NOT reference.expected_numeric_value)
       LIMIT 1
    `).get();
    if (brokenReference !== undefined) throw relationshipFailure();

    const checkpointBeyondCampaign = this.#database.prepare(`
      SELECT 1 AS broken
        FROM records checkpoint
        JOIN records campaign
          ON campaign.domain='campaigns'
         AND campaign.source_id=checkpoint.parent_id
       WHERE checkpoint.domain='chronicle'
         AND checkpoint.numeric_value IS NOT NULL
         AND checkpoint.numeric_value>campaign.numeric_value
       LIMIT 1
    `).get();
    if (checkpointBeyondCampaign !== undefined) throw relationshipFailure();

    const currentProfileMismatch = this.#database.prepare(`
      SELECT 1 AS broken
        FROM campaign_profiles current
        LEFT JOIN character_profile_edits edit
          ON edit.campaign_id=current.campaign_id
         AND edit.revision=current.revision
         AND edit.profile_hash=current.profile_hash
       WHERE (current.revision=0 AND EXISTS (
                SELECT 1 FROM character_profile_edits declared
                 WHERE declared.campaign_id=current.campaign_id
             ))
          OR (current.revision>0 AND edit.campaign_id IS NULL)
          OR EXISTS (
               SELECT 1 FROM character_profile_edits newer
                WHERE newer.campaign_id=current.campaign_id
                  AND newer.revision>current.revision
             )
       LIMIT 1
    `).get();
    if (currentProfileMismatch !== undefined) throw relationshipFailure();

    const currentStateBehindHistory = this.#database.prepare(`
      SELECT 1 AS broken
        FROM campaign_states current
       WHERE EXISTS (
               SELECT 1 FROM campaign_state_edits newer
                WHERE newer.campaign_id=current.campaign_id
                  AND newer.revision>current.revision
             )
       LIMIT 1
    `).get();
    if (currentStateBehindHistory !== undefined) throw relationshipFailure();

    const crossWorldMigration = this.#database.prepare(`
      SELECT 1 AS broken
        FROM world_migrations migration
        JOIN records campaign
          ON campaign.domain='campaigns' AND campaign.source_id=migration.campaign_id
        JOIN records campaign_version
          ON campaign_version.domain='world-versions'
         AND campaign_version.source_id=campaign.parent_id
        JOIN records source
          ON source.domain='world-versions' AND source.source_id=migration.from_version_id
        JOIN records target
          ON target.domain='world-versions' AND target.source_id=migration.to_version_id
       WHERE migration.from_version_id=migration.to_version_id
          OR source.parent_id IS NOT target.parent_id
          OR campaign_version.parent_id IS NOT source.parent_id
       LIMIT 1
    `).get();
    if (crossWorldMigration !== undefined) throw relationshipFailure();

    const crossWiredTransfer = this.#database.prepare(`
      SELECT 1 AS broken
        FROM world_transfers transfer
        JOIN records source_version
          ON source_version.domain='world-versions'
         AND source_version.source_id=transfer.from_version_id
        JOIN records target_version
          ON target_version.domain='world-versions'
         AND target_version.source_id=transfer.to_version_id
       WHERE transfer.from_version_id=transfer.to_version_id
          OR (transfer.source_campaign_id IS NOT NULL
              AND transfer.source_campaign_id=transfer.target_campaign_id)
          OR transfer.envelope_campaign_id IS NOT COALESCE(
               transfer.target_campaign_id,
               transfer.source_campaign_id
             )
          OR (transfer.source_campaign_id IS NOT NULL AND NOT EXISTS (
               SELECT 1
                 FROM records source_campaign
                 JOIN records source_campaign_version
                   ON source_campaign_version.domain='world-versions'
                  AND source_campaign_version.source_id=source_campaign.parent_id
                WHERE source_campaign.domain='campaigns'
                  AND source_campaign.source_id=transfer.source_campaign_id
                  AND source_campaign_version.parent_id=source_version.parent_id
             ))
          OR (transfer.target_campaign_id IS NOT NULL AND NOT EXISTS (
               SELECT 1
                 FROM records target_campaign
                 JOIN records target_campaign_version
                   ON target_campaign_version.domain='world-versions'
                  AND target_campaign_version.source_id=target_campaign.parent_id
                WHERE target_campaign.domain='campaigns'
                  AND target_campaign.source_id=transfer.target_campaign_id
                  AND target_campaign_version.parent_id=target_version.parent_id
             ))
       LIMIT 1
    `).get();
    if (crossWiredTransfer !== undefined) throw relationshipFailure();

    for (const asset of assets) {
      for (const binding of asset.bindings) {
        this.#reserveRelationship();
        this.#insertRetainedValues(
          "INSERT INTO actual_asset_bindings (asset_id,binding_hash) VALUES (?,?)",
          [asset.sourceAssetId, canonicalValueHash(binding)],
          relationshipFailure,
        );
        switch (binding.role) {
          case "world_cover":
            if (!this.#recordExists("worlds", binding.worldId)) throw relationshipFailure();
            this.#reserveRelationship();
            this.#insertRetainedValues(
              "INSERT INTO actual_world_covers (world_id,asset_id) VALUES (?,?)",
              [binding.worldId, asset.sourceAssetId],
              relationshipFailure,
            );
            break;
          case "world_version_asset":
            if (!this.#recordExists("worlds", binding.worldId)
              || !this.#parentMatches("world-versions", binding.worldVersionId, binding.worldId)) {
              throw relationshipFailure();
            }
            this.#reserveRelationship();
            this.#insertRetainedValues(`
              INSERT INTO actual_world_version_assets
                (world_id,world_version_id,asset_id) VALUES (?,?,?)
            `, [binding.worldId, binding.worldVersionId, asset.sourceAssetId], relationshipFailure);
            break;
          case "campaign_asset":
            if (!this.#recordExists("campaigns", binding.campaignId)) throw relationshipFailure();
            break;
          case "turn_illustration":
          case "illustration_segment_variant":
            if (!this.#parentMatches("turns", binding.turnId, binding.campaignId)) {
              throw relationshipFailure();
            }
            break;
          case "imported_attachment":
            if (!this.#recordExists("campaigns", binding.campaignId)
              || (binding.turnId !== null
                && !this.#parentMatches("turns", binding.turnId, binding.campaignId))) {
              throw relationshipFailure();
            }
            break;
          case "generation_context": {
            const campaignValid = binding.campaignId === null
              || this.#recordExists("campaigns", binding.campaignId);
            const worldValid = binding.worldId === null
              || this.#recordExists("worlds", binding.worldId);
            const turnValid = binding.turnId === null
              || (binding.campaignId !== null
                && this.#parentMatches("turns", binding.turnId, binding.campaignId));
            const versionValid = binding.worldVersionId === null
              || (binding.worldId !== null
                && this.#parentMatches("world-versions", binding.worldVersionId, binding.worldId));
            const campaignVersionValid = binding.campaignId === null
              || binding.worldVersionId === null
              || this.#parentMatches("campaigns", binding.campaignId, binding.worldVersionId);
            const campaignWorldValid = binding.campaignId === null
              || binding.worldId === null
              || this.#campaignBelongsToWorld(binding.campaignId, binding.worldId);
            if (!campaignValid || !worldValid || !turnValid || !versionValid
              || !campaignVersionValid || !campaignWorldValid) {
              throw relationshipFailure();
            }
            break;
          }
        }
      }
    }
    const unmatchedVersionAsset = this.#database.prepare(`
      SELECT 1 AS broken FROM (
        SELECT world_id,world_version_id,asset_id FROM expected_world_version_assets
        EXCEPT
        SELECT world_id,world_version_id,asset_id FROM actual_world_version_assets
      ) missing
      UNION ALL
      SELECT 1 AS broken FROM (
        SELECT world_id,world_version_id,asset_id FROM actual_world_version_assets
        EXCEPT
        SELECT world_id,world_version_id,asset_id FROM expected_world_version_assets
      ) unexpected
      LIMIT 1
    `).get();
    if (unmatchedVersionAsset !== undefined) throw relationshipFailure();
  }

  counts(): Readonly<Record<SystemArchiveDomain, number>> {
    return Object.freeze({ ...this.#counts });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}
