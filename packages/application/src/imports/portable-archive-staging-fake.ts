import type { ImportOwnerScope, PortableStagedInput } from "./types.js";
import { toPortableStagedInput } from "./types.js";
import type {
  PortableArchiveStagingPort,
  PortableArchiveUploadCapability,
  PortableArchiveUploadIssuer
} from "./portable-archive-staging.js";

type FakeStagingOptions = Readonly<{ maximumByteLength: number }>;

export type FakePortableArchiveStagingPort = Readonly<{
  port: PortableArchiveStagingPort;
  issueOwnerBoundUpload: PortableArchiveUploadIssuer["issueOwnerBoundUpload"];
  isStagedForOwner(stagedInput: PortableStagedInput, owner: ImportOwnerScope): boolean;
}>;

/** A pure fake preserving the same bounded, owner-bound capability shape as the future adapter. */
export function createFakePortableArchiveStagingPort(options: FakeStagingOptions): FakePortableArchiveStagingPort {
  const ownerByUpload = new WeakMap<object, string>();
  const ownerByStagedInput = new Map<PortableStagedInput, string>();
  let sequence = 0;

  const issueOwnerBoundUpload: PortableArchiveUploadIssuer["issueOwnerBoundUpload"] = (owner, byteLength) => {
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > options.maximumByteLength) {
      throw new Error("archive_size_limit_exceeded");
    }
    const upload = { byteLength } as PortableArchiveUploadCapability;
    ownerByUpload.set(upload, owner.ownerUserId);
    return upload;
  };

  return {
    port: {
      async stagePortableArchive(upload) {
        const ownerUserId = ownerByUpload.get(upload);
        if (!ownerUserId) throw new Error("archive_unavailable");
        const stagedInput = toPortableStagedInput(`fake-staged-${++sequence}`);
        ownerByStagedInput.set(stagedInput, ownerUserId);
        return stagedInput;
      }
    },
    issueOwnerBoundUpload,
    isStagedForOwner(stagedInput, owner) {
      return ownerByStagedInput.get(stagedInput) === owner.ownerUserId;
    }
  };
}
