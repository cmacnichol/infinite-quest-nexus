import { projectAuthoringFailure as projectDomainFailure } from "../../packages/domain/src/authoring-output.js";
import { describe, expect, it } from "vitest";
import { authoringFailureText, parseAuthoringFailure } from "../../apps/web-next/src/authoring-errors.js";

describe("authoring error presentation", () => {
  it("keeps the validated character issue and correlation identifier", () => {
    const failure = parseAuthoringFailure({
      code: "invalid_authoring_output", stage: "character", retryable: true,
      issues: [{ path: "profile.story.background", code: "missing", message: "Character background is required." }],
      correlationId: "fixture-correlation"
    });
    expect(failure).not.toBeNull();
    const message = authoringFailureText(failure!);
    expect(message).toContain("background");
    expect(message).toContain("fixture-correlation");
  });

  it("projects schema-valid provider issue text to a closed authoring message", () => {
    const marker = "PRIVATE_PROVIDER_URL=https://provider.example/v1?key=secret";
    const failure = parseAuthoringFailure({
      code: "invalid_authoring_output", stage: "character", retryable: true,
      issues: [{ path: `profile.story.background.${marker}`, code: marker, message: marker }]
    });

    expect(failure).not.toBeNull();
    const message = authoringFailureText(failure!);
    expect(message).toContain("Generated character profile is incomplete or contains mechanics language.");
    expect(JSON.stringify({ failure, message })).not.toContain(marker);
  });
});

it.each(["Generated fictional content contains mechanics language.", "Organizer evidence does not support a populated profile field.", "Generated character ID must match the supplied seed."])("preserves trusted reason through domain and browser: %s", (message) => {
  const projected = projectDomainFailure({ code: "invalid_authoring_output", stage: "character", retryable: true, issues: [{ path: "profile.story.role", code: "custom", message }] });
  expect(parseAuthoringFailure(projected)?.issues[0]?.message).toBe(message);
});
it.each([["character", "generatedCharacter"], ["organizer", "profile"]] as const)("uses %s stage fallback across boundaries", (stage, expected) => {
  const projected = projectDomainFailure({ code: "invalid_authoring_output", stage, retryable: true, issues: [{ path: "SYNTHETIC_SECRET", code: "custom", message: "SYNTHETIC_SECRET" }] });
  expect(parseAuthoringFailure(projected)?.issues[0]?.path).toBe(expected);
});
