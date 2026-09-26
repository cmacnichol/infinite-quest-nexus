import { createHash } from "node:crypto";
import {
  buildPromptPreview,
  PROMPT_TEMPLATE_CATALOG,
  PROMPT_CATALOG,
  CONTINUITY_REVIEW_PROMPT_CATALOG,
  storyMemoryPromptCompatibilityRequirement,
  promptCompatibilityRequirement,
  promptTemplateOverrideSchema,
  sampleValuesForPrompt,
  legacyPromptTemplateKeys,
  RETIRED_PROMPT_TEMPLATE_KEYS,
  type PromptSnapshotV2,
  type PromptSnapshot,
  type PromptTemplateKey,
  type PromptCatalogKey
} from "../../contracts/src/prompt-library.js";
import {
  STORY_PROMPT_PROTOCOL_VERSION,
  STORY_MEMORY_PROMPT_PROTOCOL_VERSION,
  STORY_OUTPUT_ENCODING_CONTRACT_V3,
  castStoryMemoryPromptCompatibilityIdentity,
  storyMemoryMandatoryContract,
  storyPromptCompatibilityIdentity,
  storyPromptProtocolIdentity
} from "../../contracts/src/story-prompt.js";
import { textModelSelectionSchema } from "../../contracts/src/provider-selection.js";
import type {
  PromptLibraryPort,
  PromptPreviewView,
  PromptScope,
  PromptSnapshotVersion
} from "../../application/src/providers/index.js";
import {
  buildEventExtensionPrompt,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildSceneCoveragePrompt,
  buildStoryUserPrompt,
  composeEffectiveStorySystemPrompt,
  storyOnlyPromptSnapshot
} from "../../story-engine/src/index.js";
import type { DatabaseClient } from "./pool.js";

const CATALOG_VERSION = "prompt-library-v1";
const RUNTIME_KEYS: readonly PromptTemplateKey[] = [
  "story_system", "story_recovery_output_limit", "story_recovery_mechanics", "story_recovery_schema",
  "rpg_assessment", "event_trigger", "event_extension", "turn_intent", "scene_coverage", "scene_coverage_rewrite"
];

type OverrideRow = {
  prompt_key: PromptCatalogKey;
  content: string;
  campaign_id: string | null;
  compatibility_required_shape_version: string | null;
  compatibility_protocol_identity: string | null;
  compatibility_content_hash: string | null;
};

type PromptCompatibilityMode = "legacy" | "story_memory";

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

/** The library must describe the acknowledgement that its selected campaign
 * will actually need at enqueue time.  This is an eligibility check only; it
 * never reads a mutable policy from a queued generation.
 *
 * Every campaign is enrolled on creation (migration 0112), and legacy mode
 * accepts the stricter Story Memory acknowledgement, so application defaults
 * must be acknowledged for Story Memory to be usable anywhere. */
async function promptCompatibilityMode(database: DatabaseClient, scope: PromptScope): Promise<PromptCompatibilityMode> {
  if (scope.scope !== "campaign") return "story_memory";
  const enrollment = await database.query(
    `SELECT 1 FROM campaign_story_memory_enrollments
      WHERE campaign_id=$1 AND owner_user_id=$2`,
    [scope.campaignId, scope.ownerUserId]
  );
  return enrollment.rows[0] ? "story_memory" : "legacy";
}

async function invalidateModelChains(database: DatabaseClient, scope: PromptScope, key: PromptCatalogKey) {
  if (!RUNTIME_KEYS.includes(key as PromptTemplateKey)) return;
  await database.query(
    `UPDATE model_chains
        SET active=false,updated_at=now()
      WHERE owner_user_id=$1 AND active
        AND ($2::uuid IS NULL OR campaign_id=$2)`,
    [scope.ownerUserId, scope.scope === "campaign" ? scope.campaignId : null]
  );
}

