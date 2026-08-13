import { createHash, randomUUID } from "node:crypto";
import type { InfiniteWorldsImportRequest } from "../../../packages/contracts/src/imports.js";
import { worldContentSchema, type WorldContent } from "../../../packages/contracts/src/world-library.js";
import {
  convertInfiniteWorldsWorld,
  extractCyoaLayers,
  infiniteWorldsCharacters,
  parseCyoaExport,
  parseInfiniteWorldsStory,
  resolvePlayableCharacters,
} from "../../../packages/domain/src/index.js";
import type { ImportProgressStorePort } from "../../../packages/application/src/imports/progress.js";
import type { PortableImportExportComposition } from "../../../packages/application/src/imports/private-portable-composition.js";
import type {
  ImportOwnerScope,
  PortableImportPreviewCommand,
  PortableStagedInput,
} from "../../../packages/application/src/imports/types.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";

type InfiniteWorldsRoutePort = Pick<PortableImportExportComposition,
  "stageInput" | "previewInfiniteWorlds" | "previewCyoa" | "previewWorldText" | "previewStoryText" | "commit">;
type CyoaCommand = Extract<PortableImportPreviewCommand, { kind: "cyoa" }>;
type WorldTextCommand = Extract<PortableImportPreviewCommand, { kind: "world_text" }>;
type StoryTextCommand = Extract<PortableImportPreviewCommand, { kind: "story_text" }>;
type ResolvedKind = "cyoa_json" | "world_json" | "world_text" | "story_text";

type InfiniteWorldsRouteInput = Readonly<{
  portable: InfiniteWorldsRoutePort;
  pool: DatabasePool;
  owner: ImportOwnerScope;
  request: InfiniteWorldsImportRequest;
  leaseOwner: string;
}>;

type InfiniteWorldsImportRouteInput = InfiniteWorldsRouteInput & Readonly<{
  progress: ImportProgressStorePort;
  diagnoseWorldGenerationFailure(error: unknown): Readonly<{ message: string }>;
}>;

const INVALID_CYOA_MESSAGE = "The selected file is not a supported Choose Your Own Adventure JSON export.";

function parseJsonText(source: string): unknown {
  let value = source.trim().replace(/^\uFEFF/u, "");
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1]) value = fenced[1].trim();
  return JSON.parse(value);
}

function resolvedKind(request: InfiniteWorldsImportRequest): ResolvedKind {
  if (request.sourceKind !== "auto") return request.sourceKind;
  if (/--\s*Turn\s+\d+\s*--/iu.test(request.sourceText)) return "story_text";
  try {
    const parsed = parseJsonText(request.sourceText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && "chapters" in parsed && "info" in parsed) return "cyoa_json";
    return infiniteWorldsCharacters(parsed).length > 0 ? "world_json" : "world_text";
  } catch {
    return "world_text";
  }
}

function providerSelection(request: InfiniteWorldsImportRequest) {
  return request.providerProfileId === undefined ? undefined : {
    providerProfileId: request.providerProfileId,
    ...(request.model === undefined ? {} : { model: request.model }),
  };
}

function progressKey(request: InfiniteWorldsImportRequest): string {
  return `${request.sourceName}:${request.sourceText.length}`;
}

async function stageSource(input: InfiniteWorldsRouteInput): Promise<PortableStagedInput> {
  const bytes = new TextEncoder().encode(input.request.sourceText);
  const staged = await input.portable.stageInput({
    owner: input.owner,
    operationScopeId: `infinite-worlds-${randomUUID()}`,
    leaseOwner: input.leaseOwner,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    byteLength: bytes.byteLength,
    source: [bytes],
  });
  return staged.stagedInput;
}

