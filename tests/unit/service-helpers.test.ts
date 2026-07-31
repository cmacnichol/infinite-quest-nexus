import { describe, expect, it } from "vitest";
import { loadOrNotFound } from "../../services/api/src/service-helpers.js";

describe("loadOrNotFound", () => {
  it("returns the scoped query row when it exists", () => {
    const row = { id: "campaign-1" };

    expect(loadOrNotFound({ rows: [row] }, "Campaign")).toBe(row);
  });

  it("preserves the API 404 error contract when a scoped query returns no rows", () => {
    expect.assertions(1);
    try {
      loadOrNotFound({ rows: [] }, "Campaign");
    } catch (error) {
      expect(error).toMatchObject({ message: "Campaign not found.", statusCode: 404 });
    }
  });
});
