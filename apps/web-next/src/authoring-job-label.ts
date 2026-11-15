export function authoringJobLabel(job: { status: string; target: { kind: "new_world" } | { kind: "world_draft"; characterId?: string }; expiresAt: string | Date }, locale?: string): string {
  const kind = job.target.kind === "world_draft" && job.target.characterId ? "Edit existing character" : "New character";
  if (job.expiresAt instanceof Date && !Number.isFinite(job.expiresAt.getTime())) throw new Error("Invalid proposal expiration timestamp.");
  const expiresAt = job.expiresAt instanceof Date ? job.expiresAt.toISOString() : job.expiresAt;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(expiresAt);
  const timestamp = Date.parse(expiresAt);
  if (!match || !Number.isFinite(timestamp)) throw new Error("Invalid proposal expiration timestamp.");
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (calendarDate.getUTCFullYear() !== Number(match[1]) || calendarDate.getUTCMonth() !== Number(match[2]) - 1 || calendarDate.getUTCDate() !== Number(match[3])) throw new Error("Invalid proposal expiration timestamp.");
  const date = new Intl.DateTimeFormat(locale).format(timestamp);
  return `${kind} · ${job.status.replaceAll("_", " ")} · expires ${date}`;
}
