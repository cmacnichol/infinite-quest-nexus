import type { CastCommand } from "../../contracts/src/campaign-cast.js";

/** Events must be retained, boundary-filtered, and in journal order. */
export function activeRetractedObservationIds(events: readonly { id: string; payload: readonly { command: CastCommand }[] }[]): ReadonlySet<string> {
  const active = new Map<string, string>();
  for (const event of events) for (const { command } of event.payload) {
    if (command.kind === "retract_observation") active.set(command.observationId, event.id);
    if (command.kind === "restore_observation" && active.get(command.observationId) === command.retractionEventId) active.delete(command.observationId);
  }
  return new Set(active.keys());
}
