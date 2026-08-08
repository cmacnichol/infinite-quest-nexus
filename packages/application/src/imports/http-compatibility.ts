import type {
  CampaignArchivePreviewResponse,
  InfiniteWorldsImportRequest,
  ImportProgressReport,
  ImportProgressNotFoundResponse,
  StoryImportRequest,
  WorldImportRequest
} from "@infinite-quest/contracts";
import {
  campaignArchivePreviewResponseSchema,
  infiniteWorldsImportRequestSchema,
  importProgressQuerySchema,
  importProgressResponseSchema,
  storyImportRequestSchema,
  worldImportRequestSchema
} from "@infinite-quest/contracts";
import type {
  CampaignArchiveImportResultProjection,
  CampaignZipPreviewDestination,
  CampaignArchiveScope,
  CyoaPreviewProjection,
  ImportOwnerScope,
  ImportTransactionContext,
  InfiniteWorldsJsonPreviewProjection,
  LegacyStoryImportResultProjection,
  LegacyStoryPreviewProjection,
  PortableImportCommitView,
  PortableImportKind,
  PortableImportPreviewProjectionByKind,
  PortableImportPreviewProjectionFor,
  PortableImportResultProjectionFor,
  PortableStoryImportResultProjection,
  PortableWorldImportResultProjection,
  PortablePreviewDestination,
  PortablePreviewHandle,
  PortableStagedInput,
  StoryTextPreviewProjection,
  WorldTextPreviewProjection,
  WorldJsonExportCommand
} from "./types.js";

declare const portableImportIdempotencyKeyBrand: unique symbol;
declare const serverStableReplayKeyBrand: unique symbol;
declare const validatedPortableContentFingerprintBrand: unique symbol;
declare const validatedAtomicRepreviewPayloadBrand: unique symbol;
declare const ownerBoundPortableStagedInputBrand: unique symbol;

export type PortableImportIdempotencyKey = string & Readonly<{
  [portableImportIdempotencyKeyBrand]: true;
}>;

/**
 * A compatibility replay key is created by trusted server code from the
 * validated request and server-resolved owner/scope. It is idempotency input,
 * never authorization and never portable source provenance.
 */
export type ServerStableReplayKey = string & Readonly<{
  [serverStableReplayKeyBrand]: true;
}>;

export type ValidatedPortableContentFingerprint = string & Readonly<{
  [validatedPortableContentFingerprintBrand]: true;
}>;

export type AtomicPortableImportKind = Exclude<PortableImportKind, "campaign_zip">;

type ExplicitInfiniteWorldsRequest<SourceKind extends InfiniteWorldsImportRequest["sourceKind"]> =
  Omit<InfiniteWorldsImportRequest, "sourceKind"> & Readonly<{ sourceKind: SourceKind }>;

export type AtomicPortableImportPayloadByKind = Readonly<{
  legacy_story: StoryImportRequest;
  story_text: ExplicitInfiniteWorldsRequest<"story_text">;
  infinite_worlds: ExplicitInfiniteWorldsRequest<"world_json">;
  cyoa: ExplicitInfiniteWorldsRequest<"cyoa_json">;
  world_json: WorldImportRequest;
  world_text: ExplicitInfiniteWorldsRequest<"world_text">;
}>;

type AtomicPortableImportDestinationByKind = Readonly<{
  legacy_story: Extract<PortablePreviewDestination, { kind: "existing_world_version" }>;
  story_text: Extract<PortablePreviewDestination, { kind: "existing_world_version" }>;
  infinite_worlds: Extract<PortablePreviewDestination, { kind: "create_world" }>;
  cyoa: Extract<PortablePreviewDestination, { kind: "create_world" }>;
  world_json: Extract<PortablePreviewDestination, { kind: "create_world" }>;
  world_text: Extract<PortablePreviewDestination, { kind: "create_world" }>;
}>;

export type ValidatedAtomicRepreviewPayload<Kind extends AtomicPortableImportKind = AtomicPortableImportKind> =
  Kind extends AtomicPortableImportKind ? Readonly<{
    owner: ImportOwnerScope;
    kind: Kind;
    destination: AtomicPortableImportDestinationByKind[Kind];
    contentFingerprint: ValidatedPortableContentFingerprint;
    stagedInput: PortableStagedInput;
    replayKey: ServerStableReplayKey;
    payload: AtomicPortableImportPayloadByKind[Kind];
    [validatedAtomicRepreviewPayloadBrand]: true;
  }> : never;

