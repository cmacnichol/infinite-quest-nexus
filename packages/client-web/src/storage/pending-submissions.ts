import type {
  PendingSubmissionStore,
  StoredGenerationSubmission
} from "@infinite-quest/client-core";
import {
  generationRequestSchema,
  generationRetryLatestRequestSchema
} from "@infinite-quest/contracts";
import { z } from "zod";

export interface PendingSubmissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const commonSubmissionFields = {
  expectedTurnNumber: z.number().int().min(1),
  createdAt: z.number().finite().nonnegative()
};

const appendSubmissionSchema = z.object({
  operationKind: z.literal("append"),
  request: generationRequestSchema,
  ...commonSubmissionFields,
  jobId: z.uuid().optional()
}).strict();

const replacementSubmissionSchema = z.object({
  operationKind: z.literal("replace_latest"),
  request: generationRetryLatestRequestSchema,
  ...commonSubmissionFields,
  jobId: z.uuid().optional(),
  replacementTurnId: z.uuid().optional()
}).strict().refine(
  (value) => value.request.expectedCurrentTurnNumber === value.expectedTurnNumber,
  { message: "Replacement turn numbers must match." }
).refine(
  (value) => (value.jobId === undefined) === (value.replacementTurnId === undefined),
  { message: "Durable replacement jobs must retain their validated replacement target." }
);

const storedSubmissionSchema = z.discriminatedUnion("operationKind", [
  appendSubmissionSchema,
  replacementSubmissionSchema
]);

const v2EnvelopeSchema = z.object({
  version: z.literal(2),
  submission: storedSubmissionSchema
}).strict();

const legacySubmissionSchema = z.object({
  action: generationRequestSchema.shape.action,
  requestedInputMode: generationRequestSchema.shape.requestedInputMode.optional(),
  resolvedInputMode: generationRequestSchema.shape.resolvedInputMode.optional(),
  inputModeSource: generationRequestSchema.shape.inputModeSource.optional(),
  classificationId: generationRequestSchema.shape.classificationId,
  providerProfileId: generationRequestSchema.shape.providerProfileId,
  model: generationRequestSchema.shape.model,
  idempotencyKey: generationRequestSchema.shape.idempotencyKey,
  context: generationRequestSchema.shape.context.optional(),
  operationKind: z.enum(["append", "replace_latest"]),
  expectedTurnNumber: z.number().int().min(1),
  createdAt: z.number().finite().nonnegative()
}).strict();

export function createPendingSubmissionStore(
  storage: PendingSubmissionStorage
): PendingSubmissionStore {
  return {
    load(campaignId) {
      const currentKey = v2Key(campaignId);
      const currentRaw = read(storage, currentKey);
      if (currentRaw.kind === "inaccessible") return null;
      if (currentRaw.value !== null) {
        const json = parseJson(currentRaw.value);
        if (json.kind === "invalid") {
          removeBestEffort(storage, currentKey);
          return null;
        }
        const envelope = v2EnvelopeSchema.safeParse(json.value);
        if (envelope.success) return normalizeSubmission(envelope.data.submission);

        const unversioned = storedSubmissionSchema.safeParse(json.value);
        if (!unversioned.success) {
          removeBestEffort(storage, currentKey);
          return null;
        }
        const normalized = normalizeSubmission(unversioned.data);
        writeBestEffort(storage, currentKey, envelopeJson(normalized));
        return normalized;
      }

      const oldKey = legacyKey(campaignId);
      const legacyRaw = read(storage, oldKey);
      if (legacyRaw.kind === "inaccessible" || legacyRaw.value === null) return null;
      const legacyJson = parseJson(legacyRaw.value);
      if (legacyJson.kind === "invalid") {
        removeBestEffort(storage, oldKey);
        return null;
      }
      const legacy = legacySubmissionSchema.safeParse(legacyJson.value);
      if (!legacy.success) {
        removeBestEffort(storage, oldKey);
        return null;
      }
      const converted = convertLegacy(legacy.data);
      const parsed = storedSubmissionSchema.safeParse(converted);
      if (!parsed.success) {
        removeBestEffort(storage, oldKey);
        return null;
      }
      const normalized = normalizeSubmission(parsed.data);
      if (writeBestEffort(storage, currentKey, envelopeJson(normalized))) {
        removeBestEffort(storage, oldKey);
      }
      return normalized;
    },
    save(campaignId, submission) {
      const parsed = normalizeSubmission(storedSubmissionSchema.parse(submission));
      storage.setItem(v2Key(campaignId), envelopeJson(parsed));
    },
    clear(campaignId) {
      removeBestEffort(storage, v2Key(campaignId));
      removeBestEffort(storage, legacyKey(campaignId));
    }
  };
}

