/*
 * One-shot P3.9 credential bridge. Run this file only inside the authorized
 * source runtime container after the disposable API is reachable on its
 * Docker network. It deliberately prints a redacted profile summary only.
 */
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "/app/dist/packages/database/src/config.js";
import { createDatabasePool, initialOwnerId } from "/app/dist/packages/database/src/pool.js";
import { loadPrivateProviderCredentialRow } from "/app/dist/packages/database/src/provider-repository.js";
import { decryptCredential } from "/app/dist/packages/story-engine/src/credentials.js";

const destinationBaseUrl = process.env.P3_SMOKE_DESTINATION_API;
assert.ok(destinationBaseUrl, "P3_SMOKE_DESTINATION_API is required.");
const destination = new URL(destinationBaseUrl);
assert.equal(destination.protocol, "http:", "The disposable bridge uses its private Docker HTTP network only.");
assert.equal(destination.hostname, "infinitequest-ai-assist-p3-9-smoke-api-1", "The bridge accepts only the exact labeled P3.9 API container.");
assert.equal(destination.port || "80", "8080", "The bridge accepts only the disposable API port.");
const sourceConfig = loadRuntimeConfig();
const sourceDatabaseUrl = new URL(sourceConfig.databaseUrl);
// The temporary smoke network also exposes a `postgres` service. Keep this
// source-only read bound to its canonical source-network alias during attach.
if (sourceDatabaseUrl.hostname === "postgres") sourceDatabaseUrl.hostname = "infinitequest-postgres-1";
const pool = createDatabasePool(sourceDatabaseUrl.toString());
const safeFailure = (code, details) => {
  process.stderr.write(`P3.9 live-provider bridge failed: ${JSON.stringify({ code, ...details })}\n`);
  process.exitCode = 1;
};

let phase = "source_owner";
try {
  const ownerUserId = await initialOwnerId(pool);
  phase = "source_selection";
  const selected = await pool.query(
    `SELECT id FROM provider_profiles
      WHERE owner_user_id=$1 AND provider_role='text' AND enabled=true AND is_default=true
      ORDER BY updated_at DESC, id ASC LIMIT 1`,
    [ownerUserId]
  );
  if (selected.rowCount !== 1) throw new Error("selected_text_profile_unavailable");
  phase = "source_credential";
  const profile = await loadPrivateProviderCredentialRow(pool, ownerUserId, selected.rows[0].id);
  if (!profile || profile.providerRole !== "text" || !profile.encryptedCredential) throw new Error("selected_text_credential_unavailable");
  const credential = decryptCredential(profile.encryptedCredential, sourceConfig.credentialEncryptionKey);
  phase = "destination_create_request";
  let create;
  try {
    create = await fetch(`${destinationBaseUrl.replace(/\/$/u, "")}/api/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "P3.9 disposable selected text provider",
        providerType: profile.providerType,
        providerRole: "text",
        baseUrl: profile.baseUrl,
        defaultModel: profile.defaultModel,
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens,
        temperature: profile.temperature,
        requestTimeoutMs: profile.requestTimeoutMs,
        configuration: profile.configuration,
        enabled: true,
        isDefault: true,
        apiKey: credential
      })
    });
  } catch {
    throw new Error("destination_profile_create_unreachable");
  }
  if (!create.ok) throw new Error("destination_profile_create_failed");
  phase = "destination_create_response";
  let created;
  try {
    created = await create.json();
  } catch {
    throw new Error("destination_profile_create_response_invalid");
  }
  if (!created || typeof created.id !== "string") throw new Error("destination_profile_create_response_invalid");
  // Do not add endpoint, identifiers, credentials, configuration, or response
  // data to retained evidence. The caller records only this safe selection.
  process.stdout.write(`${JSON.stringify({
    result: "created",
    providerRole: "text",
    providerType: profile.providerType,
    model: profile.defaultModel,
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens,
    hasCredential: true,
    destinationProfileCreated: true
  })}\n`);
} catch (error) {
  const knownCode = error instanceof Error && [
    "selected_text_profile_unavailable",
    "selected_text_credential_unavailable",
    "destination_profile_create_unreachable",
    "destination_profile_create_failed",
    "destination_profile_create_response_invalid"
  ].includes(error.message) ? error.message : undefined;
  const code = knownCode ?? `bridge_${phase}_failed`;
  const cause = error instanceof Error && error.cause && typeof error.cause === "object"
    ? error.cause : undefined;
  safeFailure(code, {
    phase,
    errorName: error instanceof Error ? error.name : "NonErrorThrow",
    causeCode: cause && "code" in cause && typeof cause.code === "string" ? cause.code : null
  });
} finally {
  await pool.end();
}
