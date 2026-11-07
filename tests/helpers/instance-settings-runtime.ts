import { settingsFixture } from "../fixtures/instance-settings.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { INSTANCE_SETTING_FIELDS } from "../../packages/domain/src/instance-settings.js";
import type { DeploymentSettingsPolicy } from "../../packages/contracts/src/instance-settings.js";
export function runtimePolicy(): DeploymentSettingsPolicy {
  const s = settingsFixture();
  return { version: 1, installationId: "00000000-0000-4000-8000-000000000001", minimumSettingsProtocolVersion: 1,
    featureGates: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter(f=>f.kind==='boolean').map(f=>[f.key,true])) as DeploymentSettingsPolicy['featureGates'],
    numericBounds: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter(f=>f.kind==='integer').map(f=>[f.key,{min:f.minimum!,max:f.maximum!}])) as DeploymentSettingsPolicy['numericBounds'],
    approvedRateTuples: [{windowSeconds:s.apiRateLimitWindowSeconds,providerRequests:s.apiRateLimitProviderRequests,generationRequests:s.apiRateLimitGenerationRequests,importRequests:s.apiRateLimitImportRequests}],
    expectedRoles: [{role:'worker',replicas:1,databaseMaxConnections:12}], systemArchiveAllowLimitIncrease:false };
}
export function bootstrap() { const before=process.env; try {process.env={DATABASE_URL:'postgresql://fixture@localhost/fixture',APP_ROLE:'worker'}; return {...loadRuntimeConfig(),role:'worker' as const,databaseMaxConnections:12};} finally {process.env=before;} }