export type OwnerBoundPortableStagedInput<Kind extends AtomicPortableImportKind = AtomicPortableImportKind> =
  Kind extends AtomicPortableImportKind ? Readonly<{
    owner: ImportOwnerScope;
    kind: Kind;
    destination: AtomicPortableImportDestinationByKind[Kind];
    contentFingerprint: ValidatedPortableContentFingerprint;
    stagedInput: PortableStagedInput;
    [ownerBoundPortableStagedInputBrand]: true;
  }> : never;

export const PORTABLE_IMPORT_IDEMPOTENCY_HEADER = "idempotency-key" as const;

type CampaignZipCommitIngressRequest<Destination extends CampaignZipPreviewDestination> = Readonly<{
  owner: ImportOwnerScope;
  kind: "campaign_zip";
  destination: Destination;
  serverStableReplayKey: ServerStableReplayKey;
  idempotencyHeader?: string;
  previewHandle?: PortablePreviewHandle<Destination>;
}>;

type AtomicRepreviewCommitIngressRequest<Kind extends AtomicPortableImportKind> = Readonly<{
  owner: ImportOwnerScope;
  kind: Kind;
  destination: AtomicPortableImportDestinationByKind[Kind];
  idempotencyHeader?: string;
  previewHandle?: never;
  validatedPayload: ValidatedAtomicRepreviewPayload<Kind>;
  stagedInput: OwnerBoundPortableStagedInput<Kind>;
}>;

export type PortableImportCommitIngressRequest<
  Destination extends PortablePreviewDestination = PortablePreviewDestination,
  Kind extends PortableImportKind = PortableImportKind,
> = Kind extends "campaign_zip"
  ? CampaignZipCommitIngressRequest<Extract<Destination, CampaignZipPreviewDestination>>
  : Kind extends AtomicPortableImportKind
    ? AtomicRepreviewCommitIngressRequest<Kind>
    : never;

export type PortableImportCommitIngress<Destination extends PortablePreviewDestination = PortablePreviewDestination> = Readonly<{
  owner: ImportOwnerScope;
  kind: PortableImportKind;
  destination: Destination;
  idempotency:
    | Readonly<{ source: "idempotency_header"; key: PortableImportIdempotencyKey }>
    | Readonly<{ source: "server_stable_compatibility"; key: PortableImportIdempotencyKey }>;
  choreography:
    | Readonly<{
      kind: "durable_preview";
      previewHandle: PortablePreviewHandle<Destination>;
    }>
    | Readonly<{
      kind: "atomic_repreview";
      transactionBoundary: "preview_and_commit";
      replayKey: ServerStableReplayKey;
      validatedPayload: ValidatedAtomicRepreviewPayload;
      stagedInput: OwnerBoundPortableStagedInput;
    }>;
}>;

export type AtomicPortableImportCoreCommand<Kind extends AtomicPortableImportKind> = Readonly<{
  owner: ImportOwnerScope;
  kind: Kind;
  destination: AtomicPortableImportDestinationByKind[Kind];
  payload: AtomicPortableImportPayloadByKind[Kind];
  stagedInput: PortableStagedInput;
  contentFingerprint: ValidatedPortableContentFingerprint;
  replayKey: ServerStableReplayKey;
  idempotencyKey: PortableImportIdempotencyKey;
}>;

export interface CallerOwnedImportTransactionRunner {
  run<Result>(work: (transaction: ImportTransactionContext) => Promise<Result>): Promise<Result>;
}

export type AtomicPortableImportCore<Result> = <Kind extends AtomicPortableImportKind>(
  transaction: ImportTransactionContext,
  command: AtomicPortableImportCoreCommand<Kind>,
) => Promise<Result>;

export type ImportProgressLookup = Readonly<{
  owner: ImportOwnerScope;
  key: string;
  disposition: "owner_scoped_bounded_status";
  authority: "none";
}>;

