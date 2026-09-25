export type BuildMetadataIo = Readonly<{
  revParse: () => string;
  statusPorcelain: () => string;
  now: () => Date;
}>;

export type BuildMetadata = Readonly<{
  commit: string;
  dirty: boolean;
  date: string;
}>;

export function buildMetadataFromGit(io?: BuildMetadataIo): BuildMetadata;