async function targetWorld(input: InfiniteWorldsRouteInput): Promise<Readonly<{
  worldId: string;
  worldVersionId: string;
  content: WorldContent;
}>> {
  if (input.request.targetWorldVersionId === undefined) {
    throw Object.assign(new Error("Select a published target world before importing matching story text."), {
      statusCode: 400,
      expose: true,
    });
  }
  const result = await input.pool.query<{ world_id: string; content: unknown }>(
    `SELECT world_id, content
       FROM world_versions
      WHERE id = $1 AND owner_user_id = $2`,
    [input.request.targetWorldVersionId, input.owner.ownerUserId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw Object.assign(new Error("Select a published target world before importing matching story text."), {
      statusCode: 400,
      expose: true,
    });
  }
  return {
    worldId: row.world_id,
    worldVersionId: input.request.targetWorldVersionId,
    content: worldContentSchema.parse(row.content),
  };
}

function selectedStoryCharacterId(
  content: WorldContent,
  sourceText: string,
  requestedId?: string,
): string | undefined {
  const characters = resolvePlayableCharacters(content);
  if (requestedId !== undefined) {
    return characters.some((character) => character.id === requestedId) ? requestedId : undefined;
  }
  if (characters.length === 1) return characters[0]?.id;
  const parsed = parseInfiniteWorldsStory(sourceText);
  const firstLine = parsed.characterText.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.toLocaleLowerCase() ?? "";
  const exact = characters.filter((character) => character.name.trim().toLocaleLowerCase() === firstLine);
  return exact.length === 1 ? exact[0]?.id : undefined;
}

function cyoaPublicPreview(request: InfiniteWorldsImportRequest) {
  try {
    const parsed = parseCyoaExport(request.sourceText);
    const extracted = extractCyoaLayers(parsed, request.sourceName);
    const valid = request.providerProfileId !== undefined;
    return {
      kind: "cyoa_json" as const,
      valid,
      requiresProvider: true as const,
      warnings: valid ? [] : ["Select a text provider before importing this Choose Your Own Adventure story export."],
      counts: {
        topLevelTitle: extracted.title,
        layer1ChaptersCount: Math.max(0, extracted.excerpts.length - 1),
        characterTarget: "3-4 playable characters",
      },
    };
  } catch {
    return {
      kind: "cyoa_json" as const,
      valid: false as const,
      requiresProvider: true as const,
      warnings: [INVALID_CYOA_MESSAGE],
      counts: { topLevelTitle: "Unknown", layer1ChaptersCount: 0, characterTarget: "3-4 playable characters" },
    };
  }
}

export async function previewPortableInfiniteWorlds(input: InfiniteWorldsRouteInput) {
  const kind = resolvedKind(input.request);
  if (kind === "cyoa_json") return cyoaPublicPreview(input.request);
  if (kind === "world_text") {
    const valid = input.request.providerProfileId !== undefined;
    return {
      kind,
      valid,
      requiresProvider: true as const,
      warnings: valid
        ? ["World text conversion uses the selected text provider during import."]
        : ["Select a text provider before importing this world TXT export."],
      counts: {
        sourceCharacters: input.request.sourceText.length,
        sourceWords: input.request.sourceText.trim().split(/\s+/u).filter(Boolean).length,
      },
    };
  }
  if (kind === "world_json") {
    const source = parseJsonText(input.request.sourceText);
    const characters = infiniteWorldsCharacters(source)
      .map((character, index) => ({ index, name: String(character.name || `Character ${index + 1}`) }));
    if (characters.length === 0) {
      return {
        kind,
        valid: false as const,
        duplicate: false,
        existingWorldId: null,
        characters,
        counts: { entities: 0, relationships: 0, triggers: 0 },
        warnings: ["The Infinite Worlds world export has no playable characters. Add at least one possible character before importing it."],
      };
    }
    const stagedInput = await stageSource(input);
    const preview = await input.portable.previewInfiniteWorlds({
      ownerUserId: input.owner.ownerUserId,
      stagedInput,
      kind: "infinite_worlds",
      destination: { kind: "create_world" },
      sourceName: input.request.sourceName,
    });
    return preview.projection;
  }

  if (input.request.targetWorldVersionId === undefined) {
    return {
      kind,
      valid: false as const,
      warnings: ["Select a published world in World Library before importing its matching story TXT."],
      counts: { turns: 0 },
    };
  }
  const target = await targetWorld(input);
  const parsed = parseInfiniteWorldsStory(input.request.sourceText);
  const characters = resolvePlayableCharacters(target.content).map((character) => ({ id: character.id, name: character.name }));
  const selectedCharacterId = selectedStoryCharacterId(
    target.content,
    input.request.sourceText,
    input.request.selectedCharacterId,
  );
  if (selectedCharacterId === undefined) {
    return {
      kind,
      targetWorldId: target.worldId,
      diagnostics: parsed.diagnostics,
      characters,
      selectedCharacterId: null,
      valid: false as const,
      warnings: ["Choose the playable character used by this story before importing it."],
      counts: { turns: parsed.turns.length },
    };
  }
  const stagedInput = await stageSource(input);
  const preview = await input.portable.previewStoryText({
    ownerUserId: input.owner.ownerUserId,
    stagedInput,
    kind: "story_text",
    destination: {
      kind: "existing_world_version",
      worldId: target.worldId,
      worldVersionId: target.worldVersionId,
    },
    sourceName: input.request.sourceName,
    selectedCharacterId,
    enrichFinalTurn: false,
  });
  const missingProvider = input.request.enrichFinalTurn && input.request.providerProfileId === undefined;
  return {
    ...preview.projection,
    diagnostics: parsed.diagnostics,
    valid: preview.projection.valid && !missingProvider,
    warnings: [
      ...preview.projection.warnings,
      ...(missingProvider ? ["Select a text provider or disable final-turn enrichment."] : []),
    ],
  };
}

function idempotencyKey(request: InfiniteWorldsImportRequest): string {
  return `infinite-worlds:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
}

function previewIdempotencyKey(base: string, previewToken: string): string {
  return `${base}:${previewToken}`;
}

export async function importPortableInfiniteWorlds(input: InfiniteWorldsImportRouteInput) {
  const kind = resolvedKind(input.request);
  const key = progressKey(input.request);
  const progressScope = { owner: input.owner, key };
  const tracksProgress = kind === "cyoa_json" || kind === "world_text";
  let beganProgress = false;
  try {
    if (tracksProgress) {
      await input.progress.begin(progressScope, {
        phase: "extracting",
        progressPercent: 5,
        message: kind === "cyoa_json"
          ? "Parsing CYOA story description and branch choices…"
          : "Preparing world text for conversion…",
      });
      beganProgress = true;
    }
    if ((kind === "cyoa_json" || kind === "world_text") && input.request.providerProfileId === undefined) {
      throw Object.assign(new Error("Select a text provider before importing this source."), {
        statusCode: 400,
        expose: true,
      });
    }
    if (kind === "cyoa_json" && !cyoaPublicPreview(input.request).valid) {
      throw Object.assign(new Error(INVALID_CYOA_MESSAGE), { statusCode: 400, expose: true });
    }

    const stagedInput = await stageSource(input);
    const selection = providerSelection(input.request);
    const keyValue = idempotencyKey(input.request);
    let committed;
    if (kind === "cyoa_json") {
      const command: CyoaCommand = {
        ownerUserId: input.owner.ownerUserId,
        stagedInput,
        kind: "cyoa",
        destination: { kind: "create_world" },
        sourceName: input.request.sourceName,
        progressKey: key,
        ...(selection === undefined ? {} : { providerSelection: selection }),
      };
      const preview = await input.portable.previewCyoa(command);
      await input.progress.update(progressScope, {
        phase: "saving_draft",
        progressPercent: 95,
        message: "Saving generated world and character roster to authoritative storage…",
      });
      committed = await input.portable.commit({
        ownerUserId: input.owner.ownerUserId,
        kind: "cyoa",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: previewIdempotencyKey(keyValue, preview.previewHandle.token),
      });
    } else if (kind === "world_text") {
      const command: WorldTextCommand = {
        ownerUserId: input.owner.ownerUserId,
        stagedInput,
        kind: "world_text",
        destination: { kind: "create_world" },
        sourceName: input.request.sourceName,
        progressKey: key,
        ...(selection === undefined ? {} : { providerSelection: selection }),
      };
      const preview = await input.portable.previewWorldText(command);
      await input.progress.update(progressScope, {
        phase: "saving_draft",
        progressPercent: 95,
        message: "Saving converted world to authoritative storage…",
      });
      committed = await input.portable.commit({
        ownerUserId: input.owner.ownerUserId,
        kind: "world_text",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: previewIdempotencyKey(keyValue, preview.previewHandle.token),
      });
    } else if (kind === "world_json") {
      const preview = await input.portable.previewInfiniteWorlds({
        ownerUserId: input.owner.ownerUserId,
        stagedInput,
        kind: "infinite_worlds",
        destination: { kind: "create_world" },
        sourceName: input.request.sourceName,
      });
      committed = await input.portable.commit({
        ownerUserId: input.owner.ownerUserId,
        kind: "infinite_worlds",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: previewIdempotencyKey(keyValue, preview.previewHandle.token),
      });
    } else {
      const target = await targetWorld(input);
      const selectedCharacterId = selectedStoryCharacterId(
        target.content,
        input.request.sourceText,
        input.request.selectedCharacterId,
      );
      if (selectedCharacterId === undefined) {
        throw Object.assign(new Error("Choose the playable character used by this story before importing it."), {
          statusCode: 400,
          expose: true,
        });
      }
      if (input.request.enrichFinalTurn && selection === undefined) {
        throw Object.assign(new Error("Select a text provider or disable final-turn enrichment."), {
          statusCode: 400,
          expose: true,
        });
      }
      const command: StoryTextCommand = {
        ownerUserId: input.owner.ownerUserId,
        stagedInput,
        kind: "story_text",
        destination: {
          kind: "existing_world_version",
          worldId: target.worldId,
          worldVersionId: target.worldVersionId,
        },
        sourceName: input.request.sourceName,
        selectedCharacterId,
        enrichFinalTurn: input.request.enrichFinalTurn,
        ...(selection === undefined ? {} : { providerSelection: selection }),
      };
      const preview = await input.portable.previewStoryText(command);
      committed = await input.portable.commit({
        ownerUserId: input.owner.ownerUserId,
        kind: "story_text",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: previewIdempotencyKey(keyValue, preview.previewHandle.token),
      });
    }

    if (tracksProgress) {
      await input.progress.complete(progressScope, {
        phase: "completed",
        message: kind === "cyoa_json"
          ? "World and 3-4 playable characters generated from CYOA story."
          : "World converted and saved successfully.",
        worldId: committed.result.worldId,
        worldVersionId: committed.result.worldVersionId,
        duplicate: committed.duplicate,
      });
    }
    return committed.result;
  } catch (error) {
    if (beganProgress) {
      const failure = input.diagnoseWorldGenerationFailure(error);
      await input.progress.fail(progressScope, {
        phase: "failed",
        message: failure.message,
        errorMessage: failure.message,
      }).catch(() => undefined);
    }
    throw error;
  }
}