function acknowledgementMatches(
  row: OverrideRow,
  requirement: NonNullable<ReturnType<typeof promptCompatibilityRequirement>>
): boolean {
  return row.compatibility_required_shape_version === requirement.requiredShapeVersion
    && row.compatibility_protocol_identity === requirement.protocolIdentity
    && row.compatibility_content_hash === hash(row.content);
}

function overrideIsCompatible(row: OverrideRow, mode: PromptCompatibilityMode): boolean {
  if (!(legacyPromptTemplateKeys as readonly string[]).includes(row.prompt_key)) return true;
  const legacyRequirement = promptCompatibilityRequirement(row.prompt_key as PromptTemplateKey);
  if (!legacyRequirement) return true;
  if (mode === "story_memory") {
    const storyMemoryRequirement = storyMemoryPromptCompatibilityRequirement(row.prompt_key as PromptTemplateKey);
    return storyMemoryRequirement !== null && acknowledgementMatches(row, storyMemoryRequirement);
  }
  // A v14 acknowledgement is stricter for the same output schema and leaves
  // the editable creative text intact, so existing v13 generation may use it.
  return acknowledgementMatches(row, legacyRequirement)
    || (storyMemoryPromptCompatibilityRequirement(row.prompt_key as PromptTemplateKey) !== null
      && acknowledgementMatches(row, storyMemoryPromptCompatibilityRequirement(row.prompt_key as PromptTemplateKey)!));
}

async function resolveSnapshot(
  database: DatabaseClient,
  scope: PromptScope,
  enforceCompatibility = true,
  mode: PromptCompatibilityMode = "legacy"
): Promise<PromptSnapshot> {
  const campaignId = scope.scope === "campaign" ? scope.campaignId : null;
  if (campaignId) await assertCampaignOwner(database, scope.ownerUserId, campaignId);
  const result = await database.query<OverrideRow>(
    `SELECT prompt_key,content,campaign_id,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash FROM prompt_template_overrides
      WHERE owner_user_id=$1 AND (campaign_id IS NULL OR campaign_id=$2)
      ORDER BY campaign_id NULLS FIRST,prompt_key`,
    [scope.ownerUserId, campaignId]
  );
  const application = new Map<PromptCatalogKey, OverrideRow>();
  const campaign = new Map<PromptCatalogKey, OverrideRow>();
  for (const row of result.rows) {
    if (!(legacyPromptTemplateKeys as readonly string[]).includes(row.prompt_key)) continue;
    if (mode === "legacy" && enforceCompatibility && !overrideIsCompatible(row, mode)) {
      throw Object.assign(new Error("A saved prompt override must be acknowledged for the current required output shape before generation can run."), {
        statusCode: 409,
        code: "prompt_override_incompatible"
      });
    }
    (row.campaign_id ? campaign : application).set(row.prompt_key, row);
  }
  return Object.fromEntries(legacyPromptTemplateKeys.map((key) => {
    const definition = PROMPT_TEMPLATE_CATALOG[key];
    const effective = campaign.get(definition.key) ?? application.get(definition.key);
    if (mode === "story_memory" && enforceCompatibility && effective && !overrideIsCompatible(effective, mode)) {
      throw Object.assign(new Error("The effective prompt override requires compatibility acknowledgement."), {
        statusCode: 409, code: "prompt_override_incompatible"
      });
    }
    const content = effective?.content ?? definition.defaultContent;
    const source = campaign.has(definition.key) ? "campaign" : application.has(definition.key) ? "application" : "shipped";
    return [definition.key, { content, hash: hash(content), source }];
  })) as PromptSnapshot;
}

