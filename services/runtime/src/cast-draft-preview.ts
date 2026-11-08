import { z } from "zod";
import { CAST_DRAFT_SYSTEM_PROMPT_V1, castFieldSchema, castAuthoredPathSchema, type CastDraftPreviewRequest, type CastDraftPreviewResponse, type CastScope } from "../../../packages/contracts/src/index.js";
import type { CampaignCastWritePort } from "../../../packages/application/src/campaign-cast/ports.js";
import { CampaignCastError } from "../../../packages/application/src/campaign-cast/ports.js";
import { supportsCastDraftFact } from "../../../packages/domain/src/campaign-cast-discovery.js";
import { projectCastFictionText } from "../../../packages/domain/src/character-fiction-authority.js";
import { validateCastFiction } from "../../../packages/domain/src/campaign-cast.js";
import { extractJsonObject } from "../../../packages/story-engine/src/output.js";
import { prepareDirectAuthoringTextExecution } from "./authoring-text-execution-preparation.js";
import { runAuthoringResponse } from "./authoring-response-adapter.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";

const outputSchema = z.object({ proposals: z.array(z.object({ path: z.string().min(1).max(200), value: z.string().min(1).max(20000), evidenceIds: z.array(z.uuid()).max(40) }).strict()).max(30) }).strict();

