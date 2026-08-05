import type { OwnerBoundIdempotentPortableWorldApplicationPort } from "../world-campaign/ports.js";
import type {
  CampaignArchiveScope,
  PortableArchiveDownloadView,
  PortableArchiveExportRetrieval,
  ImportTransactionContext,
  PortableArchiveExportView,
  PortableImportCommitCommand,
  PortableImportCommitView,
  PortableImportPreviewCommand,
  PortableImportPreviewView,
  PortablePreviewDestination,
  PortablePreviewCleanupCommand
} from "./types.js";

/** Adapter boundary for archive/file work. It returns safe views only, never paths or caught exceptions. */
export interface PortableArchivePort {
  previewPortableImport<Command extends PortableImportPreviewCommand>(
    command: Command,
  ): Promise<PortableImportPreviewView<Command>>;
  commitPortableImport<Preview extends PortableImportPreviewCommand>(
    database: ImportTransactionContext,
    command: PortableImportCommitCommand<Preview>,
  ): Promise<PortableImportCommitView>;
  exportCampaignArchive(scope: CampaignArchiveScope): Promise<PortableArchiveExportView>;
  downloadPortableExport(
    scope: CampaignArchiveScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<PortableArchiveDownloadView>;
  cleanupPreview<Destination extends PortablePreviewDestination>(
    command: PortablePreviewCleanupCommand<Destination>,
  ): Promise<void>;
}

/** Existing owner-bound world authority: 14e must consume it instead of recreating world/version SQL. */
export type WorldJsonPortablePort = OwnerBoundIdempotentPortableWorldApplicationPort;

export type ImportApplicationDependencies = Readonly<{
  worlds: WorldJsonPortablePort;
  archives: PortableArchivePort;
}>;

export interface ImportApplication extends PortableArchivePort {
  exportWorldJson(command: import("./types.js").WorldJsonExportCommand): ReturnType<WorldJsonPortablePort["exportWorld"]>;
  previewWorldJson(command: import("./types.js").WorldJsonPreviewCommand): ReturnType<WorldJsonPortablePort["previewWorldImport"]>;
  commitWorldJson(command: import("./types.js").WorldJsonCommitCommand): ReturnType<WorldJsonPortablePort["importWorld"]>;
}
