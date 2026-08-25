import type {
  SystemArchiveJobView,
  SystemArchiveUploadView,
  SystemImportPreviewView
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

declare const systemArchiveJobIdBrand: unique symbol;
declare const systemArchiveUploadIdBrand: unique symbol;
declare const systemArchivePreviewHandleBrand: unique symbol;

export type SystemArchiveJobId = string & Readonly<{ [systemArchiveJobIdBrand]: true }>;
export type SystemArchiveUploadId = string & Readonly<{ [systemArchiveUploadIdBrand]: true }>;
export type SystemArchivePreviewHandle = string & Readonly<{ [systemArchivePreviewHandleBrand]: true }>;

export type EnqueueSystemExportCommand = OwnerScope & Readonly<{ idempotencyKey: string }>;
export type GetSystemArchiveJobCommand = OwnerScope & Readonly<{ jobId: SystemArchiveJobId }>;
export type CancelSystemArchiveJobCommand = OwnerScope & Readonly<{ jobId: SystemArchiveJobId }>;
export type CreateSystemUploadCommand = OwnerScope & Readonly<{ byteLength: number; sha256: string }>;
export type PutSystemUploadChunkCommand = OwnerScope & Readonly<{
  uploadId: SystemArchiveUploadId;
  index: number;
  offset: number;
  bytes: Uint8Array;
  sha256: string;
}>;
export type CompleteSystemUploadCommand = OwnerScope & Readonly<{ uploadId: SystemArchiveUploadId }>;
export type PreviewSystemImportCommand = OwnerScope & Readonly<{ uploadId: SystemArchiveUploadId }>;
export type CommitSystemImportCommand = OwnerScope & Readonly<{
  previewHandle: SystemArchivePreviewHandle;
  idempotencyKey: string;
}>;

export interface SystemArchiveApplication {
  enqueueExport(command: EnqueueSystemExportCommand): Promise<SystemArchiveJobView>;
  getJob(command: GetSystemArchiveJobCommand): Promise<SystemArchiveJobView>;
  cancelJob(command: CancelSystemArchiveJobCommand): Promise<SystemArchiveJobView>;
  createUpload(command: CreateSystemUploadCommand): Promise<SystemArchiveUploadView>;
  putChunk(command: PutSystemUploadChunkCommand): Promise<SystemArchiveUploadView>;
  completeUpload(command: CompleteSystemUploadCommand): Promise<SystemArchiveUploadView>;
  previewImport(command: PreviewSystemImportCommand): Promise<SystemImportPreviewView>;
  commitImport(command: CommitSystemImportCommand): Promise<SystemArchiveJobView>;
}

function opaque(value: string, errorCode: string): string {
  if (value.trim().length === 0) throw new Error(errorCode);
  return value;
}

export function toSystemArchiveJobId(value: string): SystemArchiveJobId {
  return opaque(value, "system_archive_job_id_invalid") as SystemArchiveJobId;
}

export function toSystemArchiveUploadId(value: string): SystemArchiveUploadId {
  return opaque(value, "system_archive_upload_id_invalid") as SystemArchiveUploadId;
}

export function toSystemArchivePreviewHandle(value: string): SystemArchivePreviewHandle {
  return opaque(value, "system_archive_preview_handle_invalid") as SystemArchivePreviewHandle;
}
