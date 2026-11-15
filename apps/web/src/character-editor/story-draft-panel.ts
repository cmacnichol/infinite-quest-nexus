import { SUPPORTING_FIELDS } from "@infinite-quest/client-core";
import type { CampaignCastApi } from "@infinite-quest/client-web";
import type { CastDetail } from "@infinite-quest/contracts";
import type { createStoryDraftReview } from "./story-draft.js";

export function renderStoryDraftPanel(form: HTMLElement, options: {
  detail: CastDetail; readonly: boolean; draftPreview: CampaignCastApi["draftPreview"] | undefined; campaign: string;
  review: ReturnType<typeof createStoryDraftReview>;
  current(path: string): string | string[] | undefined; apply(path: string, value: string | string[]): void; changed(): void;
  label?(path: string): string; fetch?(direction: string): ReturnType<NonNullable<CampaignCastApi["draftPreview"]>>; turn?(turn: number): void;
}): void {
  const { detail, review } = options;
  review.render(form, {
    eligible: Boolean(options.draftPreview && detail.draftFromStoryEligible), locked: options.readonly,
    value(path) { const value = options.current(path); return Array.isArray(value) ? value.join("\n") : value; },
    label: path => options.label?.(path) ?? SUPPORTING_FIELDS.find(field => field.path === path)?.label ?? path,
    fetch: options.fetch ?? (direction => options.draftPreview!(options.campaign, detail.character.id, { expectedCastRevision: detail.revision, expectedBoundary: detail.boundary, expectedCharacterRevision: detail.character.revision, ...(direction ? { direction } : {}) })),
    apply: options.apply, turn: options.turn ?? (() => {}), refresh: options.changed
  });
}
