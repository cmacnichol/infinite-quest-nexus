const COMPOSITION = "services/runtime/src/portable-import-export-composition.ts";
const PRIVATE_CONTRACT = "packages/application/src/imports/private-portable-composition.ts";
const PUBLIC_BARREL = "packages/application/src/imports/index.ts";

export function checkPortableCompositionBoundaries(file, text) {
  const violations = [];
  if (file === COMPOSITION) {
    const forbidden = [
      ["activeProgressMap", "process-local import progress is forbidden"],
      ["PortableArchiveDownloadView", "buffered production archive views are forbidden"],
      ["downloadPortableExport", "buffered production export helpers are forbidden"],
      ["import-service", "legacy import service authority is forbidden"],
      ["campaign-archive-service", "legacy campaign archive authority is forbidden"],
      ["infinite-worlds-import-service", "legacy Infinite Worlds authority is forbidden"]
    ];
    for (const [needle, message] of forbidden) {
      if (text.includes(needle)) violations.push(`${file}: ${message}`);
    }
  }
  if (/^(?:services\/api|services\/worker)\/src\//u.test(file)
    && text.includes("portable-import-export-composition")) {
    violations.push(`${file}: Task 14e3d composition must remain unconsumed until the binding checkpoint`);
  }
  if (file === PUBLIC_BARREL && text.includes("private-portable-composition")) {
    violations.push(`${file}: private portable composition must not enter the public imports barrel`);
  }
  if (file === PRIVATE_CONTRACT && /\b(?:relativePath|storagePath|rawPath)\b/u.test(text)) {
    violations.push(`${file}: private composition surface must not expose raw filesystem paths`);
  }
  return violations;
}
