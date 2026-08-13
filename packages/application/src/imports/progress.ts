import type { ImportProgressReport } from "@infinite-quest/contracts";
import type { ImportOwnerScope } from "./types.js";

export type ImportProgressScope = Readonly<{
  owner: ImportOwnerScope;
  key: string;
}>;

export type ImportProgressProcessingUpdate = Readonly<{
  phase: string;
  progressPercent: number;
  message: string;
}>;

export type ImportProgressCompletion = Readonly<{
  phase: string;
  message: string;
  worldId?: string;
  worldVersionId?: string;
  duplicate?: boolean;
}>;

export type ImportProgressFailure = Readonly<{
  phase: string;
  message: string;
  errorMessage: string;
}>;

/** Durable status-only compatibility projection; none of its values authorize an import. */
export interface ImportProgressStorePort {
  begin(scope: ImportProgressScope, update: ImportProgressProcessingUpdate): Promise<void>;
  update(scope: ImportProgressScope, update: ImportProgressProcessingUpdate): Promise<void>;
  complete(scope: ImportProgressScope, completion: ImportProgressCompletion): Promise<void>;
  fail(scope: ImportProgressScope, failure: ImportProgressFailure): Promise<void>;
  read(scope: ImportProgressScope): Promise<ImportProgressReport | null>;
}
