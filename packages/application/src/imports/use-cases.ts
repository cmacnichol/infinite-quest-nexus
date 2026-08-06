import type { ImportApplication, ImportApplicationDependencies } from "./ports.js";
import type {
  ImportOwnerScope,
  PortableImportCommitCommand,
  PortableImportPreviewCommand,
  PortablePreviewDestination
} from "./types.js";

export class ImportApplicationError extends Error {
  constructor(readonly code: "owner_scope_required" | "import_scope_required" | "idempotency_key_required") {
    super(code);
    this.name = "ImportApplicationError";
  }
}

function nonBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function requireOwner(scope: ImportOwnerScope): void {
  if (!nonBlank(scope.ownerUserId)) throw new ImportApplicationError("owner_scope_required");
}

function requirePreviewDestination(command: Readonly<{
  kind: PortableImportPreviewCommand["kind"];
  destination: PortablePreviewDestination;
}>): void {
  if (command.kind === "campaign_zip") {
    if (command.destination.kind === "embedded" && command.destination.operation === "create_world") return;
    if (command.destination.kind === "existing_world_version"
      && nonBlank(command.destination.worldId)
      && nonBlank(command.destination.worldVersionId)) return;
    throw new ImportApplicationError("import_scope_required");
  }
  if (command.kind === "legacy_story" || command.kind === "story_text") {
    if (command.destination.kind === "existing_world_version"
      && nonBlank(command.destination.worldId)
      && nonBlank(command.destination.worldVersionId)) return;
    throw new ImportApplicationError("import_scope_required");
  }
  if (command.destination.kind !== "create_world") {
    throw new ImportApplicationError("import_scope_required");
  }
}

function requirePreview(command: PortableImportPreviewCommand): void {
  requireOwner(command);
  if (!nonBlank(command.stagedInput)) throw new ImportApplicationError("import_scope_required");
  requirePreviewDestination(command);
}

function destinationsMatch(
  previewDestination: PortablePreviewDestination,
  commitDestination: PortablePreviewDestination,
): boolean {
  if (previewDestination.kind === "embedded") {
    return commitDestination.kind === "embedded"
      && previewDestination.operation === commitDestination.operation;
  }
  if (previewDestination.kind === "existing_world_version") {
    return commitDestination.kind === "existing_world_version"
      && previewDestination.worldId === commitDestination.worldId
      && previewDestination.worldVersionId === commitDestination.worldVersionId;
  }
  return commitDestination.kind === "create_world";
}

function requireCommit(command: PortableImportCommitCommand): void {
  requireOwner(command);
  if (!nonBlank(command.previewHandle.token)) {
    throw new ImportApplicationError("import_scope_required");
  }
  if (!nonBlank(command.idempotencyKey)) throw new ImportApplicationError("idempotency_key_required");
  requirePreviewDestination(command);
  if (!destinationsMatch(command.previewHandle.destination, command.destination)) {
    throw new ImportApplicationError("import_scope_required");
  }
}

/** Pure orchestration only. Archive I/O, database work, and cleanup mechanisms remain adapter concerns. */
export function createImportApplication(dependencies: ImportApplicationDependencies): ImportApplication {
  return {
    previewPortableImport: async (command) => {
      requirePreview(command);
      return dependencies.archives.previewPortableImport(command);
    },
    commitPortableImport: async (database, command) => {
      requireCommit(command);
      return dependencies.archives.commitPortableImport(database, command);
    },
    retrievePortableImportResult: async (scope, retrieval) => {
      requireOwner(scope);
      if (!nonBlank(retrieval)) throw new ImportApplicationError("import_scope_required");
      return dependencies.archives.retrievePortableImportResult(scope, retrieval);
    },
    exportCampaignArchive: async (scope) => {
      requireOwner(scope);
      if (!nonBlank(scope.campaignId) || !nonBlank(scope.worldId) || !nonBlank(scope.worldVersionId)) {
        throw new ImportApplicationError("import_scope_required");
      }
      return dependencies.archives.exportCampaignArchive(scope);
    },
    downloadPortableExport: async (scope, retrieval) => {
      requireOwner(scope);
      if (!nonBlank(scope.campaignId) || !nonBlank(scope.worldId) || !nonBlank(scope.worldVersionId)) {
        throw new ImportApplicationError("import_scope_required");
      }
      return dependencies.archives.downloadPortableExport(scope, retrieval);
    },
    cleanupPreview: async (command) => {
      requireOwner(command);
      return dependencies.archives.cleanupPreview(command);
    },
    exportWorldJson: async (command) => {
      requireOwner(command);
      if (!nonBlank(command.worldId)) throw new ImportApplicationError("import_scope_required");
      return dependencies.worlds.exportWorld({
        worldId: command.worldId,
        ...(command.worldVersionId === undefined ? {} : { worldVersionId: command.worldVersionId })
      });
    },
    previewWorldJson: async (command) => {
      requireOwner(command);
      if (command.destination.kind !== "create_world") {
        throw new ImportApplicationError("import_scope_required");
      }
      return dependencies.worlds.previewWorldImport(command.request);
    },
    commitWorldJson: async (command) => {
      requireOwner(command);
      if (!nonBlank(command.idempotencyKey)) throw new ImportApplicationError("idempotency_key_required");
      return dependencies.worlds.importWorldIdempotent({
        request: command.request,
        idempotencyKey: command.idempotencyKey
      });
    }
  };
}