/** An ephemeral preview: only the scoped, projected evidence leaves this service. */
export function createCastDraftPreview(pool: DatabasePool, repository: CampaignCastWritePort, providers?: Pick<ApiGenerationProviderCollaborators, "execution" | "resolution" | "authoringTextPlans">) {
  return async (scope: CastScope, id: string, request: CastDraftPreviewRequest): Promise<CastDraftPreviewResponse> => {
    if (!repository.draftPreviewContext) throw new CampaignCastError("cast_discovery_unavailable");
    const context = await repository.draftPreviewContext(scope, id, request);
    const empty = { boundary: context.boundary, characterRevision: context.character.revision, evidence: context.evidence, proposals: [], omitted: [] };
    if (!context.evidence.length) return empty;
    if (!providers) throw new CampaignCastError("cast_discovery_unavailable");
    try {
      const row = (await pool.query(`SELECT c.text_provider_profile_id,w.content FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
      if (!row) throw new Error("missing campaign");
      const resolution = await providers.resolution.resolveDirect({ ownerUserId: scope.ownerUserId, providerRole: "text", ...(row.text_provider_profile_id ? { selectedProviderProfileId: row.text_provider_profile_id } : {}) });
      if (resolution.status !== "resolved") throw new Error("provider unavailable");
      const provider = await providers.execution.text({ ownerUserId: scope.ownerUserId }, resolution.providerProfileId, "text", resolution.model);
      const prepared = await prepareDirectAuthoringTextExecution({ ownerUserId: scope.ownerUserId, execution: provider, ...(providers.authoringTextPlans ? { options: providers.authoringTextPlans } : {}), operationPrompts: { castDraft: CAST_DRAFT_SYSTEM_PROMPT_V1, castDraftRepair: CAST_DRAFT_SYSTEM_PROMPT_V1 } });
      const person = context.character;
      const world = row.content?.world ?? {};
      const authored: Record<string, string | string[]> = {};
      let authoredSize = 0;
      for (const path of castAuthoredPathSchema.options) {
        if (!person.campaignProfile) break;
        const [section, key] = path.split(".");
        const raw = key ? (person.campaignProfile as any)[section!]?.[key] : (person.campaignProfile as any)[section!];
        const effective = (person.profile as Record<string, string>)[path] ?? raw;
        const safe = Array.isArray(effective) ? effective.map(value => projectCastFictionText(value, 600)).filter(Boolean).slice(0, 20) : projectCastFictionText(effective, 600);
        const size = Array.isArray(safe) ? safe.reduce((total, value) => total + value.length, 0) : safe.length;
        if (size && authoredSize + size <= 12000) { authored[path] = safe; authoredSize += size; }
      }
      const eligiblePaths = (person.campaignProfile ? castAuthoredPathSchema.options : castFieldSchema.options).filter(path => {
        if (path.startsWith("state.") || path === "story.goals" || context.observedPaths.includes(path) || (person.profile as Record<string, string>)[path]?.trim()) return false;
        const [section, key] = path.split(".");
        const authored = key && person.campaignProfile ? (person.campaignProfile as any)[section!]?.[key] : undefined;
        return !(typeof authored === "string" && authored.trim()) && !(Array.isArray(authored) && authored.length);
      });
      const input = { name: projectCastFictionText(person.name, 200), aliases: person.aliases.map(value => projectCastFictionText(value, 200)).filter(Boolean),
        current: Object.fromEntries(Object.entries(person.profile).map(([path, value]) => [path, projectCastFictionText(value, 2000)]).filter(([, value]) => value)), authored,
        eligiblePaths,
        world: { premise: projectCastFictionText(world.premise, 8000), tone: projectCastFictionText(world.tone, 2000) },
        direction: projectCastFictionText(request.direction ?? "", 2000), evidence: context.evidence.map(({ evidenceId, quote }) => ({ evidenceId, quote })) };
      const wire = { systemPrompt: CAST_DRAFT_SYSTEM_PROMPT_V1, input: JSON.stringify(input), responseFormatFallback: "forbid" as const, maxOutputTokens: 4096 };
      const output = await runAuthoringResponse({ stage: "character", request: attempt => {
        const request = { ...wire, ...(attempt.repair ? { recoveryInput: JSON.stringify({ issues: attempt.issues }) } : {}) };
        return prepared ? prepared.execute({ operation: attempt.repair ? "castDraftRepair" : "castDraft", request }) : provider.execute(request);
      }, parse: content => outputSchema.parse(extractJsonObject(content)), delay: async () => {}, transportRetryOwner: prepared ? "prepared_executor" : "outer" });
      const latest = await repository.draftPreviewContext(scope, id, request);
      if (JSON.stringify(latest.evidence) !== JSON.stringify(context.evidence) || JSON.stringify(latest.observedPaths) !== JSON.stringify(context.observedPaths)) throw new CampaignCastError("cast_draft_evidence_changed");
      const proposals: CastDraftPreviewResponse["proposals"] = [], omitted: CastDraftPreviewResponse["omitted"] = [];
      const seen = new Set<string>();
      for (const proposal of output.proposals) {
        const field = castFieldSchema.safeParse(proposal.path);
        const creative = proposal.path === "story.otherGuidance" && !!person.campaignProfile;
        const [section, key] = proposal.path.split(".");
        const authored = key && person.campaignProfile ? (person.campaignProfile as any)[section!]?.[key] : undefined;
        const references = proposal.evidenceIds.map(evidenceId => context.evidence.find(item => item.evidenceId === evidenceId));
        const available = eligiblePaths.includes(proposal.path as never) && (person.campaignProfile ? castAuthoredPathSchema.safeParse(proposal.path).success : field.success);
        let safeValue = true;
        try { validateCastFiction(proposal.value); } catch { safeValue = false; }
        const invalid = seen.has(proposal.path) || !available || proposal.path.startsWith("state.") || proposal.path === "story.goals"
          || context.observedPaths.includes(proposal.path) || !safeValue
          || !!(person.profile as Record<string, string>)[proposal.path]?.trim() || typeof authored === "string" && !!authored.trim()
          || proposal.value.length > (!person.campaignProfile || proposal.path === "identity.pronouns" || ["appearance.ancestryOrSpecies", "appearance.apparentAge", "appearance.genderPresentation", "appearance.build", "appearance.skinOrComplexion", "appearance.eyes"].includes(proposal.path) ? 2000 : 20000)
          || projectCastFictionText(proposal.value, proposal.value.length + 1) !== proposal.value
          || ((!creative || references.length > 0) && (!references.length || references.some(item => !item || !supportsCastDraftFact({ paragraph: item.quote, quote: item.quote, names: [person.name, ...person.aliases], field: proposal.path, value: proposal.value }))))
          || references.some(item => !item);
        seen.add(proposal.path);
        if (invalid) { omitted.push({ path: proposal.path, reason: "unsupported_or_unavailable" }); continue; }
        const evidence = references.filter((item): item is NonNullable<typeof item> => !!item);
        proposals.push({ ...proposal, ...(!creative ? { draftEvidenceFence: { path: proposal.path, value: proposal.value, evidence } } : {}) });
      }
      return { ...empty, proposals, omitted };
    } catch (error) {
      if (error instanceof CampaignCastError) throw error;
      throw new CampaignCastError("cast_discovery_unavailable");
    }
  };
}
