import type {
  DurableFilesystemRecoveryClaim,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation,
} from "../assets/private-storage-lifecycle.js";

export type SystemArchiveUploadFileAuthority = Readonly<{
  state: "assembling";
  operation: ReservedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  relativePath: string;
  identity: Readonly<{ deviceId: string; fileId: string }>;
}>;

export type SystemArchiveStagedFileAuthority = Readonly<{
  state: "staged";
  stagedInputId: string;
  descriptor: PrivateStorageDescriptor;
}>;

export type SystemArchiveUploadStorageAuthority =
  | SystemArchiveUploadFileAuthority
  | SystemArchiveStagedFileAuthority;

export interface SystemArchivePrivateStorageRepositoryPort {
  withUploadLock<Result>(
    input: Readonly<{
      ownerUserId: string;
      uploadId: string;
      filesystemOperationId: string;
      leaseOwner: string;
      leaseSeconds: number;
    }>,
    work: (authority: SystemArchiveUploadStorageAuthority) => Promise<Result>,
  ): Promise<Result>;
  stagedInputIdForOperation(
    ownerUserId: string,
    filesystemOperationId: string,
  ): Promise<string>;
  completedUpload(
    ownerUserId: string,
    uploadId: string,
  ): Promise<Readonly<{
    stagedInputId: string;
    descriptor: PrivateStorageDescriptor;
  }> | null>;
}