/** Rows are owner-scoped and ordered with campaign overrides after application defaults. */
function resolveContinuityPromptPair(rows: readonly OverrideRow[]): NonNullable<PromptSnapshotV2["continuityReview"]> {
  const resolve = (definition: typeof CONTINUITY_REVIEW_PROMPT_CATALOG.review) => {
    const effective = rows.filter((row) => row.prompt_key === definition.key).at(-1);
    const content = effective?.content ?? definition.defaultContent;
    return { content, hash: hash(content), source: effective?.campaign_id ? "campaign" as const : effective ? "application" as const : "shipped" as const, protocolIdentity: definition.protocolIdentity };
  };
  return { review: resolve(CONTINUITY_REVIEW_PROMPT_CATALOG.review), repair: resolve(CONTINUITY_REVIEW_PROMPT_CATALOG.repair) };
}

/**
 * A Story Memory job captures an immutable v2 envelope. Its v14 proof binds
 * the acknowledged protected template bytes, so execution never consults a
 * later mutable override.
 */
export async function resolveStoryMemoryPromptSnapshot(
  database: DatabaseClient,
  scope: PromptScope,
  continuityReviewMode: "off" | "observe" | "enforce" = "off",
  castContext = false
): Promise<PromptSnapshotV2> {
  const templates = await resolveSnapshot(database, scope, true, "story_memory");
  const storyMemoryCompatibility = {
    protocolIdentity: castContext ? castStoryMemoryPromptCompatibilityIdentity() : storyMemoryPromptCompatibilityRequirement("story_system")!.protocolIdentity,
    templateHashes: {
      story_system: templates.story_system.hash,
      event_extension: templates.event_extension.hash
    }
  } as const;
  const continuityReview = continuityReviewMode === "off" ? null : await (async () => {
    const campaignId = scope.scope === "campaign" ? scope.campaignId : null;
    const rows = await database.query<OverrideRow>(
      `SELECT prompt_key,content,campaign_id,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash FROM prompt_template_overrides
       WHERE owner_user_id=$1 AND (campaign_id IS NULL OR campaign_id=$2)
         AND prompt_key IN ('story_continuity_review','story_continuity_repair') ORDER BY campaign_id NULLS FIRST,prompt_key`,
      [scope.ownerUserId, campaignId]
    );
    return resolveContinuityPromptPair(rows.rows);
  })();
  return {
    version: 2,
    templates,
    continuityReview,
    storyMemoryCompatibility
  };
}

/** New non-enrolled jobs freeze the acknowledged story-system bytes together
 * with the v16 fact-wire contract identity. Historical snapshots remain raw. */
export async function resolveStoryPromptSnapshot(
  database: DatabaseClient,
  scope: PromptScope
): Promise<PromptSnapshotV2> {
  const templates = await resolveSnapshot(database, scope, true, "legacy");
  return {
    version: 2,
    templates,
    continuityReview: null,
    storyPromptCompatibility: {
      protocolIdentity: promptCompatibilityRequirement("story_system")!.protocolIdentity,
      templateHash: templates.story_system.hash
    }
  };
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
  }, ["Blue light floods the rain-swept bridge."], context, "Mira opens the gate.");
  else if (key === "scene_coverage" || key === "scene_coverage_rewrite") structuredInput = buildSceneCoveragePrompt("Mira opens the gate.", "Mira presses her palm to the blue glass, and the gate opens.");
  if (structuredInput) {
    const inputSection = preview.sections.find((section) => section.role === "input");
    if (inputSection) inputSection.content = structuredInput;
    preview.estimatedTokens = Math.max(1, Math.ceil(preview.sections.reduce((total, section) => total + section.content.length, 0) / 4));
  }
  return preview;
}

/**
 * Resolves the Story Memory prompt protocol an enrolled campaign should show in
 * preview. Cast authority (CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION) is chosen
 * at enqueue by an operator-wide runtime toggle
 * (StoryMemoryOperatorConfig.castContextEnabled), not a per-campaign database
 * value, so this repository cannot read that toggle directly. Instead it reuses
 * whatever protocol the campaign's own most recent generation job already froze
 * into generation_jobs.context_options->'storyMemoryPolicy'->>'promptProtocol'
 * (the same field the executor reads at generation-executor-adapter.ts). That
 * protocol is accepted only when storyMemoryMandatoryContract still recognizes
 * it; otherwise (or when the campaign has never queued a turn) preview falls
 * back to the current default protocol and says so explicitly.
 */
