import { createHash, randomUUID } from "node:crypto";
import type { StoryImportRequest } from "../../../packages/contracts/src/imports.js";
import type {
  PortableImportExportComposition,
  PrivatePortableImportArtifacts,
} from "../../../packages/application/src/imports/private-portable-composition.js";
import type {
  ImportOwnerScope,
  PortableImportCommitView,
  PortableImportPreviewCommand,
  PortableImportPreviewView,
  PortableStagedInput,
} from "../../../packages/application/src/imports/types.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";

type PortableLegacyStoryRoutePort = Pick<PortableImportExportComposition,
  "stageInput" | "previewLegacyStory" | "commit">;
type LegacyStoryPreviewCommand = Extract<PortableImportPreviewCommand, { kind: "legacy_story" }>;
type LegacyStoryPreviewView = PortableImportPreviewView<LegacyStoryPreviewCommand>;

type PortableLegacyStoryRouteInput = Readonly<{
  portable: PortableLegacyStoryRoutePort;
  pool: DatabasePool;
  owner: ImportOwnerScope;
  request: StoryImportRequest;
  leaseOwner: string;
  artifacts?: PrivatePortableImportArtifacts;
}>;

async function destination(input: PortableLegacyStoryRouteInput): Promise<LegacyStoryPreviewCommand["destination"]> {
  if (input.request.targetWorldVersionId === undefined) return { kind: "create_world" };
  const result = await input.pool.query<{ world_id: string }>(
    `SELECT world_id
       FROM world_versions
      WHERE id = $1 AND owner_user_id = $2`,
    [input.request.targetWorldVersionId, input.owner.ownerUserId],
  );
  const target = result.rows[0];
  if (target === undefined) {
    throw Object.assign(new Error("The selected target world version was not found."), { statusCode: 404, expose: true });
  }
  return {
    kind: "existing_world_version",
    worldId: target.world_id,
    worldVersionId: input.request.targetWorldVersionId,
  };
}

async function stage(input: PortableLegacyStoryRouteInput): Promise<PortableStagedInput> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.request.story));
  const staged = await input.portable.stageInput({
    owner: input.owner,
    operationScopeId: `legacy-story-preview-${randomUUID()}`,
    leaseOwner: input.leaseOwner,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    byteLength: bytes.byteLength,
    source: [bytes],
  });
  return staged.stagedInput;
}

async function preview(input: PortableLegacyStoryRouteInput): Promise<LegacyStoryPreviewView> {
  const [stagedInput, target] = await Promise.all([stage(input), destination(input)]);
  const command: LegacyStoryPreviewCommand = {
    ownerUserId: input.owner.ownerUserId,
    stagedInput,
    kind: "legacy_story",
    destination: target,
    sourceName: input.request.sourceName,
    ...(input.request.selectedCharacterId === undefined ? {} : { selectedCharacterId: input.request.selectedCharacterId }),
    ...(input.request.characterStrategy === undefined ? {} : { characterStrategy: input.request.characterStrategy }),
  };
  return input.artifacts === undefined
    ? input.portable.previewLegacyStory(command)
    : input.portable.previewLegacyStory(command, input.artifacts);
}

export function previewPortableLegacyStory(
  input: PortableLegacyStoryRouteInput,
): Promise<LegacyStoryPreviewView> {
  return preview(input);
}

export async function importPortableLegacyStory(
  input: PortableLegacyStoryRouteInput,
): Promise<PortableImportCommitView<"legacy_story">> {
  const prepared = await preview(input);
  const contentFingerprint = createHash("sha256")
    .update(JSON.stringify(input.request))
    .digest("hex");
  const idempotencyKey = `legacy-story:${contentFingerprint}:${prepared.previewHandle.token}`;
  const command = {
    ownerUserId: input.owner.ownerUserId,
    kind: "legacy_story",
    destination: prepared.destination,
    previewHandle: prepared.previewHandle,
    idempotencyKey,
  } as const;
  return (input.artifacts === undefined
    ? input.portable.commit(command)
    : input.portable.commit(command, input.artifacts)) as Promise<PortableImportCommitView<"legacy_story">>;
}
