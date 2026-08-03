import {
  generationJobSnapshotSchema,
  generationStreamSnapshotSchema,
  turnListResponseSchema
} from "../packages/contracts/src/client-api.js";

const WARM_UP_SAMPLES = 5;
const MEASURED_SAMPLES = 30;
const TURN_COUNT = 2_000;
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const TURN_ID = "55555555-5555-4555-8555-555555555555";
const TIMESTAMP = "2026-08-01T12:00:00.000Z";
const STREAM_ALLOWLIST = [
  "id",
  "campaignId",
  "expectedTurnNumber",
  "status",
  "action",
  "operationKind",
  "replacementTurnId",
  "attempts",
  "partialNarration",
  "errorMessage",
  "errorCode",
  "resultTurnId"
] as const;

function percentile(values: number[], percentileValue: number): number {
  const index = Math.ceil((values.length - 1) * percentileValue);
  return values.toSorted((left, right) => left - right)[index] ?? 0;
}

function measure(operation: () => void): { p50Ms: number; p95Ms: number } {
  for (let index = 0; index < WARM_UP_SAMPLES; index += 1) operation();
  const samples = Array.from({ length: MEASURED_SAMPLES }, () => {
    const startedAt = process.hrtime.bigint();
    operation();
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  });
  return { p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
}

function emittedFrameCount<T>(snapshots: readonly T[], projection: (snapshot: T) => unknown): number {
  let lastFrame = "";
  return snapshots.reduce((count, snapshot) => {
    const frame = JSON.stringify(projection(snapshot));
    if (frame === lastFrame) return count;
    lastFrame = frame;
    return count + 1;
  }, 0);
}

const turn = {
  id: TURN_ID,
  turnNumber: 1,
  action: "Open the dome.",
  inputMode: "action",
  inputModeSource: "explicit",
  narration: "Emerald light fills the observatory.",
  choices: ["Look up.", "Step back.", "Call out.", "Close it."],
  customActionSuggestion: "Study the constellations.",
  imagePrompt: "An emerald observatory.",
  imageUrl: null,
  acceptedAt: TIMESTAMP,
  reportedCost: null
};
const turns = Array.from({ length: TURN_COUNT }, (_, index) => ({
  ...turn,
  id: `${index.toString(16).padStart(8, "0")}-5555-4555-8555-555555555555`,
  turnNumber: index + 1
}));
const generationJob = {
  id: JOB_ID,
  campaignId: CAMPAIGN_ID,
  expectedTurnNumber: TURN_COUNT + 1,
  action: "Open the dome.",
  requestedInputMode: "action",
  resolvedInputMode: "action",
  inputModeSource: "explicit",
  operationKind: "append",
  replacementTurnId: null,
  status: "generating",
  attempts: 1,
  resultTurnId: null,
  errorCode: null,
  errorMessage: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  partialOutput: "raw provider payload",
  partialNarration: "Emerald light spills across the floor."
} as const;
const pollingSnapshot = generationJobSnapshotSchema.parse(generationJob);
const streamSnapshot = generationStreamSnapshotSchema.parse(generationJob);
if (JSON.stringify(Object.keys(streamSnapshot).toSorted()) !== JSON.stringify([...STREAM_ALLOWLIST].toSorted())) {
  throw new Error("Generation stream snapshot allowlist drifted from the Task 7P benchmark contract.");
}
const legacyStreamSnapshot = {
  id: generationJob.id,
  status: generationJob.status,
  action: generationJob.action,
  partialOutput: generationJob.partialOutput,
  partialNarration: generationJob.partialNarration,
  errorMessage: generationJob.errorMessage,
  errorCode: generationJob.errorCode
};
const generationSequence = [
  generationJob,
  { ...generationJob, updatedAt: "2026-08-01T12:00:05.000Z" },
  {
    ...generationJob,
    status: "completed",
    resultTurnId: TURN_ID,
    updatedAt: "2026-08-01T12:00:10.000Z",
    completedAt: "2026-08-01T12:00:10.000Z"
  }
] as const;
const legacyStreamProjection = (job: typeof generationJob) => ({
  id: job.id,
  status: job.status,
  action: job.action,
  partialOutput: job.partialOutput,
  partialNarration: job.partialNarration,
  errorMessage: job.errorMessage,
  errorCode: job.errorCode
});

process.stdout.write(`${JSON.stringify({
  command: "pnpm exec tsx scripts/benchmark-client-contracts.ts",
  fixture: { turns: TURN_COUNT, warmUpSamples: WARM_UP_SAMPLES, measuredSamples: MEASURED_SAMPLES },
  turnListValidation: measure(() => { turnListResponseSchema.parse({ campaignId: CAMPAIGN_ID, turns, nextCursor: null }); }),
  payloadBytes: {
    preC1HandBuilt: Buffer.byteLength(JSON.stringify(legacyStreamSnapshot)),
    c1Stream: Buffer.byteLength(JSON.stringify(pollingSnapshot)),
    task2aStream: Buffer.byteLength(JSON.stringify(streamSnapshot))
  },
  streamAllowlist: STREAM_ALLOWLIST,
  framesPerGeneration: {
    sequence: "initial -> lease renewal only -> completed",
    preC1HandBuilt: emittedFrameCount(generationSequence, legacyStreamProjection),
    c1Stream: emittedFrameCount(generationSequence, generationJobSnapshotSchema.parse),
    task2aStream: emittedFrameCount(generationSequence, generationStreamSnapshotSchema.parse)
  },
  leaseOnlySnapshotChangesFrame: JSON.stringify(streamSnapshot) !== JSON.stringify(generationStreamSnapshotSchema.parse(generationSequence[1])),
  pollingPayloadBytes: Buffer.byteLength(JSON.stringify(pollingSnapshot))
}, null, 2)}\n`);