async function resolveStoryMemoryPreviewProtocol(
  database: DatabaseClient,
  ownerUserId: string,
  campaignId: string
): Promise<Readonly<{ promptProtocol: string; source: "latest_job" | "default" }>> {
  const latestJobResult = await database.query<{ contextOptions: Record<string, unknown> | null }>(
    `SELECT context_options AS "contextOptions" FROM generation_jobs
      WHERE owner_user_id=$1 AND campaign_id=$2
      ORDER BY created_at DESC LIMIT 1`,
    [ownerUserId, campaignId]
  );
  const candidate = (latestJobResult.rows[0]?.contextOptions as { storyMemoryPolicy?: { promptProtocol?: unknown } } | null)
    ?.storyMemoryPolicy?.promptProtocol;
  if (typeof candidate === "string") {
    try {
      storyMemoryMandatoryContract(candidate);
      return { promptProtocol: candidate, source: "latest_job" };
    } catch { /* unsupported or malformed; fall back to the current default below */ }
  }
  return { promptProtocol: STORY_MEMORY_PROMPT_PROTOCOL_VERSION, source: "default" };
}

/**
 * Adds the effective (post-composition) writer system prompt to a story_system
 * preview for a specific campaign, a note naming the Story Memory protocol
 * source for an enrolled campaign, and a note when the campaign's text profile
 * is a provider preset (its own system text is applied at dispatch, never shown
 * here). This never calls a provider and never exposes credentials or preset
 * text.
 */
async function withEffectiveStorySystemPreview(
  database: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  content: string,
  base: PromptPreviewView
): Promise<PromptPreviewView> {
  const campaignResult = await database.query<{ turn_control_style: string; text_provider_profile_id: string | null }>(
    "SELECT turn_control_style,text_provider_profile_id FROM campaigns WHERE id=$1 AND owner_user_id=$2",
    [campaignId, ownerUserId]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });

  const enrollmentResult = await database.query(
    "SELECT 1 FROM campaign_story_memory_enrollments WHERE campaign_id=$1 AND owner_user_id=$2",
    [campaignId, ownerUserId]
  );
  const enrolled = enrollmentResult.rows.length > 0;
  const storyMemory = enrolled ? await resolveStoryMemoryPreviewProtocol(database, ownerUserId, campaignId) : null;

  const providerResult = campaign.text_provider_profile_id
    ? await database.query<{ text_selection: unknown }>(
      "SELECT text_selection FROM provider_profiles WHERE id=$1 AND owner_user_id=$2 AND provider_role='text' AND enabled=true",
      [campaign.text_provider_profile_id, ownerUserId]
    )
    : await database.query<{ text_selection: unknown }>(
      "SELECT text_selection FROM provider_profiles WHERE owner_user_id=$1 AND provider_role='text' AND enabled=true ORDER BY is_default DESC,name,id LIMIT 1",
      [ownerUserId]
    );
  const selection = textModelSelectionSchema.safeParse(providerResult.rows[0]?.text_selection);
  const usesPreset = selection.success && selection.data.kind === "openrouter_preset";

  const storyOnlyPolicy = campaign.turn_control_style === "flexible_scene"
    ? { version: 1 as const, playMode: "story_only" as const, turnControlStyle: "flexible_scene" as const, protocolVersion: "story-only-v1" as const, prompts: storyOnlyPromptSnapshot() }
    : null;
  const storyPromptContractProtocol = !enrolled && content !== PROMPT_TEMPLATE_CATALOG.story_system.defaultContent
    ? storyPromptCompatibilityIdentity()
    : undefined;

  const effectiveContent = composeEffectiveStorySystemPrompt({
    writerPrompt: content,
    storyOnlyPolicy,
    storyMemoryPromptProtocol: storyMemory?.promptProtocol ?? null,
    ...(storyPromptContractProtocol ? { storyPromptContractProtocol } : {}),
    encodingContract: STORY_OUTPUT_ENCODING_CONTRACT_V3
  });

  const sections = [
    ...base.sections,
    { label: "Effective system prompt", role: "system" as const, content: effectiveContent },
    ...(storyMemory ? [{
      label: "Story Memory contract source",
      role: "system" as const,
      content: storyMemory.source === "latest_job"
        ? `Protocol ${storyMemory.promptProtocol} from the campaign's latest queued turn.`
        : `Protocol ${storyMemory.promptProtocol} is the current default protocol; the campaign-cast contract is added at dispatch when cast context is enabled.`
    }] : []),
    ...(usesPreset ? [{
      label: "Preset system prompt (added at dispatch)",
      role: "system" as const,
      content: "Applied by the selected provider preset; not shown here."
    }] : [])
  ];
  return {
    ...base,
    sections,
    estimatedTokens: Math.max(1, Math.ceil(sections.reduce((total, section) => total + section.content.length, 0) / 4))
  };
}

