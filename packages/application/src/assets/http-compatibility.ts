import type {
  AssetMetadataUpdateCommand,
  AssetMutationIdempotencyKey,
  AssetOwnerScope,
  AssetScope,
  AssetSelectionCommand,
  TurnAssetSelectionScope,
  WorldAssetSelectionScope
} from "./types.js";
import { toAssetMutationIdempotencyKey } from "./types.js";

declare const assetServerStableReplayKeyBrand: unique symbol;

/** Trusted server-derived fallback for source-compatible mutation bodies. */
export type AssetServerStableReplayKey = string & Readonly<{
  [assetServerStableReplayKeyBrand]: true;
}>;

export type AssetHttpIdempotencyInput = Readonly<{
  serverStableReplayKey: AssetServerStableReplayKey;
  idempotencyHeader?: string;
}>;

type AssetMetadataHttpBody = Omit<AssetMetadataUpdateCommand, "idempotencyKey">;
type AssetSelectionHttpBody = Omit<AssetSelectionCommand, "idempotencyKey">;

type AssetMutationHttpIngress<Scope, Command> = Readonly<{
  scope: Scope;
  command: Command;
  idempotencySource: "idempotency_header" | "server_stable_compatibility";
}>;

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function requireOwner(owner: AssetOwnerScope): void {
  if (!nonBlank(owner.ownerUserId)) throw new Error("owner_scope_required");
}

function resolveIdempotency(input: AssetHttpIdempotencyInput): Readonly<{
  key: AssetMutationIdempotencyKey;
  source: AssetMutationHttpIngress<unknown, unknown>["idempotencySource"];
}> {
  if (input.idempotencyHeader !== undefined) {
    return {
      key: toAssetMutationIdempotencyKey(input.idempotencyHeader),
      source: "idempotency_header"
    };
  }
  return {
    key: toAssetMutationIdempotencyKey(input.serverStableReplayKey),
    source: "server_stable_compatibility"
  };
}

/** Adapter-private issuer; the public asset barrel deliberately omits it. */
export function toAssetServerStableReplayKey(value: string): AssetServerStableReplayKey {
  toAssetMutationIdempotencyKey(value);
  return value as AssetServerStableReplayKey;
}

export function bindAssetMetadataHttpIngress(
  owner: AssetOwnerScope,
  assetId: string,
  body: AssetMetadataHttpBody,
  idempotency: AssetHttpIdempotencyInput,
): AssetMutationHttpIngress<AssetScope, AssetMetadataUpdateCommand> {
  requireOwner(owner);
  if (!nonBlank(assetId)) throw new Error("asset_http_scope_invalid");
  const resolved = resolveIdempotency(idempotency);
  return {
    scope: { ...owner, assetId },
    command: { ...body, idempotencyKey: resolved.key },
    idempotencySource: resolved.source
  };
}

export function bindTurnAssetSelectionHttpIngress(
  owner: AssetOwnerScope,
  resource: Readonly<{ campaignId: string; turnId: string }>,
  body: AssetSelectionHttpBody,
  idempotency: AssetHttpIdempotencyInput,
): AssetMutationHttpIngress<TurnAssetSelectionScope, AssetSelectionCommand> {
  requireOwner(owner);
  if (!nonBlank(resource.campaignId) || !nonBlank(resource.turnId)) {
    throw new Error("asset_http_scope_invalid");
  }
  const resolved = resolveIdempotency(idempotency);
  return {
    scope: { ...owner, ...resource },
    command: { ...body, idempotencyKey: resolved.key },
    idempotencySource: resolved.source
  };
}

export function bindWorldAssetSelectionHttpIngress(
  owner: AssetOwnerScope,
  resource: Readonly<{ worldId: string }>,
  body: AssetSelectionHttpBody,
  idempotency: AssetHttpIdempotencyInput,
): AssetMutationHttpIngress<WorldAssetSelectionScope, AssetSelectionCommand> {
  requireOwner(owner);
  if (!nonBlank(resource.worldId)) throw new Error("asset_http_scope_invalid");
  const resolved = resolveIdempotency(idempotency);
  return {
    scope: { ...owner, ...resource },
    command: { ...body, idempotencyKey: resolved.key },
    idempotencySource: resolved.source
  };
}