export type ImportProgressHttpResult =
  | Readonly<{ statusCode: 200; body: ImportProgressReport }>
  | Readonly<{ statusCode: 404; body: ImportProgressNotFoundResponse }>;

function requireOwner(owner: ImportOwnerScope): void {
  if (owner.ownerUserId.trim().length === 0) throw new Error("owner_scope_required");
}

function validateReplayKey(value: string, errorCode: string): string {
  if (value.length < 1 || value.length > 200 || !/^[!-~]+$/u.test(value)) {
    throw new Error(errorCode);
  }
  return value;
}

export function toPortableImportIdempotencyKey(value: string): PortableImportIdempotencyKey {
  return validateReplayKey(value, "portable_import_idempotency_key_invalid") as PortableImportIdempotencyKey;
}

export function toServerStableReplayKey(value: string): ServerStableReplayKey {
  return validateReplayKey(value, "server_stable_replay_key_invalid") as ServerStableReplayKey;
}

/** Adapter-private proof that the payload or staged bytes were validated and fingerprinted. */
export function toValidatedPortableContentFingerprint(
  value: string,
): ValidatedPortableContentFingerprint {
  if (!/^[0-9a-f]{64}$/iu.test(value)) throw new Error("portable_content_fingerprint_invalid");
  return value.toLowerCase() as ValidatedPortableContentFingerprint;
}

function requireResourceIds(values: readonly string[], errorCode: string): void {
  if (values.some((value) => value.trim().length === 0)) throw new Error(errorCode);
}

export function bindCampaignArchiveExportScope(
  owner: ImportOwnerScope,
  resource: Readonly<{ campaignId: string; worldId: string; worldVersionId: string }>,
): CampaignArchiveScope {
  requireOwner(owner);
  requireResourceIds(
    [resource.campaignId, resource.worldId, resource.worldVersionId],
    "portable_export_scope_invalid",
  );
  return { ...owner, ...resource };
}

export function bindWorldJsonExportScope(
  owner: ImportOwnerScope,
  resource: Readonly<{ worldId: string; worldVersionId?: string }>,
): WorldJsonExportCommand {
  requireOwner(owner);
  requireResourceIds(
    [resource.worldId, ...(resource.worldVersionId === undefined ? [] : [resource.worldVersionId])],
    "portable_export_scope_invalid",
  );
  return { ...owner, ...resource };
}

function isExistingDestination(
  destination: PortablePreviewDestination,
): destination is Extract<PortablePreviewDestination, { kind: "existing_world_version" }> {
  return destination.kind === "existing_world_version"
    && destination.worldId.trim().length > 0
    && destination.worldVersionId.trim().length > 0;
}

function isCreateWorldDestination(
  destination: PortablePreviewDestination,
): destination is Extract<PortablePreviewDestination, { kind: "create_world" }> {
  return destination.kind === "create_world";
}

function isEmbeddedCampaignDestination(
  destination: PortablePreviewDestination,
): destination is Extract<CampaignZipPreviewDestination, { kind: "embedded" }> {
  return destination.kind === "embedded" && destination.operation === "create_world";
}

function destinationMatches(
  left: PortablePreviewDestination,
  right: PortablePreviewDestination,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "existing_world_version" && right.kind === "existing_world_version") {
    return left.worldId === right.worldId && left.worldVersionId === right.worldVersionId;
  }
  return left.kind !== "embedded"
    || (right.kind === "embedded" && left.operation === right.operation);
}

function requireKindDestination(kind: PortableImportKind, destination: PortablePreviewDestination): void {
  if (kind === "campaign_zip") {
    if (isEmbeddedCampaignDestination(destination) || isExistingDestination(destination)) return;
    throw new Error("portable_import_scope_invalid");
  }
  if (kind === "legacy_story" || kind === "story_text") {
    if (isExistingDestination(destination)) return;
    throw new Error("portable_import_scope_invalid");
  }
  if (isCreateWorldDestination(destination)) return;
  throw new Error("portable_import_scope_invalid");
}

function atomicKindCode(kind: AtomicPortableImportKind): string {
  switch (kind) {
    case "legacy_story": return "ls";
    case "story_text": return "st";
    case "infinite_worlds": return "iw";
    case "cyoa": return "cy";
    case "world_json": return "wj";
    case "world_text": return "wt";
  }
}