export function createPromptRepository(database: DatabaseClient): PromptLibraryPort {
  const activeDefinition = (key: PromptCatalogKey) => {
    if (RETIRED_PROMPT_TEMPLATE_KEYS.has(key as PromptTemplateKey)) throw Object.assign(new Error("This historical prompt is unavailable."), { statusCode: 410, code: key === "turn_intent" ? "turn_input_classification_removed" : "prompt_template_retired" });
    return PROMPT_CATALOG[key];
  };
  async function loadPromptSnapshot(scope: PromptScope): Promise<PromptSnapshotVersion> {
    const snapshot = await resolveSnapshot(database, scope);
    return { catalogVersion: CATALOG_VERSION, protocolVersion: protocolVersion(snapshot), snapshot };
  }

  async function listPromptLibrary(scope: PromptScope) {
    const snapshot = await resolveSnapshot(database, scope, false);
    const compatibilityMode = await promptCompatibilityMode(database, scope);
    const campaignId = scope.scope === "campaign" ? scope.campaignId : null;
    const overrides = await database.query<OverrideRow>(
      `SELECT prompt_key,content,campaign_id,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash FROM prompt_template_overrides
        WHERE owner_user_id=$1 AND (campaign_id IS NULL OR campaign_id=$2)
        ORDER BY campaign_id NULLS FIRST,prompt_key`,
      [scope.ownerUserId, campaignId]
    );
    const acknowledgement = new Map<PromptCatalogKey, OverrideRow>();
    for (const row of overrides.rows) acknowledgement.set(row.prompt_key, row);
    const continuity = resolveContinuityPromptPair(overrides.rows);
    const displaySnapshot = { ...snapshot, story_continuity_review: continuity.review, story_continuity_repair: continuity.repair };
    return {
      catalogVersion: CATALOG_VERSION,
      campaignId: scope.scope === "campaign" ? scope.campaignId : null,
      templates: Object.values(PROMPT_CATALOG).filter((definition) => !RETIRED_PROMPT_TEMPLATE_KEYS.has(definition.key as PromptTemplateKey)).map((definition) => {
        const frozen = displaySnapshot[definition.key];
        return ({
        key: definition.key,
        title: definition.title,
        category: definition.category,
        description: definition.description,
        campaignOverrideAllowed: definition.campaignOverrideAllowed,
        maxLength: definition.maxLength,
        variables: definition.variables,
        sampleValues: (legacyPromptTemplateKeys as readonly string[]).includes(definition.key) ? sampleValuesForPrompt(definition.key as PromptTemplateKey) : {},
        defaultContent: definition.defaultContent,
        effectiveContent: frozen.content,
        effectiveSource: frozen.source,
        contentHash: frozen.hash,
        compatibility: (() => {
          const requirement = compatibilityMode === "story_memory"
            ? storyMemoryPromptCompatibilityRequirement(definition.key as PromptTemplateKey)
            : promptCompatibilityRequirement(definition.key as PromptTemplateKey);
          if (!requirement) return null;
          return {
            ...requirement,
            acknowledged: frozen.source === "shipped" || (() => {
              const override = acknowledgement.get(definition.key);
              return override?.compatibility_required_shape_version === requirement.requiredShapeVersion
                && override.compatibility_protocol_identity === requirement.protocolIdentity
                && override.compatibility_content_hash === frozen.hash;
            })()
          };
        })()
      }); })
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
      activeDefinition(value.key);
      const base = !(legacyPromptTemplateKeys as readonly string[]).includes(value.key)
        ? buildPromptPreview("story_system", value.content)
        : establishedPromptPreview(value.key as PromptTemplateKey, value.content);
      if (value.key !== "story_system" || !request.campaignId) return base;
      return withEffectiveStorySystemPreview(database, request.ownerUserId, request.campaignId, value.content, base);
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
      activeDefinition(value.key);
      const requirement = promptCompatibilityRequirement(value.key as PromptTemplateKey);
      const storyMemoryRequirement = storyMemoryPromptCompatibilityRequirement(value.key as PromptTemplateKey);
      const acknowledgement = value.compatibilityAcknowledgement;
      const acknowledgementValid = !requirement || (!!acknowledgement && (
        (acknowledgement.requiredShapeVersion === requirement.requiredShapeVersion
          && acknowledgement.protocolIdentity === requirement.protocolIdentity
          && acknowledgement.contentHash === hash(value.content))
        || (storyMemoryRequirement !== null
          && acknowledgement.requiredShapeVersion === storyMemoryRequirement.requiredShapeVersion
          && acknowledgement.protocolIdentity === storyMemoryRequirement.protocolIdentity
          && acknowledgement.contentHash === hash(value.content))
      ));
      if (!acknowledgementValid) {
        throw Object.assign(new Error("Acknowledge the current required output shape for this exact prompt text before saving."), {
          statusCode: 409,
          code: "prompt_override_incompatible"
        });
      }
      if (campaignId) await assertCampaignOwner(database, command.ownerUserId, campaignId);
      await database.query(
        `INSERT INTO prompt_template_overrides(owner_user_id,campaign_id,prompt_key,content,compatibility_required_shape_version,compatibility_protocol_identity,compatibility_content_hash,compatibility_acknowledged_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,now())
         ON CONFLICT(owner_user_id,campaign_id,prompt_key)
         DO UPDATE SET content=excluded.content,compatibility_required_shape_version=excluded.compatibility_required_shape_version,compatibility_protocol_identity=excluded.compatibility_protocol_identity,compatibility_content_hash=excluded.compatibility_content_hash,compatibility_acknowledged_at=excluded.compatibility_acknowledged_at,updated_at=now()`,
        [command.ownerUserId, campaignId, value.key, value.content,
          acknowledgement?.requiredShapeVersion ?? null, acknowledgement?.protocolIdentity ?? null, acknowledgement?.contentHash ?? null]
      );
      await invalidateModelChains(database, command, value.key);
      return listPromptLibrary(command);
    },
    async resetPromptOverride(command) {
      const campaignId = command.scope === "campaign" ? command.campaignId : null;
      const value = promptTemplateOverrideSchema.parse({
        key: command.key,
        content: PROMPT_CATALOG[command.key].defaultContent,
        scope: command.scope,
        ...(campaignId ? { campaignId } : {})
      });
      // Resets remain allowed for retired keys so operators can delete stale
      // rows (for example, campaign-scoped story_recovery_* overrides) even
      // though preview and save reject them.
      if (!RETIRED_PROMPT_TEMPLATE_KEYS.has(value.key as PromptTemplateKey)) activeDefinition(value.key);
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
