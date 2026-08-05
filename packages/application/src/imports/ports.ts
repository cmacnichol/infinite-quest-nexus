import type { PortableWorldApplicationPort } from "../world-campaign/ports.js";
import type {
  CampaignArchiveScope,
  ImportTransactionContext,
  PortableArchiveExportView,
  PortableImportCommitCommand,
  PortableImportCommitView,
  PortableImportPreviewCommand,
  PortableImportPreviewView,
  PortablePreviewCleanupCommand
} from "./types.js";

/** Adapter boundary for archive/file work. It returns safe views only, never paths or caught exceptions. */
export interface PortableArchivePort {
  previewPortableImport(command: PortableImportPreviewCommand): Promise<PortableImportPreviewView>;
  commitPortableImport(
    database: ImportTransactionContext,
    command: PortableImportCommitCommand,
  ): Promise<PortableImportCommitView>;
  exportCampaignArchive(scope: CampaignArchiveScope): Promise<PortableArchiveExportView>;
  cleanupPreview(command: PortablePreviewCleanupCommand): Promise<void>;
}

/** Existing owner-bound world authority: 14e must consume it instead of recreating world/version SQL. */
export type WorldJsonPortablePort = PortableWorldApplicationPort;

export type ImportApplicationDependencies = Readonly<{
  worlds: WorldJsonPortablePort;
  archives: PortableArchivePort;
}>;

export interface ImportApplication extends PortableArchivePort {
  exportWorldJson(command: import("./types.js").WorldJsonExportCommand): ReturnType<WorldJsonPortablePort["exportWorld"]>;
  previewWorldJson(command: import("./types.js").WorldJsonPreviewCommand): ReturnType<WorldJsonPortablePort["previewWorldImport"]>;
  commitWorldJson(command: import("./types.js").WorldJsonCommitCommand): ReturnType<WorldJsonPortablePort["importWorld"]>;
}
