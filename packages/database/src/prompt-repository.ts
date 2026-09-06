import { createHash } from "node:crypto";
import {
  buildPromptPreview,
  PROMPT_TEMPLATE_CATALOG,
  promptCompatibilityRequirement,
  promptTemplateOverrideSchema,
  sampleValuesForPrompt,
  type PromptSnapshot,
  type PromptTemplateKey
} from "../../contracts/src/prompt-library.js";
import {
  STORY_PROMPT_PROTOCOL_VERSION,
  storyPromptProtocolIdentity
} from "../../contracts/src/story-prompt.js";
import type {
  PromptLibraryPort,
  PromptScope,
  PromptSnapshotVersion
} from "../../application/src/providers/index.js";
import {
  buildEventExtensionPrompt,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildSceneCoveragePrompt,
  buildStoryUserPrompt,
  buildTurnIntentPrompt
} from "../../story-engine/src/index.js";
import type { DatabaseClient } from "./pool.js";

const CATALOG_VERSION = "prompt-library-v1";
const RUNTIME_KEYS: readonly PromptTemplateKey[] = [
  "story_system", "story_recovery_output_limit", "story_recovery_mechanics", "story_recovery_schema",
  "rpg_assessment", "event_trigger", "event_extension", "turn_intent", "scene_coverage", "scene_coverage_rewrite"
];