function atomicDestinationReplaySegment(
  destination: AtomicPortableImportDestinationByKind[AtomicPortableImportKind],
): string {
  return destination.kind === "create_world"
    ? "c"
    : `e|${destination.worldId}|${destination.worldVersionId}`;
}

function deriveAtomicReplayKey(
  owner: ImportOwnerScope,
  kind: AtomicPortableImportKind,
  destination: AtomicPortableImportDestinationByKind[AtomicPortableImportKind],
  contentFingerprint: ValidatedPortableContentFingerprint,
): ServerStableReplayKey {
  return toServerStableReplayKey([
    "pr",
    owner.ownerUserId,
    atomicKindCode(kind),
    atomicDestinationReplaySegment(destination),
    contentFingerprint
  ].join("|"));
}

function parseAtomicPayload<Kind extends AtomicPortableImportKind>(
  kind: Kind,
  destination: AtomicPortableImportDestinationByKind[Kind],
  value: unknown,
): AtomicPortableImportPayloadByKind[Kind] {
  if (kind === "legacy_story") {
    if (destination.kind !== "existing_world_version") {
      throw new Error("portable_atomic_payload_destination_mismatch");
    }
    const payload = storyImportRequestSchema.parse(value);
    if (payload.targetWorldVersionId !== destination.worldVersionId) {
      throw new Error("portable_atomic_payload_destination_mismatch");
    }
    return payload as AtomicPortableImportPayloadByKind[Kind];
  }
  if (kind === "world_json") {
    return worldImportRequestSchema.parse(value) as AtomicPortableImportPayloadByKind[Kind];
  }

  const payload = infiniteWorldsImportRequestSchema.parse(value);
  const expectedSourceKind = kind === "infinite_worlds" ? "world_json" : kind === "cyoa" ? "cyoa_json" : kind;
  if (payload.sourceKind !== expectedSourceKind) {
    throw new Error("portable_atomic_payload_kind_mismatch");
  }
  if ((kind === "cyoa" || kind === "world_text") && payload.providerProfileId === undefined) {
    throw new Error("portable_atomic_provider_required");
  }
  if (kind === "story_text") {
    if (destination.kind !== "existing_world_version"
      || payload.targetWorldVersionId !== destination.worldVersionId) {
      throw new Error("portable_atomic_payload_destination_mismatch");
    }
  }
  return payload as AtomicPortableImportPayloadByKind[Kind];
}

/**
 * Adapter-private constructor. The caller supplies a fingerprint produced by
 * its validated request/staging boundary; this function parses the exact
 * family payload and binds it to owner and destination.
 */
export function bindValidatedAtomicRepreviewPayload<Kind extends AtomicPortableImportKind>(
  input: Readonly<{
    owner: ImportOwnerScope;
    kind: Kind;
    destination: AtomicPortableImportDestinationByKind[Kind];
    contentFingerprint: ValidatedPortableContentFingerprint;
    stagedInput: PortableStagedInput;
    payload: unknown;
  }>,
): ValidatedAtomicRepreviewPayload<Kind> {
  requireOwner(input.owner);
  requireKindDestination(input.kind, input.destination);
  const payload = parseAtomicPayload(input.kind, input.destination, input.payload);
  const replayKey = deriveAtomicReplayKey(
    input.owner,
    input.kind,
    input.destination,
    input.contentFingerprint,
  );
  return {
    owner: input.owner,
    kind: input.kind,
    destination: input.destination,
    contentFingerprint: input.contentFingerprint,
    stagedInput: input.stagedInput,
    replayKey,
    payload
  } as ValidatedAtomicRepreviewPayload<Kind>;
}

/** Adapter-private constructor for the durable staged-input identity. */
export function bindOwnerBoundPortableStagedInput<Kind extends AtomicPortableImportKind>(
  input: Readonly<{
    owner: ImportOwnerScope;
    kind: Kind;
    destination: AtomicPortableImportDestinationByKind[Kind];
    contentFingerprint: ValidatedPortableContentFingerprint;
    stagedInput: PortableStagedInput;
  }>,
): OwnerBoundPortableStagedInput<Kind> {
  requireOwner(input.owner);
  requireKindDestination(input.kind, input.destination);
  return { ...input } as OwnerBoundPortableStagedInput<Kind>;
}

