export const LEGACY_MIGRATION_ALLOWLIST = Object.freeze([
  "apps/web/public/nexus.js",
  "packages/contracts/src/imports.ts",
  "packages/domain/src/infinite-worlds.ts",
  "packages/domain/src/legacy-campaign-normalization.ts",
  "packages/domain/src/legacy-story-world.ts",
  "services/api/src/archive-routes.ts",
  "services/api/src/server.ts",
  "packages/database/src/portable-import-family-repository.ts",
  "services/runtime/src/portable-import-export-composition.ts"
]);

const activeCode = /^(?:apps|packages|services)\//u;
const legacyMigrationMarker = /infiniteQuestNexusClientState\.v1|\/imports\/legacy-story|\bLegacyStory\b|\blegacyStorySchema\b/u;

export function legacyMigrationBoundaryViolations(file, text) {
  const normalized = file.replaceAll("\\", "/");
  return activeCode.test(normalized)
    && legacyMigrationMarker.test(text)
    && !LEGACY_MIGRATION_ALLOWLIST.includes(normalized)
    ? [`${normalized}: legacy client compatibility must remain inside the reviewed migration boundary`]
    : [];
}
