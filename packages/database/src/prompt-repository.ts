import { createHash } from "node:crypto";
import {
  buildPromptPreview,
  PROMPT_TEMPLATE_CATALOG,
  promptTemplateOverrideSchema,
  sampleValuesForPrompt,
  type PromptSnapshot,
  type PromptTemplateKey
} from "../../contracts/src/prompt-library.js";
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

async function resolveSnapshot(database: DatabaseClient, scope: PromptScope): Promise<PromptSnapshot> {
  const campaignId = scope.scope === "campaign" ? scope.campaignId : null;
  if (campaignId) await assertCampaignOwner(database, scope.ownerUserId, campaignId);
  const result = await database.query<OverrideRow>(
    `SELECT prompt_key,content,campaign_id FROM prompt_template_overrides
      WHERE owner_user_id=$1 AND (campaign_id IS NULL OR campaign_id=$2)
      ORDER BY campaign_id NULLS FIRST,prompt_key`,
    [scope.ownerUserId, campaignId]
  );
  const application = new Map<PromptTemplateKey, string>();
  const campaign = new Map<PromptTemplateKey, string>();
  for (const row of result.rows) (row.campaign_id ? campaign : application).set(row.prompt_key, row.content);
  return Object.fromEntries(Object.values(PROMPT_TEMPLATE_CATALOG).map((definition) => {
    const content = campaign.get(definition.key) ?? application.get(definition.key) ?? definition.defaultContent;
    const source = campaign.has(definition.key) ? "campaign" : application.has(definition.key) ? "application" : "shipped";
    return [definition.key, { content, hash: hash(content), source }];
  })) as PromptSnapshot;
}

function protocolVersion(snapshot: PromptSnapshot): string {
  const identity = RUNTIME_KEYS.map((key) => `${key}:${snapshot[key].hash}`).join("\n");
  return `${CATALOG_VERSION}-${hash(identity).slice(0, 16)}`;
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
  else if (key === "event_extension") structuredInput = buildEventExtensionPrompt("The gate opens beneath Mira's lantern.", ["Blue light floods the rain-swept bridge."]);
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
    const { snapshot } = await loadPromptSnapshot(scope);
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
        contentHash: snapshot[definition.key].hash
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
        ...(campaignId ? { campaignId } : {})
      });
      if (campaignId) await assertCampaignOwner(database, command.ownerUserId, campaignId);
      await database.query(
        `INSERT INTO prompt_template_overrides(owner_user_id,campaign_id,prompt_key,content,updated_at)
         VALUES($1,$2,$3,$4,now())
         ON CONFLICT(owner_user_id,campaign_id,prompt_key)
         DO UPDATE SET content=excluded.content,updated_at=now()`,
        [command.ownerUserId, campaignId, value.key, value.content]
      );
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
      return listPromptLibrary(command);
    },
    loadPromptSnapshot
  };
}
