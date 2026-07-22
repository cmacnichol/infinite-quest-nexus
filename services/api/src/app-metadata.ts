export type ApplicationMetadata = {
  name: "Infinite Quest Nexus";
  version: string;
  commit: string | null;
  builtAt: string | null;
};

function optionalBuildValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function applicationMetadata(environment: NodeJS.ProcessEnv = process.env): ApplicationMetadata {
  return {
    name: "Infinite Quest Nexus",
    version: optionalBuildValue(environment.NEXUS_VERSION)
      || optionalBuildValue(environment.npm_package_version)
      || "0.1.0",
    commit: optionalBuildValue(environment.NEXUS_BUILD_COMMIT),
    builtAt: optionalBuildValue(environment.NEXUS_BUILD_DATE)
  };
}