function ownersMatch(left: ImportOwnerScope, right: ImportOwnerScope): boolean {
  return left.ownerUserId === right.ownerUserId;
}

function assertAtomicRequestCorrelation(
  request: AtomicRepreviewCommitIngressRequest<AtomicPortableImportKind>,
): void {
  const validated = request.validatedPayload;
  const staged = request.stagedInput;
  if (!ownersMatch(request.owner, validated.owner) || !ownersMatch(request.owner, staged.owner)) {
    throw new Error("portable_atomic_owner_mismatch");
  }
  if (request.kind !== validated.kind || request.kind !== staged.kind) {
    throw new Error("portable_atomic_kind_mismatch");
  }
  if (!destinationMatches(request.destination, validated.destination)
    || !destinationMatches(request.destination, staged.destination)) {
    throw new Error("portable_atomic_destination_mismatch");
  }
  if (validated.contentFingerprint !== staged.contentFingerprint
    || validated.stagedInput !== staged.stagedInput
    || staged.stagedInput.trim().length === 0) {
    throw new Error("portable_atomic_staged_input_mismatch");
  }
  const expectedReplayKey = deriveAtomicReplayKey(
    request.owner,
    request.kind,
    request.destination,
    validated.contentFingerprint,
  );
  if (validated.replayKey !== expectedReplayKey) {
    throw new Error("portable_atomic_replay_key_mismatch");
  }
}

/**
 * Freezes the source-compatible commit bridge. Campaign ZIP already carries a
 * server-issued durable handle. Existing handle-less bodies are staged,
 * re-previewed, and committed within one caller-owned transaction using a
 * server-stable replay key. Neither replay key can grant authority.
 */
export function bindPortableImportCommitIngress<Destination extends PortablePreviewDestination>(
  request: PortableImportCommitIngressRequest<Destination>,
): PortableImportCommitIngress<Destination>;
export function bindPortableImportCommitIngress<Destination extends PortablePreviewDestination>(
  request: PortableImportCommitIngressRequest<Destination>,
): PortableImportCommitIngress<Destination> {
  requireOwner(request.owner);
  requireKindDestination(request.kind, request.destination);

  if (request.kind === "campaign_zip") {
    const campaignRequest = request as unknown as CampaignZipCommitIngressRequest<CampaignZipPreviewDestination>;
    if (campaignRequest.previewHandle === undefined) throw new Error("portable_preview_handle_required");
    if (!destinationMatches(campaignRequest.destination, campaignRequest.previewHandle.destination)) {
      throw new Error("portable_preview_destination_mismatch");
    }
    const compatibilityKey = toPortableImportIdempotencyKey(campaignRequest.serverStableReplayKey);
    const idempotency = campaignRequest.idempotencyHeader === undefined
      ? { source: "server_stable_compatibility" as const, key: compatibilityKey }
      : {
        source: "idempotency_header" as const,
        key: toPortableImportIdempotencyKey(campaignRequest.idempotencyHeader)
      };
    return {
      owner: campaignRequest.owner,
      kind: campaignRequest.kind,
      destination: campaignRequest.destination,
      idempotency,
      choreography: {
        kind: "durable_preview",
        previewHandle: campaignRequest.previewHandle
      }
    } as unknown as PortableImportCommitIngress<Destination>;
  }

  const atomicRequest = request as AtomicRepreviewCommitIngressRequest<AtomicPortableImportKind>;
  if ((atomicRequest as { previewHandle?: unknown }).previewHandle !== undefined) {
    throw new Error("portable_preview_handle_unexpected");
  }
  assertAtomicRequestCorrelation(atomicRequest);
  const replayKey = atomicRequest.validatedPayload.replayKey;
  const idempotency = atomicRequest.idempotencyHeader === undefined
    ? {
      source: "server_stable_compatibility" as const,
      key: toPortableImportIdempotencyKey(replayKey)
    }
    : {
      source: "idempotency_header" as const,
      key: toPortableImportIdempotencyKey(atomicRequest.idempotencyHeader)
    };
  return {
    owner: atomicRequest.owner,
    kind: atomicRequest.kind,
    destination: atomicRequest.destination,
    idempotency,
    choreography: {
      kind: "atomic_repreview",
      transactionBoundary: "preview_and_commit",
      replayKey,
      validatedPayload: atomicRequest.validatedPayload,
      stagedInput: atomicRequest.stagedInput
    }
  } as PortableImportCommitIngress<Destination>;
}

