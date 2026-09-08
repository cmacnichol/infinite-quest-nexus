function currentStages(stages) {
  return stages.filter((stage) => !stages.some((other) => other.key === stage.key && other.generation > stage.generation));
}

export function currentSourceWorldStageIds(job) {
  const selectedCharacterFactIds = Array.isArray(job?.source?.selectedCharacterFactIds) ? job.source.selectedCharacterFactIds : [];
  return currentStages(Array.isArray(job?.stages) ? job.stages : [])
    .filter((stage) => stage.key === "source:synthesis" || selectedCharacterFactIds.some((factId) => stage.key === `source:character:${factId}`))
    .map((stage) => stage.id);
}

export function sourceWorldReady(job) {
  if (job?.status !== "awaiting_review" || !job.canApply || !job.result || !Array.isArray(job.source?.selectedCharacterFactIds) || job.source.selectedCharacterFactIds.length === 0) return false;
  const stages = currentStages(Array.isArray(job.stages) ? job.stages : []);
  const synthesis = stages.find((stage) => stage.key === "source:synthesis");
  return synthesis?.status === "validated" && job.source.selectedCharacterFactIds.every((factId) =>
    stages.some((stage) => stage.key === `source:character:${factId}` && stage.status === "validated"));
}
