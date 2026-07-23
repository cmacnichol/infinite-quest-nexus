import { createHash } from "node:crypto";
import {
  buildPromptPreview,
  PROMPT_TEMPLATE_CATALOG,
  sampleValuesForPrompt,
  promptTemplateKeySchema,
  promptTemplateOverrideSchema,
  type PromptTemplateKey
} from "../../../packages/contracts/src/prompt-library.js";
import { z } from "zod";
import { initialOwnerId, type DatabaseClient, type DatabasePool } from "../../../packages/database/src/pool.js";
import {
  buildEventExtensionPrompt,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildSceneCoveragePrompt,
  buildStoryUserPrompt,
  buildTurnIntentPrompt
} from "../../../packages/story-engine/src/index.js";
type Database = DatabasePool | DatabaseClient;

type OverrideRow = { prompt_key: PromptTemplateKey; content: string; campaign_id: string | null; updated_at: string };
export type PromptSnapshot = Record<PromptTemplateKey, { content: string; hash: string; source: "shipped" | "application" | "campaign" }>;

function hash(content: string) { return createHash("sha256").update(content).digest("hex"); }

async function assertCampaignOwner(pool: Database, ownerUserId: string, campaignId: string) {
  const result = await pool.query("SELECT 1 FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
  if (!result.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
}

export async function resolvePromptSnapshot(pool: Database, ownerUserId: string, campaignId?: string): Promise<PromptSnapshot> {
  const result = await pool.query<OverrideRow>(
    `SELECT prompt_key, content, campaign_id, updated_at
       FROM prompt_template_overrides
      WHERE owner_user_id = $1 AND (campaign_id IS NULL OR campaign_id = $2)`,
    [ownerUserId, campaignId || null]
  );
  const application = new Map<string, string>();
  const campaign = new Map<string, string>();
  for (const row of result.rows) (row.campaign_id ? campaign : application).set(row.prompt_key, row.content);
  return Object.fromEntries(Object.values(PROMPT_TEMPLATE_CATALOG).map((definition) => {
    const content = campaign.get(definition.key) || application.get(definition.key) || definition.defaultContent;
    const source = campaign.has(definition.key) ? "campaign" : application.has(definition.key) ? "application" : "shipped";
    return [definition.key, { content, hash: hash(content), source }];
  })) as PromptSnapshot;
}

export async function listPromptLibrary(pool: DatabasePool, campaignId?: string) {
  const ownerUserId = await initialOwnerId(pool);
  if (campaignId) await assertCampaignOwner(pool, ownerUserId, campaignId);
  const snapshot = await resolvePromptSnapshot(pool, ownerUserId, campaignId);
  return {
    catalogVersion: "prompt-library-v1",
    campaignId: campaignId || null,
    templates: Object.values(PROMPT_TEMPLATE_CATALOG).map((definition) => ({
      key: definition.key, title: definition.title, category: definition.category, description: definition.description,
      campaignOverrideAllowed: definition.campaignOverrideAllowed, maxLength: definition.maxLength, variables: definition.variables,
      sampleValues: sampleValuesForPrompt(definition.key),
      defaultContent: definition.defaultContent, effectiveContent: snapshot[definition.key].content,
      effectiveSource: snapshot[definition.key].source, contentHash: snapshot[definition.key].hash
    }))
  };
}

export async function savePromptOverride(pool: DatabasePool, input: unknown) {
  const ownerUserId = await initialOwnerId(pool);
  const value = promptTemplateOverrideSchema.parse(input);
  if (value.scope === "campaign") await assertCampaignOwner(pool, ownerUserId, value.campaignId!);
  await pool.query(
    `INSERT INTO prompt_template_overrides (owner_user_id, campaign_id, prompt_key, content, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (owner_user_id, campaign_id, prompt_key) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    [ownerUserId, value.scope === "campaign" ? value.campaignId : null, value.key, value.content]
  );
  return listPromptLibrary(pool, value.scope === "campaign" ? value.campaignId : undefined);
}

export async function resetPromptOverride(pool: DatabasePool, input: unknown) {
  const schema = z.object({ key: promptTemplateKeySchema, scope: z.enum(["application", "campaign"]), campaignId: z.uuid().optional() }).superRefine((value, ctx) => {
    const definition = PROMPT_TEMPLATE_CATALOG[value.key];
    if (value.scope === "campaign" && (!value.campaignId || !definition.campaignOverrideAllowed)) ctx.addIssue({ code: "custom", message: "This prompt cannot use a campaign override." });
    if (value.scope === "application" && value.campaignId) ctx.addIssue({ code: "custom", message: "Application defaults cannot include a campaign." });
  });
  const value = schema.parse(input);
  const ownerUserId = await initialOwnerId(pool);
  if (value.scope === "campaign") await assertCampaignOwner(pool, ownerUserId, value.campaignId!);
  await pool.query("DELETE FROM prompt_template_overrides WHERE owner_user_id = $1 AND campaign_id IS NOT DISTINCT FROM $2 AND prompt_key = $3", [ownerUserId, value.scope === "campaign" ? value.campaignId : null, value.key]);
  return listPromptLibrary(pool, value.scope === "campaign" ? value.campaignId : undefined);
}

export function previewPromptTemplate(input: unknown) {
  const value = z.object({
    key: promptTemplateKeySchema,
    content: z.string().trim().min(1).max(16_000)
  }).parse(input);
  promptTemplateOverrideSchema.parse({ ...value, scope: "application" });
  const preview = buildPromptPreview(value.key, value.content);
  const context = {
    authoritativeRules: ["Moonlit gates open only for a spoken promise."],
    campaignState: { location: "Rainbridge", openThreads: ["Who sealed the eastern gate?"] }
  };
  let structuredInput = "";
  if (value.key.startsWith("story_")) structuredInput = buildStoryUserPrompt(context, "Mira raises the lantern and promises to return.");
  else if (value.key === "rpg_assessment") structuredInput = buildRpgAssessmentPrompt(context, "Mira attempts to open the sealed gate.", [{ id: "resolve", name: "Resolve", value: 63, note: "Courage under pressure." }]);
  else if (value.key === "event_trigger") structuredInput = buildEventTriggerPrompt("after", context, "Mira opens the gate.", 7, [{ id: "gate-opened", label: "The eastern gate opens", timing: "after", condition: "The eastern gate is opened.", effect: "Blue light floods the bridge.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }]);
  else if (value.key === "event_extension") structuredInput = buildEventExtensionPrompt("The gate opens beneath Mira's lantern.", ["Blue light floods the rain-swept bridge."]);
  else if (value.key === "turn_intent") structuredInput = buildTurnIntentPrompt("Mira opens the gate and calls for the ferryman.");
  else if (value.key === "scene_coverage" || value.key === "scene_coverage_rewrite") structuredInput = buildSceneCoveragePrompt("Mira opens the gate.", "Mira presses her palm to the blue glass, and the gate opens.");
  if (structuredInput) {
    const inputSection = preview.sections.find((section) => section.role === "input");
    if (inputSection) inputSection.content = structuredInput;
    preview.estimatedTokens = Math.max(1, Math.ceil(preview.sections.reduce((total, section) => total + section.content.length, 0) / 4));
  }
  return preview;
}

export function promptFromSnapshot(snapshot: PromptSnapshot | Record<string, unknown> | undefined, key: PromptTemplateKey) {
  const candidate = snapshot && (snapshot as PromptSnapshot)[key];
  return candidate?.content || PROMPT_TEMPLATE_CATALOG[key].defaultContent;
}

export function promptProtocolVersion(snapshot: PromptSnapshot | Record<string, unknown> | undefined) {
  const runtimeKeys: PromptTemplateKey[] = [
    "story_system", "story_recovery_output_limit", "story_recovery_mechanics", "story_recovery_schema",
    "rpg_assessment", "event_trigger", "event_extension", "turn_intent", "scene_coverage", "scene_coverage_rewrite"
  ];
  const identity = runtimeKeys.map((key) => `${key}:${hash(promptFromSnapshot(snapshot, key))}`).join("\n");
  return `prompt-library-v1-${hash(identity).slice(0, 16)}`;
}
