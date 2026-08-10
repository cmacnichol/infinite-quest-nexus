export type ClientBoundarySource = Readonly<{
  file: string;
  text: string;
}>;

export function crossRoleImportAllowlistCount(): number;
export function collectClientBoundaryViolations(
  entries: readonly ClientBoundarySource[]
): string[];
export function isBoundarySourceFile(file: string): boolean;
export function checkClientBoundaries(rootDirectory?: string): string[];
