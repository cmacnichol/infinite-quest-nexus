import type { ImportApplication, ImportApplicationDependencies } from "./ports.js";
import type { ImportOwnerScope, PortableImportCommitCommand, PortableImportPreviewCommand } from "./types.js";

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

function requirePreview(command: PortableImportPreviewCommand): void {
  requireOwner(command);
}

function requireCommit(command: PortableImportCommitCommand): void {
  requireOwner(command);
  if (!nonBlank(command.campaignId) || !nonBlank(command.previewHandle)) {
    throw new ImportApplicationError("import_scope_required");
  }
  if (!nonBlank(command.idempotencyKey)) throw new ImportApplicationError("idempotency_key_required");
}

/** Pure orchestration only. Archive I/O, database work, and cleanup mechanisms remain adapter concerns. */
export function createImportApplication(dependencies: ImportApplicationDependencies): ImportApplication {
  return {
    previewPortableImport: (command) => {
      requirePreview(command);
      return dependencies.archives.previewPortableImport(command);
    },
    commitPortableImport: (database, command) => {
      requireCommit(command);
      return dependencies.archives.commitPortableImport(database, command);
    },
    exportCampaignArchive: (scope) => {
      requireOwner(scope);
      if (!nonBlank(scope.campaignId) || !nonBlank(scope.worldId) || !nonBlank(scope.worldVersionId)) {
        throw new ImportApplicationError("import_scope_required");
      }
      return dependencies.archives.exportCampaignArchive(scope);
    },
    cleanupPreview: (command) => {
      requireOwner(command);
      return dependencies.archives.cleanupPreview(command);
    },
    exportWorldJson: (command) => {
      requireOwner(command);
      if (!nonBlank(command.worldId)) throw new ImportApplicationError("import_scope_required");
      return dependencies.worlds.exportWorld({
        worldId: command.worldId,
        ...(command.worldVersionId === undefined ? {} : { worldVersionId: command.worldVersionId })
      });
    },
    previewWorldJson: (command) => {
      requireOwner(command);
      return dependencies.worlds.previewWorldImport(command.request);
    },
    commitWorldJson: (command) => {
      requireOwner(command);
      if (!nonBlank(command.idempotencyKey)) throw new ImportApplicationError("idempotency_key_required");
      return dependencies.worlds.importWorld(command.request);
    }
  };
}
