const SAFE_ISSUE_CODES = new Set([
  "custom", "missing", "invalid_json", "invalid_type", "too_small", "too_big",
  "invalid_value", "invalid_union", "invalid_format", "unrecognized_keys", "not_multiple_of"
]);
const SAFE_FAILURE_CODES = new Set([
  "invalid_authoring_output", "authoring_output_limit", "authoring_provider_unavailable",
  "authoring_provider_timeout", "authoring_provider_rejected", "authoring_context_exceeded",
  "authoring_conflict", "authoring_expired", "authoring_cancelled", "authoring_retry_exhausted",
  "authoring_apply_unavailable", "source_requires_larger_context", "source_coverage_incomplete",
  "source_evidence_invalid", "choose_source_facts", "source_review_conflict"
]);
const SAFE_JOB_STATUSES = new Set([
  "queued", "running", "awaiting_review", "recoverable", "failed",
  "cancel_requested", "cancelled", "applied", "expired"
]);
const SAFE_STAGE_STATUSES = new Set([
  "queued", "running", "validated", "recoverable", "failed", "cancelled"
]);
const SOURCE_FACT_PATH = /^facts(?:\.\d+(?:\.(?:category|subject|predicate|value|provenance|citations(?:\.\d+(?:\.(?:paragraphId|start|end|quote))?)?))?)?$/u;
const SOURCE_WORLD_PATH = /^(?:fields(?:\.\d+(?:\.(?:path|value|supportingFactIds))?)?|characterFields(?:\.\d+(?:\.(?:selectedCharacterFactId|fields(?:\.\d+(?:\.(?:path|value|supportingFactIds))?)?))?)?|expansionCandidates(?:\.\d+(?:\.(?:target|path|value|supportingFactIds))?)?)$/u;
const SOURCE_SYNTHESIS_STAGE_KEY = /^source:synthesis$/u;
const SOURCE_CHARACTER_STAGE_KEY = /^source:character:/u;
const SOURCE_MESSAGE_CATEGORIES = new Map([
  ["Generated source facts need exact evidence inside the selected source chunk.", "source_evidence"],
  ["Generated source response is not valid JSON.", "source_json_decode"],
  ["Generated source response must contain only a facts list.", "source_envelope"],
  ["Generated source facts do not match the required fields.", "source_schema"],
  ["Generated source citation does not identify a selected source paragraph.", "source_citation_target"],
  ["Generated source citation end must follow its start.", "source_coordinate_order"],
  ["Generated source citation coordinates are outside the selected source chunk.", "source_coordinates"],
  ["Generated source citation quote does not match the selected source text.", "source_quote"],
  ["Generated source citation quote must identify one unique selected passage.", "source_quote_ambiguous"],
  ["Generated source output was truncated before completion.", "source_output_limit"],
  ["Generated source-world response is not valid JSON.", "source_world_json"],
  ["Generated source-world response does not match the required fields.", "source_world_schema"],
  ["Generated source-world field uses an unsupported target.", "source_world_closed_target"],
  ["Generated source-world response assigns a target more than once.", "source_world_duplicate"],
  ["Generated source-world field is not supported by the reviewed facts.", "source_world_unsupported_fact"],
  ["Generated source-world field does not match a selected identity.", "source_world_identity"],
  ["Generated source-world field contains mechanics.", "source_world_mechanics"],
  ["Faithful source-world response cannot contain expansion candidates.", "source_world_faithful_expansion"],
  ["The reviewed source selection is no longer valid.", "source_world_selection"]
]);

const safeIssueCode = (code) => SAFE_ISSUE_CODES.has(code) ? code : "custom";
const safeFailureCode = (code) => SAFE_FAILURE_CODES.has(code) ? code : "unknown";
const safeJobStatus = (status) => SAFE_JOB_STATUSES.has(status) ? status : "unknown";
const safeStageStatus = (status) => SAFE_STAGE_STATUSES.has(status) ? status : "unknown";
const safePath = (path) => typeof path === "string" && (path === "generatedWorld" || SOURCE_FACT_PATH.test(path) || SOURCE_WORLD_PATH.test(path))
  ? path : "generatedWorld";
const safeIssueCategory = (message) => SOURCE_MESSAGE_CATEGORIES.get(message) ?? null;
const safeStageKey = (key) => {
  if (key === "source:plan") return "source:plan";
  if (key.startsWith("source:chunk:")) return "source:chunk";
  if (SOURCE_SYNTHESIS_STAGE_KEY.test(key)) return "source:synthesis";
  if (SOURCE_CHARACTER_STAGE_KEY.test(key)) return "source:character";
  return null;
};

export const currentStages = (job) => {
  const currentByKey = new Map();
  for (const stage of Array.isArray(job?.stages) ? job.stages : []) {
    if (!stage || typeof stage.key !== "string") continue;
    const prior = currentByKey.get(stage.key);
    const generation = Number.isInteger(stage.generation) ? stage.generation : -1;
    const priorGeneration = Number.isInteger(prior?.generation) ? prior.generation : -1;
    if (!prior || generation >= priorGeneration) currentByKey.set(stage.key, stage);
  }
  return [...currentByKey.values()];
};

export const closedCurrentSourceStage = (job) => currentStages(job).find((stage) => (
  safeStageKey(stage.key) && ["recoverable", "failed"].includes(stage.status)
));

const safeJob = (value) => ({
  jobId: typeof value?.id === "string",
  stageCount: Array.isArray(value?.stages) ? value.stages.length : 0,
  status: safeJobStatus(value?.status)
});

export const safeJobSummary = (value) => ({
  ...safeJob(value),
  canApply: value?.canApply === true,
  hasResult: value?.result !== undefined && value?.result !== null
});

export const renderedClosedJobStatus = (value) => {
  const status = safeJobStatus(value?.status);
  return status === "recoverable" || status === "failed" ? `is ${status} · idle.` : null;
};

export const safeClosedStage = (job, stage) => ({
  boundary: "source-stage-closed",
  job: safeJob(job),
  stage: {
    key: safeStageKey(stage.key) ?? "source:plan",
    generation: stage.generation,
    status: safeStageStatus(stage.status),
    attemptCount: stage.attemptCount,
    failureCode: safeFailureCode(stage.failure?.code),
    retryable: stage.failure?.retryable === true,
    issues: Array.isArray(stage.failure?.issues) ? stage.failure.issues.slice(0, 8).map((issue) => ({
      code: safeIssueCode(issue?.code),
      path: safePath(issue?.path),
      category: safeIssueCategory(issue?.message)
    })) : []
  }
});
