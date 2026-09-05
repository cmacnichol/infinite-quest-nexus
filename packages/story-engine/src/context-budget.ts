export type ContextBudgetBlock = Readonly<{
  id: string;
  revision: string;
  content: string;
  protected: boolean;
  priority: number;
  ordinal: number;
  scope?: string;
}>;

export type ContextBudgetOmission = Readonly<{
  id: string;
  revision: string;
  reason: "context_limit" | "request_limit";
}>;

export type ContextBudgetErrorCode = "context_budget_invalid" | "context_budget_exceeded" | "continuity_output_budget_exceeded" | "extension_narration_limit_exceeded";

export class ContextBudgetError extends Error {
  readonly code: ContextBudgetErrorCode;
  readonly requiredTokens: number;
  readonly availableTokens: number;
  readonly requiredCharacters?: number;
  readonly availableCharacters?: number;
  readonly scope?: "campaign_context" | "provider_request" | "output_skeleton" | "extension_narration";
  readonly protectedBlockIds: readonly string[];

  constructor(
    code: ContextBudgetErrorCode,
    requiredTokens: number,
    availableTokens: number,
    characters?: Readonly<{ required: number; available: number }>,
    details?: Readonly<{ scope?: "campaign_context" | "provider_request" | "output_skeleton" | "extension_narration"; protectedBlockIds?: readonly string[] }>
  ) {
    super(`${code}: requires ${requiredTokens} tokens but only ${availableTokens} are available.`);
    this.name = "ContextBudgetError";
    this.code = code;
    this.requiredTokens = requiredTokens;
    this.availableTokens = availableTokens;
    if (characters) {
      this.requiredCharacters = characters.required;
      this.availableCharacters = characters.available;
    }
    if (details?.scope) this.scope = details.scope;
    this.protectedBlockIds = Object.freeze([...(details?.protectedBlockIds ?? [])]);
  }
}

export type ContextPlanOptions<TContext = readonly ContextBudgetBlock[]> = Readonly<{
  blocks: readonly ContextBudgetBlock[];
  contextLimit: number;
  inputLimit: number;
  count: (serialized: string) => number;
  serializeContext: (blocks: readonly ContextBudgetBlock[]) => string;
  serializeRequest: (context: TContext) => string;
  safetyAllowanceTokens?: number;
  contextValue?: (blocks: readonly ContextBudgetBlock[]) => TContext;
  protectedScope?: "campaign_context" | "provider_request";
}>;

export type ContextPlan = Readonly<{
  selected: readonly ContextBudgetBlock[];
  omitted: readonly ContextBudgetOmission[];
  serializedContext: string;
  serializedRequest: string;
  contextTokens: number;
  requestTokens: number;
  safetyAllowanceTokens: number;
}>;

function assertLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new ContextBudgetError("context_budget_invalid", 0, 0);
  if (!name) throw new ContextBudgetError("context_budget_invalid", 0, 0);
}

function contextOrder(left: ContextBudgetBlock, right: ContextBudgetBlock): number {
  return (left.scope ?? "").localeCompare(right.scope ?? "")
    || left.ordinal - right.ordinal
    || left.id.localeCompare(right.id)
    || left.revision.localeCompare(right.revision);
}

function packingOrder(left: ContextBudgetBlock, right: ContextBudgetBlock): number {
  return left.priority - right.priority || contextOrder(left, right);
}

