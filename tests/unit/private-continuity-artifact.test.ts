import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateContinuityArtifactPath } from "../../scripts/lib/private-continuity-artifact.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("rejects repository, relative, published and linked repository roots while accepting private sibling roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "iq-private-artifact-"));
  roots.push(root);
  const repository = join(root, "repo");
  const sibling = join(root, "repo-private");
  const published = join(root, "public");
  await Promise.all([repository, sibling, published].map((path) => mkdir(path)));
  const disguisedChild = join(repository, "..private");
  await mkdir(disguisedChild);
  for (const invalid of [".", repository, published, disguisedChild]) await expect(privateContinuityArtifactPath(invalid, "capture.json", repository)).rejects.toThrow();
  const link = join(root, "linked-root");
  await symlink(repository, link, process.platform === "win32" ? "junction" : "dir");
  await expect(privateContinuityArtifactPath(link, "capture.json", repository)).rejects.toThrow();
  await expect(privateContinuityArtifactPath(sibling, "../capture.json", repository)).rejects.toThrow();
  const target = await privateContinuityArtifactPath(sibling, "capture.json", repository);
  await writeFile(target, "private", { flag: "wx" });
  await expect(writeFile(target, "replacement", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
});
