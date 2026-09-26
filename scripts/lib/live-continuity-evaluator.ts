import { createHash } from "node:crypto";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { storyTurnOutputSchema } from "../../packages/contracts/src/story-prompt.js";
import { joinProviderNarration } from "../../packages/story-engine/src/narration-paragraphs.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import type { ProviderRequest } from "../../packages/story-engine/src/providers.js";
import { executeCappedLiveEvaluation, type LiveConfiguration } from "./story-continuity-evaluator.js";

export type LiveReplaySource = Readonly<{
  campaignId: string; sourceCampaignId: string; providerId: string; providerModel: string;
  requestBody: string; requestPayloadHash: string;
}>;

/** Replays a saved copied-campaign request privately; never accepts output or mutates story state. */
export async function evaluateLiveCopiedRequest(
  configuration: LiveConfiguration,
  source: LiveReplaySource,
  provider: RuntimeTextExecution,
  price: Readonly<{ inputUsdPerMillion: number; outputUsdPerMillion: number }>
) {
  if (source.campaignId !== configuration.copiedCampaignId || source.sourceCampaignId !== configuration.sourceCampaignId
    || source.campaignId === source.sourceCampaignId || source.providerId !== configuration.providerId
    || provider.id !== configuration.providerId || provider.model !== configuration.providerModel || source.providerModel !== provider.model) throw new Error("Live source, copied campaign and pinned provider do not match.");
  if (Object.values(price).some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Explicit finite provider prices are required.");
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  if (hash(source.requestBody) !== source.requestPayloadHash) throw new Error("Saved request hash is invalid.");
  const body = JSON.parse(source.requestBody);
  // Only complete self-contained main requests are replayable. A chain,
  // streaming request or recovery exchange must get a new copy fixture.
  if (body.previous_response_id || body.stream || (body.messages && (body.messages.length !== 2
    || body.messages[0]?.role !== "system" || body.messages[1]?.role !== "user"))) throw new Error("Live replay requires a self-contained non-streaming main request.");
  const request: ProviderRequest = { systemPrompt: body.system_prompt ?? body.messages?.[0]?.content,
    input: body.input ?? body.messages?.[1]?.content, canonicalBudgeting: true, responseFormatFallback: "forbid" };
  if (typeof request.systemPrompt !== "string" || typeof request.input !== "string") throw new Error("Saved request is not a supported text request.");
  const prepared = serializeProviderRequest({ ...provider, baseUrl: "" }, request);
  if (prepared.body !== source.requestBody) throw new Error("Provider settings or wire format changed since the copied request was captured.");
  // UTF-8 bytes conservatively bound byte-tokenizer input; output is the pinned
  // hard provider reserve. No retry/fallback may create an unreserved call.
  const reserve = { inputTokens: Buffer.byteLength(prepared.body, "utf8"), outputTokens: provider.maxOutputTokens,
    costUsd: (Buffer.byteLength(prepared.body, "utf8") * price.inputUsdPerMillion + provider.maxOutputTokens * price.outputUsdPerMillion) / 1_000_000 };
  const outputs: Array<{ content: string; status: "valid" | "invalid" | "unavailable"; latencyMs: number }> = [];
  const usage = await executeCappedLiveEvaluation(configuration, async () => {
    const started = performance.now();
    let result: Awaited<ReturnType<RuntimeTextExecution["execute"]>>;
    try { result = await provider.execute(request); }
    catch {
      outputs.push({ content: "", status: "unavailable", latencyMs: performance.now() - started });
      return reserve;
    }
    // A transport failure is a charged attempt. A violated dispatch contract is
    // different: stop the entire run before allowing any further calls.
    if (result.preparedRequest?.payloadHash !== prepared.payloadHash) throw new Error("Live request differs from its reserved body.");
    const reportedUsd = result.reportedCost?.currency === "USD" ? Number(result.reportedCost.amount) : 0;
    if ((result.usage.inputTokens ?? 0) > reserve.inputTokens || (result.usage.outputTokens ?? 0) > reserve.outputTokens
      || !Number.isFinite(reportedUsd) || reportedUsd < 0 || reportedUsd > reserve.costUsd)
      throw new Error("Live transport exceeded its pre-dispatch reservation; evaluation stopped.");
    let valid = false;
    try {
      // A replayed story-native-v3 capture arrives as an unmerged
      // narration_paragraphs array; join it before schema validation so a
      // valid v3 sample is not misreported as a schema failure.
      const joined = joinProviderNarration(JSON.parse(result.content));
      valid = !result.outputLimited && joined.ok && storyTurnOutputSchema.safeParse(joined.value).success;
    } catch { /* Invalid output remains an attempted sample. */ }
    outputs.push({ content: result.content, status: valid ? "valid" : "invalid", latencyMs: performance.now() - started });
    return reserve;
  }, () => reserve);
  return { outputs, report: { version: "story-continuity-live-replay-v1", scenarioVersion: configuration.scenarioVersion,
    sourceCampaignId: source.sourceCampaignId, copiedCampaignId: source.campaignId, providerId: provider.id, model: provider.model,
    settingsHash: hash(JSON.stringify({ providerType: provider.providerType, model: provider.model, contextWindowTokens: provider.contextWindowTokens,
      maxOutputTokens: provider.maxOutputTokens, temperature: provider.temperature, configuration: provider.configuration })),
    requestHash: prepared.payloadHash, reservedUsage: usage, attempts: outputs.length,
    valid: outputs.filter((output) => output.status === "valid").length, invalid: outputs.filter((output) => output.status === "invalid").length,
    unavailable: outputs.filter((output) => output.status === "unavailable").length,
    adjudication: "pending_blinded_review", acceptedStateMutation: false } };
}
