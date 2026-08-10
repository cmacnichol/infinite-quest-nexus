import { createHash, randomUUID } from "node:crypto";
import type { WorldImportRequest } from "../../../packages/contracts/src/world-library.js";
import type { PortableImportExportComposition } from "../../../packages/application/src/imports/private-portable-composition.js";
import type {
  ImportOwnerScope,
  PortableImportCommitView,
  PortableImportPreviewCommand,
  PortableImportPreviewView,
  PortableStagedInput,
} from "../../../packages/application/src/imports/types.js";

type PortableWorldJsonRoutePort = Pick<PortableImportExportComposition,
  "stageInput" | "previewWorldJson" | "commit">;
type WorldJsonPreviewCommand = Extract<PortableImportPreviewCommand, { kind: "world_json" }>;
type WorldJsonPreviewView = PortableImportPreviewView<WorldJsonPreviewCommand>;

type PortableWorldJsonRouteInput = Readonly<{
  portable: PortableWorldJsonRoutePort;
  owner: ImportOwnerScope;
  request: WorldImportRequest;
  leaseOwner: string;
}>;

function encodedWorld(request: WorldImportRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request.worldExport));
}

async function stageWorldJson(input: PortableWorldJsonRouteInput): Promise<PortableStagedInput> {
  const bytes = encodedWorld(input.request);
  const staged = await input.portable.stageInput({
    owner: input.owner,
    operationScopeId: `world-json-preview-${randomUUID()}`,
    leaseOwner: input.leaseOwner,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    byteLength: bytes.byteLength,
    source: [bytes],
  });
  return staged.stagedInput;
}

async function preview(input: PortableWorldJsonRouteInput): Promise<WorldJsonPreviewView> {
  const stagedInput = await stageWorldJson(input);
  return input.portable.previewWorldJson({
    ownerUserId: input.owner.ownerUserId,
    stagedInput,
    kind: "world_json",
    destination: { kind: "create_world" },
    sourceName: input.request.sourceName,
  });
}

export function previewPortableWorldJson(
  input: PortableWorldJsonRouteInput,
): Promise<WorldJsonPreviewView> {
  return preview(input);
}

export async function importPortableWorldJson(
  input: PortableWorldJsonRouteInput,
): Promise<PortableImportCommitView<"world_json">> {
  const prepared = await preview(input);
  const contentFingerprint = createHash("sha256")
    .update(JSON.stringify({ sourceName: input.request.sourceName, worldExport: input.request.worldExport }))
    .digest("hex");
  const idempotencyKey = `world-json:${contentFingerprint}:${prepared.previewHandle.token}`;
  return input.portable.commit({
    ownerUserId: input.owner.ownerUserId,
    kind: "world_json",
    destination: prepared.destination,
    previewHandle: prepared.previewHandle,
    idempotencyKey,
  }) as Promise<PortableImportCommitView<"world_json">>;
}
