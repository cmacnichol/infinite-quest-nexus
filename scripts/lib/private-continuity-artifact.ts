import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
/** Resolve declared roots before writing, exclude published/worktree paths, and
 * use generated simple filenames with exclusive creation at the call site. */
export async function privateContinuityArtifactPath(directory: string, filename: string, repositoryRoot: string): Promise<string> {
  if (!isAbsolute(directory) || basename(filename) !== filename || !/^[A-Za-z0-9_.-]+$/u.test(filename)) throw new Error("An absolute private directory and simple artifact filename are required.");
  const [root, repository] = await Promise.all([realpath(directory), realpath(repositoryRoot)]);
  const fromRepository = relative(repository, root);
  if (!fromRepository || (fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`) && !isAbsolute(fromRepository))
    || root.split(/[\\/]/u).some((part) => ["public", "dist", "static", "www", "wwwroot", "htdocs"].includes(part.toLowerCase()))) throw new Error("Private artifacts must be outside the repository and published directories.");
  const target = resolve(root, filename);
  if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("Artifact escapes its private directory.");
  return target;
}