/**
 * Runs re-preview, domain mutation, and portable consume/complete through one
 * explicit caller-owned transaction context. The core must not open or obtain
 * another transaction.
 */
export async function executeAtomicPortableImportCommit<
  Destination extends PortablePreviewDestination,
  Result,
>(
  ingress: PortableImportCommitIngress<Destination>,
  transactionRunner: CallerOwnedImportTransactionRunner,
  core: AtomicPortableImportCore<Result>,
): Promise<Result> {
  if (ingress.choreography.kind !== "atomic_repreview") {
    throw new Error("portable_atomic_choreography_required");
  }
  const validated = ingress.choreography.validatedPayload;
  const staged = ingress.choreography.stagedInput;
  assertAtomicRequestCorrelation({
    owner: ingress.owner,
    kind: ingress.kind,
    destination: ingress.destination,
    validatedPayload: validated,
    stagedInput: staged
  } as AtomicRepreviewCommitIngressRequest<AtomicPortableImportKind>);
  if (ingress.choreography.replayKey !== validated.replayKey) {
    throw new Error("portable_atomic_replay_key_mismatch");
  }
  if (ingress.idempotency.source === "server_stable_compatibility"
    && ingress.idempotency.key !== toPortableImportIdempotencyKey(validated.replayKey)) {
    throw new Error("portable_atomic_replay_key_mismatch");
  }

  return transactionRunner.run((transaction) => core(transaction, {
    owner: validated.owner,
    kind: validated.kind,
    destination: validated.destination,
    payload: validated.payload,
    stagedInput: staged.stagedInput,
    contentFingerprint: validated.contentFingerprint,
    replayKey: validated.replayKey,
    idempotencyKey: ingress.idempotency.key
  }));
}

export function mapCampaignArchivePreviewHttpResult(
  view: Readonly<{
    projection: PortableImportPreviewProjectionByKind["campaign_zip"];
    previewHandle: Readonly<{ token: string }>;
    expiresAt: string;
  }>,
): CampaignArchivePreviewResponse {
  const projection = view.projection;
  return campaignArchivePreviewResponseSchema.parse({
    valid: projection.valid,
    archiveType: projection.archiveType,
    formatVersion: projection.formatVersion,
    contentFingerprint: projection.contentFingerprint,
    campaign: {
      title: projection.campaign.title,
      sourceCampaignId: projection.campaign.sourceCampaignId,
      acceptedTurnCount: projection.campaign.acceptedTurnCount,
      activeTurnNumber: projection.campaign.activeTurnNumber,
      selectedCharacter: projection.campaign.selectedCharacter === null
        ? null
        : {
          id: projection.campaign.selectedCharacter.id,
          name: projection.campaign.selectedCharacter.name
        }
    },
    world: {
      title: projection.world.title,
      sourceWorldId: projection.world.sourceWorldId,
      sourceWorldVersionId: projection.world.sourceWorldVersionId,
      versionNumber: projection.world.versionNumber
    },
    chronicle: {
      memoryCount: projection.chronicle.memoryCount,
      summaryCount: projection.chronicle.summaryCount
    },
    assets: {
      originalCount: projection.assets.originalCount,
      totalBytes: projection.assets.totalBytes
    },
    destination: projection.destination.kind === "embedded"
      ? {
        kind: projection.destination.kind,
        operation: projection.destination.operation,
        worldId: projection.destination.worldId,
        worldVersionId: projection.destination.worldVersionId
      }
      : {
        kind: projection.destination.kind,
        operation: projection.destination.operation,
        worldId: projection.destination.worldId,
        worldVersionId: projection.destination.worldVersionId
      },
    providerDataIncluded: projection.providerDataIncluded,
    warnings: [...projection.warnings],
    previewToken: view.previewHandle.token,
    expiresAt: view.expiresAt
  });
}

