import { describe, expect, it } from "vitest";
import { buildReviewQueue } from "../../packages/client-web/src/cast-review-queue.js";

describe("character review queue", () => {
  it("groups repeated details by character and field while placing identities first", () => {
    const candidate = (id: string, turnNumber: number) => ({ id, resolvedCharacterId: "person", proposal: { name: "Ada" }, source: { turnNumber }, details: [{ observationIndex: 0, field: "story.role", value: "captain", quote: id }] });
    const identity = { id: "match", proposal: { name: "Ada" }, source: { turnNumber: 3 } };
    const queue = buildReviewQueue([identity] as never, [candidate("one", 1), candidate("two", 2)] as never);
    expect(queue.map(item => item.kind)).toEqual(["identity", "detail"]);
    const detail = queue[1]!;
    expect(detail.kind === "detail" && detail.entries.map(entry => entry.candidate.id)).toEqual(["one", "two"]);
  });
});
