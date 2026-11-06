import { castAttachmentSchema, type CastAttachment, type CastCommand } from "../../contracts/src/campaign-cast.js";

export type CastAttachmentEvent = { id: string; effective_turn_number: number; attachment?: CastAttachment | null | undefined;
  payload: readonly { command: CastCommand }[] };

/** Project only detach decisions retained at the requested history boundary. */
export function projectCastAttachments(events: readonly CastAttachmentEvent[], boundary: number): {
  active: CastAttachment[]; detached: CastAttachment[]; suppressedObservationIds: Set<string>; detachedEventIds: Set<string>;
} {
  const attachments = new Map<string, CastAttachment>();
  const detachedEventIds = new Set<string>();
  for (const event of events) {
    if (event.effective_turn_number > boundary) continue;
    if (event.attachment) attachments.set(event.id, castAttachmentSchema.parse(event.attachment));
    for (const { command } of event.payload) if (command.kind === "detach" && attachments.has(command.eventId)) detachedEventIds.add(command.eventId);
  }
  const active: CastAttachment[] = [], detached: CastAttachment[] = [], suppressedObservationIds = new Set<string>();
  for (const attachment of attachments.values()) {
    if (detachedEventIds.has(attachment.eventId)) {
      detached.push(attachment);
      attachment.observationIds.forEach((id) => suppressedObservationIds.add(id));
    } else active.push(attachment);
  }
  return { active, detached, suppressedObservationIds, detachedEventIds };
}

export function castRangesOverlap(a: CastAttachment["sourceRanges"][number], b: CastAttachment["sourceRanges"][number]): boolean {
  return a.turnId === b.turnId && a.narrationRevision === b.narrationRevision && a.sourceHash === b.sourceHash
    && a.paragraphId === b.paragraphId && a.start < b.end && b.start < a.end;
}