type HandlelessPortableImportKind = Exclude<PortableImportKind, "campaign_zip">;

function mapLegacyStoryPreview(projection: LegacyStoryPreviewProjection): LegacyStoryPreviewProjection {
  return {
    kind: projection.kind,
    title: projection.title,
    duplicate: projection.duplicate,
    existingCampaignId: projection.existingCampaignId,
    valid: projection.valid,
    counts: {
      turns: projection.counts.turns,
      completeHistoryCharacters: projection.counts.completeHistoryCharacters,
      estimatedHistoryTokens: projection.counts.estimatedHistoryTokens
    },
    warnings: [...projection.warnings]
  };
}

function mapWorldJsonPreview(
  projection: InfiniteWorldsJsonPreviewProjection,
): InfiniteWorldsJsonPreviewProjection {
  const common = {
    kind: projection.kind,
    valid: projection.valid,
    duplicate: projection.duplicate,
    existingWorldId: projection.existingWorldId,
    characters: projection.characters.map((character) => ({
      index: character.index,
      name: character.name
    })),
    counts: {
      entities: projection.counts.entities,
      relationships: projection.counts.relationships,
      triggers: projection.counts.triggers
    },
    warnings: [...projection.warnings]
  };
  return projection.valid
    ? { ...common, valid: true, title: projection.title }
    : { ...common, valid: false, duplicate: false, existingWorldId: null };
}

function mapCyoaPreview(projection: CyoaPreviewProjection): CyoaPreviewProjection {
  return {
    kind: projection.kind,
    valid: projection.valid,
    requiresProvider: projection.requiresProvider,
    warnings: [...projection.warnings],
    counts: {
      topLevelTitle: projection.counts.topLevelTitle,
      layer1ChaptersCount: projection.counts.layer1ChaptersCount,
      characterTarget: projection.counts.characterTarget
    }
  };
}

function mapWorldTextPreview(projection: WorldTextPreviewProjection): WorldTextPreviewProjection {
  return {
    kind: projection.kind,
    valid: projection.valid,
    requiresProvider: projection.requiresProvider,
    warnings: [...projection.warnings],
    counts: {
      sourceCharacters: projection.counts.sourceCharacters,
      sourceWords: projection.counts.sourceWords
    }
  };
}

function mapStoryTextPreview(projection: StoryTextPreviewProjection): StoryTextPreviewProjection {
  if ("title" in projection) {
    const mapped = {
      kind: projection.kind,
      title: projection.title,
      duplicate: projection.duplicate,
      existingCampaignId: projection.existingCampaignId,
      targetWorldId: projection.targetWorldId,
      diagnostics: [...projection.diagnostics],
      characters: projection.characters.map((character) => ({ id: character.id, name: character.name })),
      selectedCharacterId: projection.selectedCharacterId,
      counts: {
        turns: projection.counts.turns,
        completeHistoryCharacters: projection.counts.completeHistoryCharacters,
        estimatedHistoryTokens: projection.counts.estimatedHistoryTokens
      },
      warnings: [...projection.warnings]
    };
    return projection.valid
      ? { ...mapped, valid: true }
      : { ...mapped, valid: false };
  }
  if ("targetWorldId" in projection) {
    return {
      kind: projection.kind,
      targetWorldId: projection.targetWorldId,
      diagnostics: [...projection.diagnostics],
      characters: projection.characters.map((character) => ({ id: character.id, name: character.name })),
      selectedCharacterId: null,
      valid: false,
      counts: { turns: projection.counts.turns },
      warnings: [...projection.warnings]
    };
  }
  return {
    kind: projection.kind,
    valid: false,
    counts: { turns: projection.counts.turns },
    warnings: [...projection.warnings]
  };
}

