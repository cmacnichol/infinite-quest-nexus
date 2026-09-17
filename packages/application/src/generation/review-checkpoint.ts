import { generationReviewReasonCodeSchema, generationReviewStageSchema, storyTurnOutputSchema, z } from "@infinite-quest/contracts";
import { canonicalEvidenceJson, generationBaseIdentitySchema } from "../memory/generation-context.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const immutableJsonSchema = z.record(z.string(), z.unknown());

/** Immutable server-created candidate provenance for later worker decision handling. */
export const generationReviewCandidateSchema = z.strictObject({
  scope: z.enum(["main", "final"]), story: storyTurnOutputSchema.nullable(), storyHash: hashSchema,
  rawOutputReference: z.string().trim().min(1).max(500).nullable(), producingRequestHash: hashSchema.nullable(),
  producingResponseId: z.string().trim().min(1).max(500).nullable(), sentFactIds: z.array(z.uuid()).max(1_000),
  ownerUserId: z.uuid(), campaignId: z.uuid(), worldId: z.uuid(), worldVersionId: z.uuid().nullable(),
  baseTurnNumber: z.number().int().min(0), expectedTurnNumber: z.number().int().positive(), policy: immutableJsonSchema, policyHash: hashSchema,
  baseIdentity: generationBaseIdentitySchema,
  protocol: z.strictObject({ version: z.string().trim().min(1).max(200), promptHash: hashSchema }),
  provider: z.strictObject({ type: z.string().trim().min(1).max(100), profileId: z.uuid().nullable(), configurationHash: hashSchema }),
  resumeDependencies: z.strictObject({
    generationContext: immutableJsonSchema,
    producingProviderResult: immutableJsonSchema.nullable(),
    stageState: immutableJsonSchema,
    frozenCommitInputs: immutableJsonSchema,
    replacementTarget: immutableJsonSchema.nullable()
  })
}).superRefine((candidate, context) => {
  if (!candidate.story && !candidate.rawOutputReference) context.addIssue({ code: "custom", message: "A candidate requires typed story content or an immutable raw-output reference." });
  if (candidate.story && !candidate.producingRequestHash) context.addIssue({ code: "custom", message: "Typed candidate content requires its producing request identity." });
  if (candidate.baseTurnNumber !== candidate.baseIdentity.baseTurnNumber || candidate.expectedTurnNumber !== candidate.baseIdentity.expectedTurnNumber) {
    context.addIssue({ code: "custom", message: "Candidate turn numbers must match its frozen generation base identity." });
  }
});

export const generationReviewDecisionJournalEntrySchema = z.strictObject({
  reviewId: z.uuid(), revision: z.number().int().safe().positive(), actorUserId: z.uuid(), decision: z.enum(["keep", "retry"]),
  decidedAt: z.string().datetime({ offset: true }), candidateScope: z.enum(["main", "final"]), candidateHash: hashSchema,
  findingsHash: hashSchema, nextStage: generationReviewStageSchema.nullable(),
  offeredCandidate: generationReviewCandidateSchema,
  offeredReasons: z.array(generationReviewReasonCodeSchema).min(1).max(20),
  actionReceipt: z.strictObject({ jobId: z.uuid(), status: z.enum(["queued", "replacement_queued"]), operationKind: z.enum(["append", "replace_latest"]), replacementTurnId: z.uuid().nullable() })
});

export const generationReviewCheckpointSchema = z.strictObject({
  version: z.literal(1), reviewId: z.uuid(), revision: z.number().int().safe().positive(), state: z.enum(["pending", "decided"]),
  stage: generationReviewStageSchema, candidateScope: z.enum(["main", "final"]), reasons: z.array(generationReviewReasonCodeSchema).min(1).max(20),
  originalCandidate: generationReviewCandidateSchema, gateCandidate: generationReviewCandidateSchema, workingCandidate: generationReviewCandidateSchema,
  originalFindings: z.array(generationReviewReasonCodeSchema).min(1).max(20), originalFindingsHash: hashSchema,
  retryFailure: z.string().trim().min(1).max(500).nullable(), decisionJournal: z.array(generationReviewDecisionJournalEntrySchema).max(100)
}).superRefine((checkpoint, context) => {
  const binding = checkpoint.gateCandidate;
  for (const candidate of [checkpoint.originalCandidate, checkpoint.gateCandidate, checkpoint.workingCandidate]) {
    if (candidate.ownerUserId !== binding.ownerUserId || candidate.campaignId !== binding.campaignId || candidate.worldId !== binding.worldId
      || candidate.worldVersionId !== binding.worldVersionId || candidate.baseTurnNumber !== binding.baseTurnNumber
      || candidate.expectedTurnNumber !== binding.expectedTurnNumber || canonicalEvidenceJson(candidate.baseIdentity) !== canonicalEvidenceJson(binding.baseIdentity)
      || candidate.policyHash !== binding.policyHash || candidate.protocol.version !== binding.protocol.version
      || candidate.protocol.promptHash !== binding.protocol.promptHash || candidate.provider.profileId !== binding.provider.profileId
      || candidate.provider.type !== binding.provider.type || candidate.provider.configurationHash !== binding.provider.configurationHash) {
      context.addIssue({ code: "custom", message: "Review candidates must share one immutable campaign and provider binding." });
      break;
    }
  }
  if (checkpoint.gateCandidate.scope !== checkpoint.candidateScope) context.addIssue({ code: "custom", path: ["gateCandidate", "scope"], message: "The offered candidate scope must match the checkpoint." });
  for (const entry of checkpoint.decisionJournal) {
    if (entry.candidateScope !== entry.offeredCandidate.scope || entry.candidateHash !== entry.offeredCandidate.storyHash
      || entry.offeredReasons.length === 0) {
      context.addIssue({ code: "custom", path: ["decisionJournal"], message: "Decision evidence must bind its historical offered candidate." });
      break;
    }
    const candidate = entry.offeredCandidate;
    if (candidate.ownerUserId !== binding.ownerUserId || candidate.campaignId !== binding.campaignId || candidate.worldId !== binding.worldId
      || candidate.worldVersionId !== binding.worldVersionId || canonicalEvidenceJson(candidate.baseIdentity) !== canonicalEvidenceJson(binding.baseIdentity)
      || candidate.policyHash !== binding.policyHash || candidate.protocol.version !== binding.protocol.version
      || candidate.protocol.promptHash !== binding.protocol.promptHash || candidate.provider.profileId !== binding.provider.profileId
      || candidate.provider.type !== binding.provider.type || candidate.provider.configurationHash !== binding.provider.configurationHash) {
      context.addIssue({ code: "custom", path: ["decisionJournal"], message: "Historical decision evidence must share the checkpoint authority binding." });
      break;
    }
  }
});

export type GenerationReviewCandidate = Readonly<z.infer<typeof generationReviewCandidateSchema>>;
export type GenerationReviewDecisionJournalEntry = Readonly<z.infer<typeof generationReviewDecisionJournalEntrySchema>>;
export type GenerationReviewCheckpoint = Readonly<z.infer<typeof generationReviewCheckpointSchema>>;