type OverrideRow = {
  prompt_key: PromptTemplateKey;
  content: string;
  campaign_id: string | null;
  compatibility_required_shape_version: string | null;
  compatibility_protocol_identity: string | null;
  compatibility_content_hash: string | null;
};

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertCampaignOwner(database: DatabaseClient, ownerUserId: string, campaignId: string) {
  const result = await database.query(
    "SELECT 1 FROM campaigns WHERE id=$1 AND owner_user_id=$2",
    [campaignId, ownerUserId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
}

async function invalidateModelChains(database: DatabaseClient, scope: PromptScope, key: PromptTemplateKey) {
  if (!RUNTIME_KEYS.includes(key)) return;
  await database.query(
    `UPDATE model_chains
        SET active=false,updated_at=now()
      WHERE owner_user_id=$1 AND active
        AND ($2::uuid IS NULL OR campaign_id=$2)`,
    [scope.ownerUserId, scope.scope === "campaign" ? scope.campaignId : null]
  );
}

async function resolveSnapshot(database: DatabaseClient, scope: PromptScope, enforceCompatibility = true): Promise<PromptSnapshot> {
  const campaignId = scope.scope === "campaign" ? scope.campaignId : null;
  if (campaignId) await assertCampaignOwner(database, scope.ownerUserId, campaignId);
  const result = await database.query<OverrideRow>(
    `SELECT prompt_key,content,campaign_id,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash FROM prompt_template_overrides
      WHERE owner_user_id=$1 AND (campaign_id IS NULL OR campaign_id=$2)
      ORDER BY campaign_id NULLS FIRST,prompt_key`,
    [scope.ownerUserId, campaignId]
  );
  const application = new Map<PromptTemplateKey, OverrideRow>();
  const campaign = new Map<PromptTemplateKey, OverrideRow>();
  for (const row of result.rows) {
    const requirement = promptCompatibilityRequirement(row.prompt_key);
    if (enforceCompatibility && requirement && (row.compatibility_required_shape_version !== requirement.requiredShapeVersion
      || row.compatibility_protocol_identity !== requirement.protocolIdentity
      || row.compatibility_content_hash !== hash(row.content))) {
      throw Object.assign(new Error("A saved prompt override must be acknowledged for the current required output shape before generation can run."), {
        statusCode: 409,
        code: "prompt_override_incompatible"
      });
    }
    (row.campaign_id ? campaign : application).set(row.prompt_key, row);
  }
  return Object.fromEntries(Object.values(PROMPT_TEMPLATE_CATALOG).map((definition) => {
    const content = campaign.get(definition.key)?.content ?? application.get(definition.key)?.content ?? definition.defaultContent;
    const source = campaign.has(definition.key) ? "campaign" : application.has(definition.key) ? "application" : "shipped";
    return [definition.key, { content, hash: hash(content), source }];
  })) as PromptSnapshot;
}

function protocolVersion(snapshot: PromptSnapshot): string {
  const templateHashes = Object.fromEntries(RUNTIME_KEYS.map((key) => [key, snapshot[key].hash]));
  return `${STORY_PROMPT_PROTOCOL_VERSION}-${hash(storyPromptProtocolIdentity(templateHashes)).slice(0, 16)}`;
}

function establishedPromptPreview(key: PromptTemplateKey, content: string) {
  const preview = buildPromptPreview(key, content);
  const context = {
    authoritativeRules: ["Moonlit gates open only for a spoken promise."],
    campaignState: { location: "Rainbridge", openThreads: ["Who sealed the eastern gate?"] }
  };
  let structuredInput = "";
  if (key.startsWith("story_")) structuredInput = buildStoryUserPrompt(context, "Mira raises the lantern and promises to return.");
  else if (key === "rpg_assessment") structuredInput = buildRpgAssessmentPrompt(context, "Mira attempts to open the sealed gate.", [{ id: "resolve", name: "Resolve", value: 63, note: "Courage under pressure." }]);
  else if (key === "event_trigger") structuredInput = buildEventTriggerPrompt("after", context, "Mira opens the gate.", 7, [{ id: "gate-opened", label: "The eastern gate opens", timing: "after", condition: "The eastern gate is opened.", effect: "Blue light floods the bridge.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }]);
  else if (key === "event_extension") structuredInput = buildEventExtensionPrompt({
    narration: "The gate opens beneath Mira's lantern.", choices: ["Cross", "Wait", "Call", "Return"], custom_action_suggestion: "Study the blue light.",
    scratchpad: "Mira opened the gate.", tracker_updates: [], image_prompt: "A lantern at an open gate", continuity_summary: "Mira stands at the opened gate.",
    canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: []
  }, ["Blue light floods the rain-swept bridge."]);
  else if (key === "turn_intent") structuredInput = buildTurnIntentPrompt("Mira opens the gate and calls for the ferryman.");
  else if (key === "scene_coverage" || key === "scene_coverage_rewrite") structuredInput = buildSceneCoveragePrompt("Mira opens the gate.", "Mira presses her palm to the blue glass, and the gate opens.");
  if (structuredInput) {
    const inputSection = preview.sections.find((section) => section.role === "input");
    if (inputSection) inputSection.content = structuredInput;
    preview.estimatedTokens = Math.max(1, Math.ceil(preview.sections.reduce((total, section) => total + section.content.length, 0) / 4));
  }
  return preview;
}

export function createPromptRepository(database: DatabaseClient): PromptLibraryPort {
  async function loadPromptSnapshot(scope: PromptScope): Promise<PromptSnapshotVersion> {
    const snapshot = await resolveSnapshot(database, scope);
    return { catalogVersion: CATALOG_VERSION, protocolVersion: protocolVersion(snapshot), snapshot };
  }

  async function listPromptLibrary(scope: PromptScope) {
    const snapshot = await resolveSnapshot(database, scope, false);
    const campaignId = scope.scope === "campaign" ? scope.campaignId : null;
    const overrides = await database.query<OverrideRow>(
      `SELECT prompt_key,content,campaign_id,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash FROM prompt_template_overrides
        WHERE owner_user_id=$1 AND (campaign_id IS NULL OR campaign_id=$2)
        ORDER BY campaign_id NULLS FIRST,prompt_key`,
      [scope.ownerUserId, campaignId]
    );
    const acknowledgement = new Map<PromptTemplateKey, OverrideRow>();
    for (const row of overrides.rows) acknowledgement.set(row.prompt_key, row);
    return {
      catalogVersion: CATALOG_VERSION,
      campaignId: scope.scope === "campaign" ? scope.campaignId : null,
      templates: Object.values(PROMPT_TEMPLATE_CATALOG).map((definition) => ({
        key: definition.key,
        title: definition.title,
        category: definition.category,
        description: definition.description,
        campaignOverrideAllowed: definition.campaignOverrideAllowed,
        maxLength: definition.maxLength,
        variables: definition.variables,
        sampleValues: sampleValuesForPrompt(definition.key),
        defaultContent: definition.defaultContent,
        effectiveContent: snapshot[definition.key].content,
        effectiveSource: snapshot[definition.key].source,
        contentHash: snapshot[definition.key].hash,
        compatibility: (() => {
          const requirement = promptCompatibilityRequirement(definition.key);
          if (!requirement) return null;
          return {
            ...requirement,
            acknowledged: snapshot[definition.key].source === "shipped" || (() => {
              const override = acknowledgement.get(definition.key);
              return override?.compatibility_required_shape_version === requirement.requiredShapeVersion
                && override.compatibility_protocol_identity === requirement.protocolIdentity
                && override.compatibility_content_hash === snapshot[definition.key].hash;
            })()
          };
        })()
      }))
    };
  }

  return {
    listPromptLibrary,
    async previewPrompt(request) {
      const value = promptTemplateOverrideSchema.parse({
        key: request.key,
        content: request.content,
        scope: "application"
      });
      return establishedPromptPreview(value.key, value.content);
    },
    async savePromptOverride(command) {
      const campaignId = command.scope === "campaign" ? command.campaignId : null;
      const value = promptTemplateOverrideSchema.parse({
        key: command.key,
        content: command.content,
        scope: command.scope,
        ...(campaignId ? { campaignId } : {}),
        ...(command.compatibilityAcknowledgement === undefined ? {} : { compatibilityAcknowledgement: command.compatibilityAcknowledgement })
      });
      const requirement = promptCompatibilityRequirement(value.key);
      if (requirement && (value.compatibilityAcknowledgement?.requiredShapeVersion !== requirement.requiredShapeVersion
        || value.compatibilityAcknowledgement.protocolIdentity !== requirement.protocolIdentity
        || value.compatibilityAcknowledgement.contentHash !== hash(value.content))) {
        throw Object.assign(new Error("Acknowledge the current required output shape for this exact prompt text before saving."), {
          statusCode: 409,
          code: "prompt_override_incompatible"
        });
      }
      if (campaignId) await assertCampaignOwner(database, command.ownerUserId, campaignId);
      await database.query(
        `INSERT INTO prompt_template_overrides(owner_user_id,campaign_id,prompt_key,content,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash,compatibility_acknowledged_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5 IS NULL THEN NULL ELSE now() END,now())
         ON CONFLICT(owner_user_id,campaign_id,prompt_key)
         DO UPDATE SET content=excluded.content,compatibility_required_shape_version=excluded.compatibility_required_shape_version,compatibility_protocol_identity=excluded.compatibility_protocol_identity,compatibility_content_hash=excluded.compatibility_content_hash,compatibility_acknowledged_at=excluded.compatibility_acknowledged_at,updated_at=now()`,
        [command.ownerUserId, campaignId, value.key, value.content,
          requirement?.requiredShapeVersion ?? null, value.compatibilityAcknowledgement?.protocolIdentity ?? null, value.compatibilityAcknowledgement?.contentHash ?? null]
      );
      await invalidateModelChains(database, command, value.key);
      return listPromptLibrary(command);
    },
    async resetPromptOverride(command) {
      const campaignId = command.scope === "campaign" ? command.campaignId : null;
      promptTemplateOverrideSchema.parse({
        key: command.key,
        content: PROMPT_TEMPLATE_CATALOG[command.key].defaultContent,
        scope: command.scope,
        ...(campaignId ? { campaignId } : {})
      });
      if (campaignId) await assertCampaignOwner(database, command.ownerUserId, campaignId);
      await database.query(
        `DELETE FROM prompt_template_overrides
          WHERE owner_user_id=$1 AND campaign_id IS NOT DISTINCT FROM $2 AND prompt_key=$3`,
        [command.ownerUserId, campaignId, command.key]
      );
      await invalidateModelChains(database, command, command.key);
      return listPromptLibrary(command);
    },
    loadPromptSnapshot
  };
}