export function mapHandlelessPortablePreviewHttpResult<Kind extends HandlelessPortableImportKind>(
  kind: Kind,
  view: Readonly<{ projection: PortableImportPreviewProjectionFor<Kind> }>,
): PortableImportPreviewProjectionFor<Kind> {
  const projection = view.projection;
  switch (kind) {
    case "legacy_story":
      return mapLegacyStoryPreview(projection as LegacyStoryPreviewProjection) as PortableImportPreviewProjectionFor<Kind>;
    case "infinite_worlds":
    case "world_json":
      return mapWorldJsonPreview(projection as InfiniteWorldsJsonPreviewProjection) as PortableImportPreviewProjectionFor<Kind>;
    case "cyoa":
      return mapCyoaPreview(projection as CyoaPreviewProjection) as PortableImportPreviewProjectionFor<Kind>;
    case "world_text":
      return mapWorldTextPreview(projection as WorldTextPreviewProjection) as PortableImportPreviewProjectionFor<Kind>;
    case "story_text":
      return mapStoryTextPreview(projection as StoryTextPreviewProjection) as PortableImportPreviewProjectionFor<Kind>;
  }
}

export function mapPortableImportCommitHttpResult<Kind extends PortableImportKind>(
  view: PortableImportCommitView<Kind>,
): Readonly<{ statusCode: 200 | 201; body: PortableImportCommitView<Kind>["result"] }> {
  const result = view.result;
  let body: PortableImportResultProjectionFor<Kind>;
  switch (view.kind) {
    case "campaign_zip": {
      const campaign = result as CampaignArchiveImportResultProjection;
      body = {
        importId: campaign.importId,
        worldId: campaign.worldId,
        worldVersionId: campaign.worldVersionId,
        campaignId: campaign.campaignId,
        duplicate: campaign.duplicate,
        stats: {
          turnCount: campaign.stats.turnCount,
          memoryCount: campaign.stats.memoryCount,
          summaryCount: campaign.stats.summaryCount,
          assetCount: campaign.stats.assetCount,
          assetBytes: campaign.stats.assetBytes
        }
      } as PortableImportResultProjectionFor<Kind>;
      break;
    }
    case "legacy_story": {
      const story = result as LegacyStoryImportResultProjection;
      body = mapLegacyStoryCommitResult(story) as PortableImportResultProjectionFor<Kind>;
      break;
    }
    case "story_text": {
      const story = result as PortableStoryImportResultProjection;
      body = {
        kind: story.kind,
        ...mapLegacyStoryCommitResult(story)
      } as PortableImportResultProjectionFor<Kind>;
      break;
    }
    case "infinite_worlds":
    case "cyoa":
    case "world_json":
    case "world_text": {
      const world = result as PortableWorldImportResultProjection;
      body = {
        kind: world.kind,
        importId: world.importId,
        worldId: world.worldId,
        worldVersionId: world.worldVersionId,
        duplicate: world.duplicate
      } as PortableImportResultProjectionFor<Kind>;
      break;
    }
  }
  return {
    statusCode: view.duplicate ? 200 : 201,
    body
  };
}

function mapLegacyStoryCommitResult(
  result: LegacyStoryImportResultProjection,
): LegacyStoryImportResultProjection {
  return {
    importId: result.importId,
    worldId: result.worldId,
    worldVersionId: result.worldVersionId,
    campaignId: result.campaignId,
    duplicate: result.duplicate,
    stats: {
      turnCount: result.stats.turnCount,
      memoryCount: result.stats.memoryCount,
      completeHistoryCharacters: result.stats.completeHistoryCharacters,
      estimatedHistoryTokens: result.stats.estimatedHistoryTokens,
      importedSummary: result.stats.importedSummary,
      sanitizedMemoryCount: result.stats.sanitizedMemoryCount
    }
  };
}

export function bindImportProgressLookup(owner: ImportOwnerScope, key: string): ImportProgressLookup {
  requireOwner(owner);
  const parsed = importProgressQuerySchema.parse({ key });
  return {
    owner,
    key: parsed.key,
    disposition: "owner_scoped_bounded_status",
    authority: "none"
  };
}

export function parseImportProgressProjection(value: unknown): ImportProgressReport {
  return importProgressResponseSchema.parse(value);
}

export function mapImportProgressHttpResult(
  value: ImportProgressReport | null,
): ImportProgressHttpResult {
  if (value === null) {
    return {
      statusCode: 404,
      body: { error: "No active import found for the provided key." }
    };
  }
  return { statusCode: 200, body: parseImportProgressProjection(value) };
}