function v2Key(campaignId: string): string {
  return `infiniteQuestPendingGeneration:v2:${encodeURIComponent(campaignId)}`;
}

function legacyKey(campaignId: string): string {
  return `infiniteQuestPendingGeneration:${campaignId}`;
}

function read(
  storage: PendingSubmissionStorage,
  key: string
): { kind: "read"; value: string | null } | { kind: "inaccessible" } {
  try {
    return { kind: "read", value: storage.getItem(key) };
  } catch {
    return { kind: "inaccessible" };
  }
}

function parseJson(raw: string): { kind: "parsed"; value: unknown } | { kind: "invalid" } {
  try {
    return { kind: "parsed", value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function envelopeJson(submission: StoredGenerationSubmission): string {
  return JSON.stringify({ version: 2, submission });
}

function normalizeSubmission(
  submission: z.infer<typeof storedSubmissionSchema>
): StoredGenerationSubmission {
  const job = submission.jobId === undefined ? {} : { jobId: submission.jobId };
  if (submission.operationKind === "append") {
    return {
      operationKind: "append",
      request: submission.request,
      expectedTurnNumber: submission.expectedTurnNumber,
      createdAt: submission.createdAt,
      ...job
    };
  }
  if (submission.jobId === undefined) {
    return {
      operationKind: "replace_latest",
      request: submission.request,
      expectedTurnNumber: submission.expectedTurnNumber,
      createdAt: submission.createdAt
    };
  }
  if (submission.replacementTurnId === undefined) {
    throw new Error("Stored replacement job is missing its validated target.");
  }
  return {
    operationKind: "replace_latest",
    request: submission.request,
    expectedTurnNumber: submission.expectedTurnNumber,
    createdAt: submission.createdAt,
    jobId: submission.jobId,
    replacementTurnId: submission.replacementTurnId
  };
}

function writeBestEffort(
  storage: PendingSubmissionStorage,
  key: string,
  value: string
): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeBestEffort(storage: PendingSubmissionStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Cleanup must not relabel a completed workflow as failed.
  }
}

function convertLegacy(
  legacy: z.infer<typeof legacySubmissionSchema>
): StoredGenerationSubmission {
  const request = {
    action: legacy.action,
    ...(legacy.requestedInputMode === undefined ? {} : { requestedInputMode: legacy.requestedInputMode }),
    ...(legacy.resolvedInputMode === undefined ? {} : { resolvedInputMode: legacy.resolvedInputMode }),
    ...(legacy.inputModeSource === undefined ? {} : { inputModeSource: legacy.inputModeSource }),
    ...(legacy.classificationId === undefined ? {} : { classificationId: legacy.classificationId }),
    ...(legacy.providerProfileId === undefined ? {} : { providerProfileId: legacy.providerProfileId }),
    ...(legacy.model === undefined ? {} : { model: legacy.model }),
    idempotencyKey: legacy.idempotencyKey,
    ...(legacy.context === undefined ? {} : { context: legacy.context })
  };

  if (legacy.operationKind === "append") {
    return {
      operationKind: "append",
      expectedTurnNumber: legacy.expectedTurnNumber,
      createdAt: legacy.createdAt,
      request: generationRequestSchema.parse(request)
    };
  }
  return {
    operationKind: "replace_latest",
    expectedTurnNumber: legacy.expectedTurnNumber,
    createdAt: legacy.createdAt,
    request: generationRetryLatestRequestSchema.parse({
      ...request,
      expectedCurrentTurnNumber: legacy.expectedTurnNumber
    })
  };
}