function uniqueBlocks(blocks: readonly ContextBudgetBlock[]): ContextBudgetBlock[] {
  const unique = new Map<string, ContextBudgetBlock>();
  for (const block of blocks) {
    if (!block.id || !block.revision || !Number.isFinite(block.priority) || !Number.isFinite(block.ordinal)) {
      throw new ContextBudgetError("context_budget_invalid", 0, 0);
    }
    const key = `${block.id}\u0000${block.revision}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, block);
    } else if (existing.content !== block.content
      || existing.protected !== block.protected
      || existing.priority !== block.priority
      || existing.ordinal !== block.ordinal
      || existing.scope !== block.scope) {
      throw new ContextBudgetError("context_budget_invalid", 0, 0);
    }
  }
  return [...unique.values()];
}

function measured<TContext>(
  selected: readonly ContextBudgetBlock[],
  options: ContextPlanOptions<TContext>
): Readonly<{ serializedContext: string; serializedRequest: string; contextTokens: number; requestTokens: number }> {
  const ordered = [...selected].sort(contextOrder);
  const serializedContext = options.serializeContext(ordered);
  const contextValue = options.contextValue ? options.contextValue(ordered) : ordered as TContext;
  const serializedRequest = options.serializeRequest(contextValue);
  const contextTokens = options.count(serializedContext);
  const requestTokens = options.count(serializedRequest);
  if (!Number.isFinite(contextTokens) || !Number.isFinite(requestTokens) || contextTokens < 0 || requestTokens < 0) {
    throw new ContextBudgetError("context_budget_invalid", 0, 0);
  }
  return { serializedContext, serializedRequest, contextTokens, requestTokens };
}

/** Plans whole context records without truncating protected state or padding sparse input. */
export function planContext<TContext = readonly ContextBudgetBlock[]>(options: ContextPlanOptions<TContext>): ContextPlan {
  assertLimit(options.contextLimit, "contextLimit");
  assertLimit(options.inputLimit, "inputLimit");
  const safetyAllowanceTokens = options.safetyAllowanceTokens ?? 0;
  assertLimit(safetyAllowanceTokens, "safetyAllowanceTokens");
  const blocks = uniqueBlocks(options.blocks);
  const protectedBlocks = blocks.filter((block) => block.protected).sort(contextOrder);
  let selected = protectedBlocks;
  let current = measured(selected, options);
  if (current.contextTokens + safetyAllowanceTokens > options.contextLimit) {
    throw new ContextBudgetError("context_budget_exceeded", current.contextTokens + safetyAllowanceTokens, options.contextLimit, undefined, {
      scope: options.protectedScope ?? "campaign_context",
      protectedBlockIds: protectedBlocks.map((block) => block.id)
    });
  }
  if (current.requestTokens + safetyAllowanceTokens > options.inputLimit) {
    throw new ContextBudgetError("context_budget_exceeded", current.requestTokens + safetyAllowanceTokens, options.inputLimit, undefined, {
      scope: "provider_request",
      protectedBlockIds: protectedBlocks.map((block) => block.id)
    });
  }

  const omitted: ContextBudgetOmission[] = [];
  for (const candidate of blocks.filter((block) => !block.protected).sort(packingOrder)) {
    const trial = measured([...selected, candidate], options);
    if (trial.contextTokens + safetyAllowanceTokens > options.contextLimit) {
      omitted.push({ id: candidate.id, revision: candidate.revision, reason: "context_limit" });
      continue;
    }
    if (trial.requestTokens + safetyAllowanceTokens > options.inputLimit) {
      omitted.push({ id: candidate.id, revision: candidate.revision, reason: "request_limit" });
      continue;
    }
    selected = [...selected, candidate].sort(contextOrder);
    current = trial;
  }
  return Object.freeze({
    selected: Object.freeze([...selected]),
    omitted: Object.freeze(omitted.map((item) => Object.freeze(item))),
    ...current,
    safetyAllowanceTokens
  });
}

export type OutputFeasibilityOptions = Readonly<{
  inputTokens: number;
  contextWindowTokens: number;
  outputReserveTokens: number;
  count: (serialized: string) => number;
  serializeOutput: (output: unknown) => string;
  output: unknown;
  safetyAllowanceTokens?: number;
  extension?: Readonly<{
    preservedNarration: string;
    appendedNarration: string;
    narrationCharacterLimit: number;
  }>;
}>;

export type OutputFeasibility = Readonly<{
  outputTokens: number;
  totalTokens: number;
  narrationCharacters: number | null;
}>;

/** Checks the minimum complete output before any provider transport begins. */
export function assertOutputFeasible(options: OutputFeasibilityOptions): OutputFeasibility {
  assertLimit(options.inputTokens, "inputTokens");
  assertLimit(options.contextWindowTokens, "contextWindowTokens");
  assertLimit(options.outputReserveTokens, "outputReserveTokens");
  const safetyAllowanceTokens = options.safetyAllowanceTokens ?? 0;
  assertLimit(safetyAllowanceTokens, "safetyAllowanceTokens");
  const outputTokens = options.count(options.serializeOutput(options.output));
  if (!Number.isFinite(outputTokens) || outputTokens < 0) throw new ContextBudgetError("context_budget_invalid", 0, 0);
  const totalTokens = options.inputTokens + options.outputReserveTokens + safetyAllowanceTokens;
  if (totalTokens > options.contextWindowTokens) {
    throw new ContextBudgetError("context_budget_exceeded", totalTokens, options.contextWindowTokens, undefined, { scope: "provider_request" });
  }
  if (outputTokens + safetyAllowanceTokens > options.outputReserveTokens) {
    throw new ContextBudgetError("continuity_output_budget_exceeded", outputTokens + safetyAllowanceTokens, options.outputReserveTokens, undefined, { scope: "output_skeleton" });
  }
  if (options.extension) {
    assertLimit(options.extension.narrationCharacterLimit, "narrationCharacterLimit");
    const narrationCharacters = options.extension.preservedNarration.length + options.extension.appendedNarration.length;
    if (narrationCharacters > options.extension.narrationCharacterLimit) {
      throw new ContextBudgetError(
        "extension_narration_limit_exceeded",
        totalTokens,
        options.contextWindowTokens,
        { required: narrationCharacters, available: options.extension.narrationCharacterLimit },
        { scope: "extension_narration" }
      );
    }
    return Object.freeze({ outputTokens, totalTokens, narrationCharacters });
  }
  return Object.freeze({ outputTokens, totalTokens, narrationCharacters: null });
}
