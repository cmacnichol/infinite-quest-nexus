import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SYSTEM_ARCHIVE_DOMAINS,
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
  readonly #directory: string;
  readonly #counts = Object.fromEntries(
    SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]),
  ) as Record<SystemArchiveDomain, number>;
  #closed = false;

  private constructor(database: DatabaseSync, directory: string) {
    this.#database = database;
    this.#directory = directory;
    database.exec(`
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      PRAGMA locking_mode=EXCLUSIVE;
      CREATE TABLE records (
        domain TEXT NOT NULL,
        source_id TEXT NOT NULL,
        parent_id TEXT,
        secondary_id TEXT,
        restore_key TEXT,
        PRIMARY KEY (domain,source_id)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX records_restore_key
        ON records(domain,parent_id,restore_key)
        WHERE restore_key IS NOT NULL;
      CREATE TABLE required_references (
        target_domain TEXT NOT NULL,
        target_id TEXT NOT NULL,
        expected_parent_id TEXT
      );
      CREATE INDEX required_reference_target
        ON required_references(target_domain,target_id);
    `);
  }

  static async create(): Promise<SystemArchivePreviewIndex> {
    const directory = await mkdtemp(join(tmpdir(), "infinitequest-system-preview-index-"));
    await chmod(directory, 0o700);
    const path = join(directory, "relationships.sqlite");
    try {
      const database = new DatabaseSync(path);
      await chmod(path, 0o600);
      return new SystemArchivePreviewIndex(database, directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  #insertRecord(
    domain: SystemArchiveDomain,
    sourceId: string,
    parentId: string | null = null,
    secondaryId: string | null = null,
    restoreKey: string | null = null,
  ): void {
    try {
      this.#database.prepare(
        "INSERT INTO records (domain,source_id,parent_id,secondary_id,restore_key) VALUES (?,?,?,?,?)",
      ).run(domain, sourceId, parentId, secondaryId, restoreKey);
    } catch {
      throw jsonFailure();
    }
    this.#counts[domain] += 1;
  }

  #require(targetDomain: SystemArchiveDomain, targetId: string, expectedParentId: string | null = null): void {
    this.#database.prepare(
      "INSERT INTO required_references (target_domain,target_id,expected_parent_id) VALUES (?,?,?)",
    ).run(targetDomain, targetId, expectedParentId);
  }

  add(envelope: SystemRecordEnvelope, assetIds: ReadonlySet<string>): void {
    switch (envelope.domain) {
      case "providers":
      case "prompts":
      case "worlds":
      case "imports":
        this.#insertRecord(envelope.domain, envelope.sourceId);
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
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.worldVersionId);
        this.#require("world-versions", envelope.record.worldVersionId);
        break;
      case "turns":
        this.#insertRecord(
          envelope.domain,
          envelope.sourceId,
          envelope.record.campaignId,
          null,
          String(envelope.record.turnNumber),
        );
        this.#require("campaigns", envelope.record.campaignId);
        break;
      case "turn-corrections":
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.turnId);
        this.#require("turns", envelope.record.turnId);
        break;
      case "campaign-state":
        if (envelope.sourceId !== envelope.record.campaignId) throw relationshipFailure();
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.campaignId);
        this.#require("campaigns", envelope.record.campaignId);
        break;
      case "campaign-history":
      case "canonical-facts":
      case "chronicle":
        this.#insertRecord(envelope.domain, envelope.sourceId, envelope.record.campaignId);
        this.#require("campaigns", envelope.record.campaignId);
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
       LIMIT 1
    `).get();
    if (brokenReference !== undefined) throw relationshipFailure();

    for (const asset of assets) {
      for (const binding of asset.bindings) {
        switch (binding.role) {
          case "world_cover":
            if (!this.#recordExists("worlds", binding.worldId)) throw relationshipFailure();
            break;
          case "world_version_asset":
            if (!this.#recordExists("worlds", binding.worldId)
              || !this.#parentMatches("world-versions", binding.worldVersionId, binding.worldId)) {
              throw relationshipFailure();
            }
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
  }

  counts(): Readonly<Record<SystemArchiveDomain, number>> {
    return Object.freeze({ ...this.#counts });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
    await rm(this.#directory, { recursive: true, force: true });
  }
}
